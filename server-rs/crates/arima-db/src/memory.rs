// SPDX-License-Identifier: AGPL-3.0-or-later

//! SQLite FTS5 Team Memory repository, contradiction detection, 30-day decay pruning,
//! template lesson promotion, and encrypted `vault_secrets` storage.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{Db, DbError, Result};

const DAY_MS: i64 = 86_400_000;
pub const DEFAULT_UNCERTIFIED_DECAY_DAYS: i64 = 30;

/// Extraction toggle and configured account persisted in `projects.config_json["memorySettings"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExtractionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_extraction_account")]
    pub account: String,
}

fn default_extraction_account() -> String {
    "default".to_owned()
}

impl Default for MemoryExtractionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            account: default_extraction_account(),
        }
    }
}

/// Project-scoped Team Memory configuration.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySettings {
    #[serde(default)]
    pub extraction: MemoryExtractionConfig,
    #[serde(default)]
    pub keep_out: Vec<String>,
}

/// One memory item persisted in `memories` + `memory_about` + `memory_fts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub project_id: String,
    pub mem_type: String,
    pub text: String,
    pub about: Vec<String>,
    pub certified: bool,
    pub conflict_id: Option<String>,
    pub promoted: bool,
    pub superseded_by: Option<String>,
    pub days_until_decay: Option<i64>,
    pub created_at: String,
    pub last_used_at: String,
}

/// Input for inserting a candidate or certified memory item.
#[derive(Debug, Clone)]
pub struct CreateMemoryInput {
    pub id: Option<String>,
    pub mem_type: String,
    pub text: String,
    pub about: Vec<String>,
    pub certified: bool,
    pub created_at_ms: Option<i64>,
    pub last_used_at_ms: Option<i64>,
}

/// One promoted lesson offered to a project template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotedLesson {
    pub id: String,
    pub project_id: String,
    pub source_memory_id: Option<String>,
    pub template_id: String,
    pub mem_type: String,
    pub text: String,
    pub created_at: String,
}

/// Metadata (never plaintext secret!) for an entry in `vault_secrets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSecretMeta {
    pub id: String,
    pub scope: String,
    pub provider: String,
    pub label: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Encrypted secret row loaded internally by `arima-server` for decryption via `VaultKey`.
#[derive(Debug, Clone)]
pub struct VaultSecretRecord {
    pub id: String,
    pub scope: String,
    pub provider: String,
    pub label: String,
    pub secret_enc: String,
}

/// Status filter when querying Team Memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryStatusFilter {
    All,
    Certified,
    Pending,
}

impl MemoryStatusFilter {
    #[must_use]
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("certified") => Self::Certified,
            Some("pending" | "uncertified" | "pending-review") => Self::Pending,
            _ => Self::All,
        }
    }
}

/// Sanitizes an arbitrary user search string into a safe SQLite FTS5 `MATCH` query.
///
/// Strips all FTS5 operator/punctuation characters (`"`, `'`, `:`, `*`, `^`, `(`, `)`, `+`, `-`,
/// etc.) and wraps each alphanumeric token in quotes with a prefix wildcard (`"tok"*`) so user
/// punctuation can NEVER trigger an FTS5 syntax error.
#[must_use]
pub fn sanitize_fts5_query(raw: &str) -> Option<String> {
    let mut terms = Vec::new();
    let mut current = String::new();

    for ch in raw.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            terms.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }

    if terms.is_empty() {
        return None;
    }

    let safe_terms: Vec<String> = terms
        .into_iter()
        .take(16)
        .map(|tok| format!("\"{}\"*", tok.replace('"', "")))
        .collect();
    Some(safe_terms.join(" "))
}

/// Scrubs emails, phone numbers, obvious secret tokens, and project `keep_out` terms from text.
#[must_use]
pub fn scrub_sensitive_and_keep_out(text: &str, keep_out: &[String]) -> String {
    let mut out = text.to_owned();

    // Case-insensitive keep_out replacement.
    for term in keep_out {
        let needle = term.trim();
        if needle.len() < 2 {
            continue;
        }
        out = replace_case_insensitive(&out, needle, "[redacted]");
    }

    // Strip email-like tokens and bearer/API key tokens cleanly.
    let mut cleaned_words = Vec::new();
    for word in out.split_whitespace() {
        let lower = word.to_ascii_lowercase();
        let looks_like_email = word.contains('@')
            && word
                .split_once('@')
                .is_some_and(|(u, d)| !u.is_empty() && d.contains('.'));
        let looks_like_secret = lower.starts_with("sk-")
            || lower.starts_with("ghp_")
            || lower.starts_with("gho_")
            || lower.starts_with("aiza")
            || lower.starts_with("xoxb-");
        let digit_count = word.chars().filter(char::is_ascii_digit).count();
        let looks_like_phone = digit_count >= 10
            && word
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '(' | ')' | '.'));

        if looks_like_email || looks_like_secret || looks_like_phone {
            cleaned_words.push("[redacted]");
        } else {
            cleaned_words.push(word);
        }
    }
    cleaned_words.join(" ")
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    let lower_hay = haystack.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    if lower_needle.is_empty() || lower_hay.len() != haystack.len() {
        return haystack.replace(needle, replacement);
    }
    let mut out = String::with_capacity(haystack.len());
    let mut cursor = 0usize;
    while let Some(rel) = lower_hay[cursor..].find(&lower_needle) {
        let start = cursor + rel;
        out.push_str(&haystack[cursor..start]);
        out.push_str(replacement);
        cursor = start + lower_needle.len();
    }
    out.push_str(&haystack[cursor..]);
    out
}

fn format_ts_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn normalize_mem_type(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "decision" => "Decision".into(),
        "deadend" | "dead-end" | "dead_end" => "DeadEnd".into(),
        _ => "Lesson".into(),
    }
}

fn extract_keywords(text: &str) -> HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| s.len() >= 4)
        .collect()
}

fn has_contradiction_signal(existing_text: &str, candidate_text: &str) -> bool {
    let a = existing_text.trim().to_ascii_lowercase();
    let b = candidate_text.trim().to_ascii_lowercase();
    if a == b {
        return false;
    }
    const CUES: &[&str] = &[
        "never",
        "not ",
        "don't",
        "do not",
        "avoid",
        "instead",
        "replace",
        "switch",
        "migrate",
        "drop ",
        "ban ",
        "disable",
        "remove",
        "must not",
    ];
    let a_neg = CUES.iter().any(|c| a.contains(c));
    let b_neg = CUES.iter().any(|c| b.contains(c));
    // Differing polarity OR explicit replacement cue on the same topic indicates a conflict.
    if a_neg != b_neg || b.contains("instead") || b.contains("replace") || b.contains("switch") {
        return true;
    }
    // Different substantive guidance on the exact same `about` topic.
    let ka = extract_keywords(&a);
    let kb = extract_keywords(&b);
    let shared = ka.intersection(&kb).count();
    let union = ka.union(&kb).count().max(1);
    (shared as f64 / union as f64) < 0.75
}

/// SQLite repository for FTS5 Team Memory (`memories`, `memory_about`, `memory_fts`, `promoted_lessons`).
#[derive(Debug, Clone)]
pub struct MemoryRepo {
    db: Db,
}

impl MemoryRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Inserts a memory item, runs contradiction detection against existing certified memories
    /// sharing `about` topics or `mem_type`, and indexes into `memory_fts`.
    pub fn insert(&self, project_id: &str, input: CreateMemoryInput) -> Result<MemoryRecord> {
        let settings = self.get_settings(project_id).unwrap_or_default();
        let cleaned_text = scrub_sensitive_and_keep_out(input.text.trim(), &settings.keep_out);
        if cleaned_text.trim().is_empty() {
            return Err(DbError::InvalidInput("memory text cannot be empty".into()));
        }

        let mem_type = normalize_mem_type(&input.mem_type);
        let now_ms = Utc::now().timestamp_millis();
        let created_ms = input.created_at_ms.unwrap_or(now_ms);
        let last_used_ms = input.last_used_at_ms.unwrap_or(created_ms);

        let mut about: Vec<String> = input
            .about
            .into_iter()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        about.sort();
        about.dedup();

        let id = input
            .id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("mem-{}", uuid::Uuid::new_v4().simple()));

        self.db.transaction(|conn| {
            let conflict_id = if !input.certified {
                Self::detect_conflict_tx(conn, project_id, &id, &mem_type, &cleaned_text, &about)?
            } else {
                None
            };

            conn.execute(
                "INSERT INTO memories
                    (id, project_id, mem_type, text, certified, created_at, last_used_at,
                     conflict_id, promoted, superseded_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    mem_type = excluded.mem_type,
                    text = excluded.text,
                    certified = excluded.certified,
                    last_used_at = excluded.last_used_at,
                    conflict_id = excluded.conflict_id",
                rusqlite::params![
                    id,
                    project_id,
                    mem_type,
                    cleaned_text,
                    i64::from(input.certified),
                    created_ms,
                    last_used_ms,
                    conflict_id,
                ],
            )?;

            conn.execute(
                "DELETE FROM memory_about WHERE project_id = ?1 AND memory_id = ?2",
                rusqlite::params![project_id, id],
            )?;
            for tag in &about {
                conn.execute(
                    "INSERT OR IGNORE INTO memory_about (project_id, memory_id, about)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![project_id, id, tag],
                )?;
            }

            conn.execute(
                "DELETE FROM memory_fts WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![project_id, id],
            )?;
            conn.execute(
                "INSERT INTO memory_fts (id, project_id, text) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, project_id, cleaned_text],
            )?;

            Ok::<_, DbError>(build_record(
                id,
                project_id.to_owned(),
                mem_type,
                cleaned_text,
                about,
                input.certified,
                conflict_id,
                false,
                None,
                created_ms,
                last_used_ms,
                now_ms,
            ))
        })
    }

    /// Loads a single memory by `(project_id, memory_id)`.
    pub fn get(&self, project_id: &str, memory_id: &str) -> Result<Option<MemoryRecord>> {
        let now_ms = Utc::now().timestamp_millis();
        self.db.read(|conn| {
            let row = conn
                .query_row(
                    "SELECT id, project_id, mem_type, text, certified, created_at, last_used_at,
                            conflict_id, promoted, superseded_by
                     FROM memories
                     WHERE project_id = ?1 AND id = ?2",
                    rusqlite::params![project_id, memory_id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, i64>(4)? != 0,
                            r.get::<_, i64>(5)?,
                            r.get::<_, i64>(6)?,
                            r.get::<_, Option<String>>(7)?,
                            r.get::<_, i64>(8)? != 0,
                            r.get::<_, Option<String>>(9)?,
                        ))
                    },
                )
                .optional()?;
            let Some((id, pid, mem_type, text, certified, created_ms, last_used_ms, conflict_id, promoted, superseded_by)) = row else {
                return Ok(None);
            };
            let about = Self::load_about_tx(conn, &pid, &id)?;
            Ok(Some(build_record(
                id,
                pid,
                mem_type,
                text,
                about,
                certified,
                conflict_id,
                promoted,
                superseded_by,
                created_ms,
                last_used_ms,
                now_ms,
            )))
        })
    }

    /// Searches project memories using sanitized SQLite FTS5 (`memory_fts`) and status filtering.
    pub fn search(
        &self,
        project_id: &str,
        query: Option<&str>,
        status: MemoryStatusFilter,
    ) -> Result<Vec<MemoryRecord>> {
        let now_ms = Utc::now().timestamp_millis();
        let fts_query = query.and_then(sanitize_fts5_query);

        self.db.read(|conn| {
            let mut rows_raw = Vec::new();
            let status_clause = match status {
                MemoryStatusFilter::All => "",
                MemoryStatusFilter::Certified => " AND m.certified = 1",
                MemoryStatusFilter::Pending => " AND m.certified = 0",
            };

            if let Some(ref fts) = fts_query {
                let sql = format!(
                    "SELECT m.id, m.project_id, m.mem_type, m.text, m.certified,
                            m.created_at, m.last_used_at, m.conflict_id, m.promoted, m.superseded_by
                     FROM memory_fts f
                     JOIN memories m ON m.id = f.id AND m.project_id = f.project_id
                     WHERE f.project_id = ?1 AND memory_fts MATCH ?2{status_clause}
                     ORDER BY m.certified DESC, bm25(memory_fts) ASC, m.created_at DESC"
                );
                let mut stmt = conn.prepare(&sql)?;
                let mapped = stmt.query_map(rusqlite::params![project_id, fts], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)? != 0,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, i64>(8)? != 0,
                        r.get::<_, Option<String>>(9)?,
                    ))
                })?;
                for r in mapped {
                    rows_raw.push(r?);
                }
            } else {
                let sql = format!(
                    "SELECT m.id, m.project_id, m.mem_type, m.text, m.certified,
                            m.created_at, m.last_used_at, m.conflict_id, m.promoted, m.superseded_by
                     FROM memories m
                     WHERE m.project_id = ?1{status_clause}
                     ORDER BY m.certified DESC, m.last_used_at DESC, m.id ASC"
                );
                let mut stmt = conn.prepare(&sql)?;
                let mapped = stmt.query_map([project_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)? != 0,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, i64>(8)? != 0,
                        r.get::<_, Option<String>>(9)?,
                    ))
                })?;
                for r in mapped {
                    rows_raw.push(r?);
                }
            }

            let mut out = Vec::with_capacity(rows_raw.len());
            for (
                id,
                pid,
                mem_type,
                text,
                certified,
                created_ms,
                last_used_ms,
                conflict_id,
                promoted,
                superseded_by,
            ) in rows_raw
            {
                let about = Self::load_about_tx(conn, &pid, &id)?;
                out.push(build_record(
                    id,
                    pid,
                    mem_type,
                    text,
                    about,
                    certified,
                    conflict_id,
                    promoted,
                    superseded_by,
                    created_ms,
                    last_used_ms,
                    now_ms,
                ));
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Certifies a memory item. When `supersede_conflict` is `true` and `conflict_id` is set,
    /// marks the conflicting older memory as superseded (`certified = 0, superseded_by = memory_id`).
    pub fn certify(
        &self,
        project_id: &str,
        memory_id: &str,
        supersede_conflict: bool,
    ) -> Result<MemoryRecord> {
        let now_ms = Utc::now().timestamp_millis();
        self.db.transaction(|conn| {
            struct CertifyRow {
                mem_type: String,
                text: String,
                created_ms: i64,
                conflict_id: Option<String>,
                promoted_i: i64,
                superseded_by: Option<String>,
            }
            let existing = conn
                .query_row(
                    "SELECT mem_type, text, created_at, conflict_id, promoted, superseded_by
                     FROM memories
                     WHERE project_id = ?1 AND id = ?2",
                    rusqlite::params![project_id, memory_id],
                    |r| {
                        Ok(CertifyRow {
                            mem_type: r.get(0)?,
                            text: r.get(1)?,
                            created_ms: r.get(2)?,
                            conflict_id: r.get(3)?,
                            promoted_i: r.get(4)?,
                            superseded_by: r.get(5)?,
                        })
                    },
                )
                .optional()?;

            let Some(CertifyRow {
                mem_type,
                text,
                created_ms,
                conflict_id,
                promoted_i,
                superseded_by,
            }) = existing
            else {
                return Err(DbError::InvalidInput(format!(
                    "memory '{memory_id}' not found"
                )));
            };

            let next_conflict = if supersede_conflict {
                if let Some(ref old_id) = conflict_id {
                    conn.execute(
                        "UPDATE memories
                         SET certified = 0, superseded_by = ?1
                         WHERE project_id = ?2 AND id = ?3",
                        rusqlite::params![memory_id, project_id, old_id],
                    )?;
                }
                None
            } else {
                conflict_id
            };

            conn.execute(
                "UPDATE memories
                 SET certified = 1,
                     conflict_id = ?1,
                     last_used_at = ?2
                 WHERE project_id = ?3 AND id = ?4",
                rusqlite::params![next_conflict, now_ms, project_id, memory_id],
            )?;

            let about = Self::load_about_tx(conn, project_id, memory_id)?;
            Ok::<_, DbError>(build_record(
                memory_id.to_owned(),
                project_id.to_owned(),
                mem_type,
                text,
                about,
                true,
                next_conflict,
                promoted_i != 0,
                superseded_by,
                created_ms,
                now_ms,
                now_ms,
            ))
        })
    }

    /// Promotes a project memory into a reusable template lesson persisted in `promoted_lessons`.
    /// Strips project slug, root path, and `keepOut` terms so client-specific identifiers never leak.
    pub fn promote_to_lesson(
        &self,
        project_id: &str,
        memory_id: &str,
    ) -> Result<(MemoryRecord, PromotedLesson)> {
        let now_ms = Utc::now().timestamp_millis();
        let settings = self.get_settings(project_id).unwrap_or_default();

        self.db.transaction(|conn| {
            let (slug, root_path, template_id): (String, String, Option<String>) = conn
                .query_row(
                    "SELECT slug, root_path, template_id FROM projects WHERE id = ?1",
                    [project_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    DbError::InvalidInput(format!("project '{project_id}' not found"))
                })?;

            struct PromoteRow {
                mem_type: String,
                text: String,
                created_ms: i64,
                conflict_id: Option<String>,
                superseded_by: Option<String>,
            }
            let existing = conn
                .query_row(
                    "SELECT mem_type, text, created_at, conflict_id, superseded_by
                     FROM memories
                     WHERE project_id = ?1 AND id = ?2",
                    rusqlite::params![project_id, memory_id],
                    |r| {
                        Ok(PromoteRow {
                            mem_type: r.get(0)?,
                            text: r.get(1)?,
                            created_ms: r.get(2)?,
                            conflict_id: r.get(3)?,
                            superseded_by: r.get(4)?,
                        })
                    },
                )
                .optional()?;

            let Some(PromoteRow {
                mem_type,
                text,
                created_ms,
                conflict_id,
                superseded_by,
            }) = existing
            else {
                return Err(DbError::InvalidInput(format!(
                    "memory '{memory_id}' not found"
                )));
            };

            let mut scrub_terms = settings.keep_out.clone();
            if slug.len() >= 3 {
                scrub_terms.push(slug);
            }
            if root_path.len() >= 3 {
                scrub_terms.push(root_path);
            }
            let generalized_text = scrub_sensitive_and_keep_out(&text, &scrub_terms);
            let tpl = template_id
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "default".into());
            let lesson_id = format!("les-{}", uuid::Uuid::new_v4().simple());

            conn.execute(
                "UPDATE memories
                 SET certified = 1, promoted = 1, last_used_at = ?1
                 WHERE project_id = ?2 AND id = ?3",
                rusqlite::params![now_ms, project_id, memory_id],
            )?;

            conn.execute(
                "INSERT INTO promoted_lessons
                    (id, project_id, source_memory_id, template_id, mem_type, text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    lesson_id,
                    project_id,
                    memory_id,
                    tpl,
                    mem_type,
                    generalized_text,
                    now_ms,
                ],
            )?;

            let about = Self::load_about_tx(conn, project_id, memory_id)?;
            let record = build_record(
                memory_id.to_owned(),
                project_id.to_owned(),
                mem_type.clone(),
                text,
                about,
                true,
                conflict_id,
                true,
                superseded_by,
                created_ms,
                now_ms,
                now_ms,
            );
            let lesson = PromotedLesson {
                id: lesson_id,
                project_id: project_id.to_owned(),
                source_memory_id: Some(memory_id.to_owned()),
                template_id: tpl,
                mem_type,
                text: generalized_text,
                created_at: format_ts_ms(now_ms),
            };
            Ok::<_, DbError>((record, lesson))
        })
    }

    /// Lists promoted lessons for `project_id`, newest first.
    pub fn list_promoted_lessons(&self, project_id: &str) -> Result<Vec<PromotedLesson>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, source_memory_id, template_id, mem_type, text, created_at
                 FROM promoted_lessons
                 WHERE project_id = ?1
                 ORDER BY created_at DESC, id ASC",
            )?;
            let rows = stmt.query_map([project_id], |r| {
                let created_ms: i64 = r.get(6)?;
                Ok(PromotedLesson {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    source_memory_id: r.get(2)?,
                    template_id: r.get(3)?,
                    mem_type: r.get(4)?,
                    text: r.get(5)?,
                    created_at: format_ts_ms(created_ms),
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Deletes a memory item cleanly from `memories`, `memory_about`, and `memory_fts`.
    pub fn delete(&self, project_id: &str, memory_id: &str) -> Result<bool> {
        self.db.transaction(|conn| {
            conn.execute(
                "DELETE FROM memory_fts WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![project_id, memory_id],
            )?;
            let deleted = conn.execute(
                "DELETE FROM memories WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![project_id, memory_id],
            )?;
            Ok::<_, DbError>(deleted > 0)
        })
    }

    /// Prunes uncertified memories whose `last_used_at` is older than `days` (default 30),
    /// removing them cleanly from `memories`, `memory_about`, and `memory_fts`.
    /// Certified memories are NEVER decayed.
    pub fn prune_decayed_uncertified(
        &self,
        project_id: Option<&str>,
        days: i64,
    ) -> Result<usize> {
        let now_ms = Utc::now().timestamp_millis();
        let cutoff_ms = now_ms - days.max(1) * DAY_MS;

        self.db.transaction(|conn| {
            let mut expired: Vec<(String, String)> = Vec::new();
            if let Some(pid) = project_id {
                let mut stmt = conn.prepare(
                    "SELECT project_id, id
                     FROM memories
                     WHERE project_id = ?1 AND certified = 0 AND last_used_at < ?2",
                )?;
                let rows = stmt.query_map(rusqlite::params![pid, cutoff_ms], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?;
                for r in rows {
                    expired.push(r?);
                }
            } else {
                let mut stmt = conn.prepare(
                    "SELECT project_id, id
                     FROM memories
                     WHERE certified = 0 AND last_used_at < ?1",
                )?;
                let rows = stmt.query_map([cutoff_ms], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?;
                for r in rows {
                    expired.push(r?);
                }
            }

            for (pid, mid) in &expired {
                conn.execute(
                    "DELETE FROM memory_fts WHERE project_id = ?1 AND id = ?2",
                    rusqlite::params![pid, mid],
                )?;
                conn.execute(
                    "DELETE FROM memories WHERE project_id = ?1 AND id = ?2",
                    rusqlite::params![pid, mid],
                )?;
            }
            Ok::<_, DbError>(expired.len())
        })
    }

    /// Reads `MemorySettings` from `projects.config_json["memorySettings"]`.
    pub fn get_settings(&self, project_id: &str) -> Result<MemorySettings> {
        self.db.read(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(cfg_str) = raw else {
                return Err(DbError::InvalidInput(format!(
                    "project '{project_id}' not found"
                )));
            };
            let cfg: Value = serde_json::from_str(&cfg_str).unwrap_or_else(|_| json!({}));
            let settings = cfg
                .get("memorySettings")
                .cloned()
                .and_then(|v| serde_json::from_value::<MemorySettings>(v).ok())
                .unwrap_or_default();
            Ok::<_, DbError>(settings)
        })
    }

    /// Updates `MemorySettings` in `projects.config_json["memorySettings"]` and scrubs any
    /// `keepOut` entries from existing project memories and `memory_fts`.
    pub fn set_settings(
        &self,
        project_id: &str,
        settings: &MemorySettings,
    ) -> Result<MemorySettings> {
        let now_ms = Utc::now().timestamp_millis();
        let mut keep_out: Vec<String> = settings
            .keep_out
            .iter()
            .map(|s| s.trim().to_owned())
            .filter(|s| s.len() >= 2)
            .collect();
        keep_out.sort();
        keep_out.dedup_by(|a, b| a.eq_ignore_ascii_case(b));

        let cleaned = MemorySettings {
            extraction: MemoryExtractionConfig {
                enabled: settings.extraction.enabled,
                account: if settings.extraction.account.trim().is_empty() {
                    "default".into()
                } else {
                    settings.extraction.account.trim().to_owned()
                },
            },
            keep_out,
        };

        self.db.transaction(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(cfg_str) = raw else {
                return Err(DbError::InvalidInput(format!(
                    "project '{project_id}' not found"
                )));
            };
            let mut cfg: Value = serde_json::from_str(&cfg_str).unwrap_or_else(|_| json!({}));
            if !cfg.is_object() {
                cfg = json!({});
            }
            if let Some(obj) = cfg.as_object_mut() {
                obj.insert(
                    "memorySettings".into(),
                    serde_json::to_value(&cleaned)
                        .map_err(|e| DbError::InvalidInput(format!("memory settings json: {e}")))?,
                );
            }
            let updated_json = serde_json::to_string(&cfg)
                .map_err(|e| DbError::InvalidInput(format!("config json: {e}")))?;
            conn.execute(
                "UPDATE projects SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![updated_json, now_ms, project_id],
            )?;

            // Scrub keepOut terms from existing memories & FTS index.
            if !cleaned.keep_out.is_empty() {
                let mut stmt = conn.prepare(
                    "SELECT id, text FROM memories WHERE project_id = ?1",
                )?;
                let existing: Vec<(String, String)> = stmt
                    .query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<std::result::Result<_, _>>()?;
                for (mid, text) in existing {
                    let scrubbed = scrub_sensitive_and_keep_out(&text, &cleaned.keep_out);
                    if scrubbed != text {
                        conn.execute(
                            "UPDATE memories SET text = ?1 WHERE project_id = ?2 AND id = ?3",
                            rusqlite::params![scrubbed, project_id, mid],
                        )?;
                        conn.execute(
                            "DELETE FROM memory_fts WHERE project_id = ?1 AND id = ?2",
                            rusqlite::params![project_id, mid],
                        )?;
                        conn.execute(
                            "INSERT INTO memory_fts (id, project_id, text) VALUES (?1, ?2, ?3)",
                            rusqlite::params![mid, project_id, scrubbed],
                        )?;
                    }
                }
            }

            Ok::<_, DbError>(cleaned.clone())
        })
    }

    fn load_about_tx(
        conn: &rusqlite::Connection,
        project_id: &str,
        memory_id: &str,
    ) -> Result<Vec<String>> {
        let mut stmt = conn.prepare(
            "SELECT about FROM memory_about
             WHERE project_id = ?1 AND memory_id = ?2
             ORDER BY about ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![project_id, memory_id], |r| r.get(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    fn detect_conflict_tx(
        conn: &rusqlite::Connection,
        project_id: &str,
        candidate_id: &str,
        mem_type: &str,
        candidate_text: &str,
        about: &[String],
    ) -> Result<Option<String>> {
        // 1. Check certified memories sharing any `about` topic tag.
        if !about.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT m.id, m.text
                 FROM memories m
                 JOIN memory_about a ON a.project_id = m.project_id AND a.memory_id = m.id
                 WHERE m.project_id = ?1
                   AND m.certified = 1
                   AND m.id != ?2
                   AND a.about = ?3
                 ORDER BY m.last_used_at DESC",
            )?;
            for tag in about {
                let rows = stmt.query_map(rusqlite::params![project_id, candidate_id, tag], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?;
                for row in rows {
                    let (existing_id, existing_text) = row?;
                    if has_contradiction_signal(&existing_text, candidate_text) {
                        return Ok(Some(existing_id));
                    }
                }
            }
        }

        // 2. Fallback: certified memories of same `mem_type` sharing >= 2 substantive keywords with contradiction cues.
        let mut stmt = conn.prepare(
            "SELECT id, text
             FROM memories
             WHERE project_id = ?1 AND certified = 1 AND mem_type = ?2 AND id != ?3
             ORDER BY last_used_at DESC
             LIMIT 50",
        )?;
        let cand_kw = extract_keywords(candidate_text);
        let rows = stmt.query_map(rusqlite::params![project_id, mem_type, candidate_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (existing_id, existing_text) = row?;
            let existing_kw = extract_keywords(&existing_text);
            let shared = cand_kw.intersection(&existing_kw).count();
            if shared >= 2 && has_contradiction_signal(&existing_text, candidate_text) {
                return Ok(Some(existing_id));
            }
        }
        Ok(None)
    }
}

#[allow(clippy::too_many_arguments)]
fn build_record(
    id: String,
    project_id: String,
    mem_type: String,
    text: String,
    about: Vec<String>,
    certified: bool,
    conflict_id: Option<String>,
    promoted: bool,
    superseded_by: Option<String>,
    created_ms: i64,
    last_used_ms: i64,
    now_ms: i64,
) -> MemoryRecord {
    let days_until_decay = if certified {
        None
    } else {
        let elapsed_days = (now_ms - last_used_ms).max(0) / DAY_MS;
        Some((DEFAULT_UNCERTIFIED_DECAY_DAYS - elapsed_days).max(0))
    };
    MemoryRecord {
        id,
        project_id,
        mem_type,
        text,
        about,
        certified,
        conflict_id,
        promoted,
        superseded_by,
        days_until_decay,
        created_at: format_ts_ms(created_ms),
        last_used_at: format_ts_ms(last_used_ms),
    }
}

/// Repository for encrypted provider/account secrets in `vault_secrets`.
#[derive(Debug, Clone)]
pub struct VaultSecretRepo {
    db: Db,
}

impl VaultSecretRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn upsert(
        &self,
        id: &str,
        scope: &str,
        provider: &str,
        label: &str,
        secret_enc: &str,
    ) -> Result<VaultSecretMeta> {
        let now_ms = Utc::now().timestamp_millis();
        let clean_provider = provider.trim().to_ascii_lowercase();
        if clean_provider.is_empty() {
            return Err(DbError::InvalidInput("provider is required".into()));
        }
        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO vault_secrets (id, scope, provider, label, secret_enc, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    scope = excluded.scope,
                    provider = excluded.provider,
                    label = excluded.label,
                    secret_enc = excluded.secret_enc,
                    updated_at = excluded.updated_at",
                rusqlite::params![id, scope, clean_provider, label, secret_enc, now_ms],
            )?;
            Ok::<_, DbError>(VaultSecretMeta {
                id: id.to_owned(),
                scope: scope.to_owned(),
                provider: clean_provider,
                label: label.to_owned(),
                created_at: format_ts_ms(now_ms),
                updated_at: format_ts_ms(now_ms),
            })
        })
    }

    pub fn get_by_provider(&self, provider: &str) -> Result<Option<VaultSecretRecord>> {
        let clean = provider.trim().to_ascii_lowercase();
        self.db.read(|conn| {
            conn.query_row(
                "SELECT id, scope, provider, label, secret_enc
                 FROM vault_secrets
                 WHERE provider = ?1
                 ORDER BY updated_at DESC
                 LIMIT 1",
                [clean],
                |r| {
                    Ok(VaultSecretRecord {
                        id: r.get(0)?,
                        scope: r.get(1)?,
                        provider: r.get(2)?,
                        label: r.get(3)?,
                        secret_enc: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(DbError::from)
        })
    }

    pub fn list_meta(&self) -> Result<Vec<VaultSecretMeta>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, scope, provider, label, created_at, updated_at
                 FROM vault_secrets
                 ORDER BY provider ASC, updated_at DESC",
            )?;
            let rows = stmt.query_map([], |r| {
                let c_ms: i64 = r.get(4)?;
                let u_ms: i64 = r.get(5)?;
                Ok(VaultSecretMeta {
                    id: r.get(0)?,
                    scope: r.get(1)?,
                    provider: r.get(2)?,
                    label: r.get(3)?,
                    created_at: format_ts_ms(c_ms),
                    updated_at: format_ts_ms(u_ms),
                })
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        self.db.transaction(|conn| {
            let deleted = conn.execute("DELETE FROM vault_secrets WHERE id = ?1", [id])?;
            Ok::<_, DbError>(deleted > 0)
        })
    }
}
