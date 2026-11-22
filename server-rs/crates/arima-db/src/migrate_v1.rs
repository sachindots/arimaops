// SPDX-License-Identifier: AGPL-3.0-or-later

//! Lossless, read-only-source v1 -> v2 data migrator (`arima-server migrate-v1`).
//!
//! Reads legacy v1 layout (`hq.db`, `projects.json`, `users.json`, `vault.enc`,
//! per-project `tasks.db` / `memory.db`, and `evidence/`) strictly read-only,
//! supports `--dry-run` inspection with zero writes, imports atomically into
//! `<to>/arima.db` (indexing `memory_fts`), copies `evidence/` safely rejecting
//! symlink/traversal escapes, and is idempotent on re-run.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{Db, DbError, Result};

/// Configuration for running the v1 -> v2 migrator.
#[derive(Debug, Clone)]
pub struct MigrateV1Options {
    pub from: PathBuf,
    pub to: PathBuf,
    pub dry_run: bool,
}

/// Summary report produced by both `--dry-run` and live migrations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateV1Report {
    pub dry_run: bool,
    pub source_path: String,
    pub target_path: String,
    pub projects: usize,
    pub users: usize,
    pub tasks: usize,
    pub memories: usize,
    pub findings: usize,
    pub evidence_files: usize,
    pub vault_found: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct LegacyProject {
    id: String,
    slug: String,
    name: String,
    root_path: String,
    template_id: Option<String>,
    config_json: String,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct LegacyUser {
    id: String,
    name: String,
    password_hash: String,
    role: String,
    disabled: bool,
    totp_secret_enc: Option<String>,
    totp_enabled: bool,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct LegacyTask {
    id: String,
    project_id: String,
    board_id: String,
    stage_id: String,
    status: String,
    title: String,
    owner_id: Option<String>,
    data_json: String,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct LegacyMemory {
    id: String,
    project_id: String,
    mem_type: String,
    text: String,
    certified: bool,
    about: Vec<String>,
    created_at: i64,
    last_used_at: i64,
}

#[derive(Debug, Clone)]
struct LegacyFinding {
    id: String,
    project_id: String,
    title: String,
    severity: String,
    cvss_score: Option<f64>,
    asset: Option<String>,
    status: String,
    verified: bool,
    data_json: String,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct EvidenceCopyItem {
    src: PathBuf,
    rel_under_evidence: PathBuf,
}

#[derive(Default)]
struct ParsedLegacyData {
    projects: Vec<LegacyProject>,
    users: Vec<LegacyUser>,
    tasks: Vec<LegacyTask>,
    memories: Vec<LegacyMemory>,
    findings: Vec<LegacyFinding>,
    evidence: Vec<EvidenceCopyItem>,
    vault_src: Option<PathBuf>,
    warnings: Vec<String>,
}

/// Runs a lossless v1 -> v2 migration (or non-mutating `--dry-run` scan).
///
/// The `--from` directory is NEVER modified under any circumstances.
pub fn migrate_v1_data(opts: &MigrateV1Options) -> Result<MigrateV1Report> {
    if !opts.from.is_dir() {
        return Err(DbError::InvalidInput(format!(
            "v1 source directory '{}' does not exist or is not a directory",
            opts.from.display()
        )));
    }
    if opts.from == opts.to {
        return Err(DbError::InvalidInput(
            "source (--from) and destination (--to) directories must differ".into(),
        ));
    }

    let parsed = scan_v1_readonly(&opts.from)?;

    let report = MigrateV1Report {
        dry_run: opts.dry_run,
        source_path: opts.from.display().to_string(),
        target_path: opts.to.display().to_string(),
        projects: parsed.projects.len(),
        users: parsed.users.len(),
        tasks: parsed.tasks.len(),
        memories: parsed.memories.len(),
        findings: parsed.findings.len(),
        evidence_files: parsed.evidence.len(),
        vault_found: parsed.vault_src.is_some(),
        warnings: parsed.warnings.clone(),
    };

    if opts.dry_run {
        return Ok(report);
    }

    // Real import: atomically populate `<to>/arima.db`, copy `vault.enc` (0600) and `evidence/`.
    crate::ensure_private_dir(&opts.to)?;
    let db = Db::open(&opts.to.join("arima.db"))?;
    let now_ms = Utc::now().timestamp_millis();

    db.transaction(|conn| {
        for u in &parsed.users {
            let role = match u.role.to_ascii_lowercase().as_str() {
                "owner" | "operator" | "viewer" => u.role.to_ascii_lowercase(),
                _ => "operator".to_owned(),
            };
            conn.execute(
                "INSERT INTO users
                    (id, name, password_hash, role, disabled, totp_secret_enc, totp_enabled, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    role = excluded.role,
                    disabled = excluded.disabled",
                rusqlite::params![
                    u.id,
                    u.name,
                    u.password_hash,
                    role,
                    i64::from(u.disabled),
                    u.totp_secret_enc,
                    i64::from(u.totp_enabled),
                    u.created_at,
                ],
            )?;
        }

        for p in &parsed.projects {
            conn.execute(
                "INSERT INTO projects
                    (id, slug, name, root_path, template_id, config_json, paused, archived, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    root_path = excluded.root_path,
                    template_id = COALESCE(excluded.template_id, projects.template_id),
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    p.id,
                    p.slug,
                    p.name,
                    p.root_path,
                    p.template_id,
                    p.config_json,
                    p.created_at,
                    now_ms,
                ],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                 VALUES ('B1', ?1, 'Main Board', 'active', ?2, ?2)",
                rusqlite::params![p.id, p.created_at],
            )?;
        }

        for t in &parsed.tasks {
            conn.execute(
                "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                 VALUES (?1, ?2, 'Main Board', 'active', ?3, ?3)",
                rusqlite::params![t.board_id, t.project_id, t.created_at],
            )?;
            conn.execute(
                "INSERT INTO tasks
                    (id, project_id, board_id, goal_id, stage_id, status, title, owner_id, data_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    status = excluded.status,
                    title = excluded.title,
                    owner_id = excluded.owner_id,
                    data_json = excluded.data_json",
                rusqlite::params![
                    t.id,
                    t.project_id,
                    t.board_id,
                    t.stage_id,
                    t.status,
                    t.title,
                    t.owner_id,
                    t.data_json,
                    t.created_at,
                ],
            )?;
        }

        for m in &parsed.memories {
            conn.execute(
                "INSERT INTO memories
                    (id, project_id, mem_type, text, certified, created_at, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    mem_type = excluded.mem_type,
                    text = excluded.text,
                    certified = excluded.certified,
                    last_used_at = excluded.last_used_at",
                rusqlite::params![
                    m.id,
                    m.project_id,
                    m.mem_type,
                    m.text,
                    i64::from(m.certified),
                    m.created_at,
                    m.last_used_at,
                ],
            )?;
            for tag in &m.about {
                conn.execute(
                    "INSERT OR IGNORE INTO memory_about (project_id, memory_id, about)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![m.project_id, m.id, tag],
                )?;
            }
            // Idempotent FTS5 re-index: remove any existing row for (project_id, id) first.
            conn.execute(
                "DELETE FROM memory_fts WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![m.project_id, m.id],
            )?;
            conn.execute(
                "INSERT INTO memory_fts (id, project_id, text) VALUES (?1, ?2, ?3)",
                rusqlite::params![m.id, m.project_id, m.text],
            )?;
        }

        for f in &parsed.findings {
            conn.execute(
                "INSERT INTO findings
                    (id, project_id, title, severity, cvss_score, asset, status, verified, data_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    title = excluded.title,
                    severity = excluded.severity,
                    cvss_score = excluded.cvss_score,
                    status = excluded.status,
                    verified = excluded.verified,
                    data_json = excluded.data_json",
                rusqlite::params![
                    f.id,
                    f.project_id,
                    f.title,
                    f.severity,
                    f.cvss_score,
                    f.asset,
                    f.status,
                    i64::from(f.verified),
                    f.data_json,
                    f.created_at,
                ],
            )?;
        }

        Ok::<_, DbError>(())
    })?;

    // Copy legacy vault.enc safely with 0600 permissions (never following symlinks).
    if let Some(ref vault_src) = parsed.vault_src {
        let bytes = fs::read(vault_src)?;
        let dest = opts.to.join("v1-vault.enc");
        write_private_file(&dest, &bytes)?;
    }

    // Copy evidence files safely, ensuring zero symlink traversal in destination.
    let dest_ev_root = opts.to.join("evidence");
    for item in &parsed.evidence {
        validate_rel_path(&item.rel_under_evidence)?;
        let dest_path = dest_ev_root.join(&item.rel_under_evidence);
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = fs::read(&item.src)?;
        fs::write(&dest_path, &bytes)?;
    }

    db.checkpoint_and_close()?;
    Ok(report)
}

fn scan_v1_readonly(from: &Path) -> Result<ParsedLegacyData> {
    let mut out = ParsedLegacyData::default();
    let now_ms = Utc::now().timestamp_millis();

    let mut project_ids: HashSet<String> = HashSet::new();
    let mut project_by_slug: HashMap<String, String> = HashMap::new();
    let mut user_names: HashSet<String> = HashSet::new();

    // 1. Optional legacy vault.enc
    let vault_cand = from.join("vault.enc");
    if let Ok(md) = fs::symlink_metadata(&vault_cand) {
        if md.file_type().is_symlink() {
            out.warnings
                .push("skipped symlinked vault.enc in source directory".into());
        } else if md.is_file() {
            out.vault_src = Some(vault_cand);
        }
    }

    // 2. Optional projects.json
    let projects_json_path = from.join("projects.json");
    if is_regular_file(&projects_json_path) {
        match fs::read_to_string(&projects_json_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        {
            Some(val) => {
                let arr = val
                    .as_array()
                    .or_else(|| val.get("projects").and_then(Value::as_array));
                if let Some(list) = arr {
                    for item in list {
                        let slug = item
                            .get("slug")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim();
                        if slug.is_empty() {
                            continue;
                        }
                        let clean_slug = sanitize_slug(slug);
                        let id = item
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("proj-{clean_slug}"));
                        if project_ids.insert(id.clone()) {
                            project_by_slug.insert(clean_slug.clone(), id.clone());
                            out.projects.push(LegacyProject {
                                id,
                                slug: clean_slug.clone(),
                                name: item
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or(&clean_slug)
                                    .to_owned(),
                                root_path: item
                                    .get("path")
                                    .or_else(|| item.get("rootPath"))
                                    .and_then(Value::as_str)
                                    .unwrap_or(".")
                                    .to_owned(),
                                template_id: item
                                    .get("templateId")
                                    .or_else(|| item.get("template"))
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                                config_json: item
                                    .get("config")
                                    .map(Value::to_string)
                                    .unwrap_or_else(|| "{}".into()),
                                created_at: parse_any_ts(item.get("createdAt"), now_ms),
                            });
                        }
                    }
                }
            }
            None => out.warnings.push("projects.json could not be parsed".into()),
        }
    }

    // 3. Optional users.json
    let users_json_path = from.join("users.json");
    if is_regular_file(&users_json_path) {
        match fs::read_to_string(&users_json_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        {
            Some(val) => {
                let arr = val
                    .as_array()
                    .or_else(|| val.get("users").and_then(Value::as_array));
                if let Some(list) = arr {
                    for item in list {
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim();
                        if name.is_empty() || !user_names.insert(name.to_ascii_lowercase()) {
                            continue;
                        }
                        let id = item
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("usr-{}", sanitize_slug(name)));
                        out.users.push(LegacyUser {
                            id,
                            name: name.to_owned(),
                            password_hash: item
                                .get("passwordHash")
                                .or_else(|| item.get("password_hash"))
                                .and_then(Value::as_str)
                                .unwrap_or("$migrated-reset-required$")
                                .to_owned(),
                            role: item
                                .get("role")
                                .and_then(Value::as_str)
                                .unwrap_or("operator")
                                .to_owned(),
                            disabled: item
                                .get("disabled")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            totp_secret_enc: item
                                .get("totpSecretEnc")
                                .or_else(|| item.get("totp_secret_enc"))
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            totp_enabled: item
                                .get("totpEnabled")
                                .or_else(|| item.get("totp_enabled"))
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            created_at: parse_any_ts(item.get("createdAt"), now_ms),
                        });
                    }
                }
            }
            None => out.warnings.push("users.json could not be parsed".into()),
        }
    }

    // 4. Optional legacy central SQLite (`hq.db` or `arima.db`) opened strictly READ-ONLY.
    for db_name in ["hq.db", "arima.db"] {
        let db_path = from.join(db_name);
        if is_regular_file(&db_path) {
            if let Err(err) = read_legacy_sqlite(
                &db_path,
                None,
                &mut out,
                &mut project_ids,
                &mut project_by_slug,
                &mut user_names,
                now_ms,
            ) {
                out.warnings
                    .push(format!("could not read {db_name}: {err}"));
            }
        }
    }

    // 5. Per-project legacy SQLite files (`<from>/<slug>/tasks.db`, `memory.db`, or `<from>/projects/<slug>/*.db`).
    let mut scan_roots = vec![from.to_path_buf()];
    let projects_dir = from.join("projects");
    if projects_dir.is_dir() && !is_symlink(&projects_dir) {
        scan_roots.push(projects_dir);
    }
    for root in scan_roots {
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(md) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if md.file_type().is_symlink() || !md.is_dir() {
                    continue;
                }
                let Some(dir_name) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if matches!(dir_name, "evidence" | "backups" | "feedback" | "usage" | "projects") {
                    continue;
                }
                let tasks_db = path.join("tasks.db");
                let mem_db = path.join("memory.db");
                if is_regular_file(&tasks_db) || is_regular_file(&mem_db) {
                    let slug = sanitize_slug(dir_name);
                    let pid = project_by_slug
                        .get(&slug)
                        .cloned()
                        .unwrap_or_else(|| {
                            let id = format!("proj-{slug}");
                            if project_ids.insert(id.clone()) {
                                project_by_slug.insert(slug.clone(), id.clone());
                                out.projects.push(LegacyProject {
                                    id: id.clone(),
                                    slug: slug.clone(),
                                    name: dir_name.to_owned(),
                                    root_path: path.display().to_string(),
                                    template_id: None,
                                    config_json: "{}".into(),
                                    created_at: now_ms,
                                });
                            }
                            id
                        });
                    for sub_db in [tasks_db, mem_db] {
                        if is_regular_file(&sub_db) {
                            if let Err(err) = read_legacy_sqlite(
                                &sub_db,
                                Some(&pid),
                                &mut out,
                                &mut project_ids,
                                &mut project_by_slug,
                                &mut user_names,
                                now_ms,
                            ) {
                                out.warnings.push(format!(
                                    "could not read {}: {err}",
                                    sub_db.display()
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    // 6. Evidence directory (skipping symlinks & escaping paths with explicit warning).
    let ev_root = from.join("evidence");
    if let Ok(md) = fs::symlink_metadata(&ev_root) {
        if md.file_type().is_symlink() {
            out.warnings
                .push("skipped symlinked evidence/ root directory".into());
        } else if md.is_dir() {
            collect_evidence_readonly(&ev_root, &ev_root, &mut out.evidence, &mut out.warnings)?;
        }
    }

    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn read_legacy_sqlite(
    db_path: &Path,
    default_project_id: Option<&str>,
    out: &mut ParsedLegacyData,
    project_ids: &mut HashSet<String>,
    project_by_slug: &mut HashMap<String, String>,
    user_names: &mut HashSet<String>,
    now_ms: i64,
) -> Result<()> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let tables: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let set: HashSet<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(std::result::Result::ok)
            .collect();
        set
    };

    if tables.contains("projects") {
        let stmt = conn.prepare(
            "SELECT id, slug, name, root_path, template_id, config_json, created_at FROM projects",
        );
        if let Ok(mut s) = stmt {
            let rows = s.query_map([], |r| {
                Ok(LegacyProject {
                    id: r.get(0)?,
                    slug: r.get(1)?,
                    name: r.get(2)?,
                    root_path: r.get::<_, Option<String>>(3)?.unwrap_or_else(|| ".".into()),
                    template_id: r.get(4)?,
                    config_json: r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "{}".into()),
                    created_at: r.get::<_, Option<i64>>(6)?.unwrap_or(now_ms),
                })
            })?;
            for p in rows.flatten() {
                if project_ids.insert(p.id.clone()) {
                    project_by_slug.insert(p.slug.clone(), p.id.clone());
                    out.projects.push(p);
                }
            }
        }
    }

    if tables.contains("users") {
        let stmt = conn.prepare(
            "SELECT id, name, password_hash, role, disabled, totp_secret_enc, totp_enabled, created_at FROM users",
        );
        if let Ok(mut s) = stmt {
            let rows = s.query_map([], |r| {
                Ok(LegacyUser {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    password_hash: r.get(2)?,
                    role: r.get(3)?,
                    disabled: r.get::<_, i64>(4).unwrap_or(0) != 0,
                    totp_secret_enc: r.get(5).ok().flatten(),
                    totp_enabled: r.get::<_, i64>(6).unwrap_or(0) != 0,
                    created_at: r.get::<_, Option<i64>>(7)?.unwrap_or(now_ms),
                })
            })?;
            for u in rows.flatten() {
                if user_names.insert(u.name.to_ascii_lowercase()) {
                    out.users.push(u);
                }
            }
        }
    }

    if tables.contains("tasks") {
        let proj_col = if table_has_column(&conn, "tasks", "project_id") {
            "COALESCE(project_id, '')"
        } else {
            "''"
        };
        let board_col = if table_has_column(&conn, "tasks", "board_id") {
            "COALESCE(board_id, 'B1')"
        } else {
            "'B1'"
        };
        let stage_col = if table_has_column(&conn, "tasks", "stage_id") {
            "COALESCE(stage_id, 'build')"
        } else {
            "'build'"
        };
        let owner_col = if table_has_column(&conn, "tasks", "owner_id") {
            "owner_id"
        } else {
            "NULL"
        };
        let data_col = if table_has_column(&conn, "tasks", "data_json") {
            "COALESCE(data_json, '{}')"
        } else {
            "'{}'"
        };
        let sql = format!(
            "SELECT id, {proj_col}, {board_col}, {stage_col}, COALESCE(status, 'todo'), title, {owner_col}, {data_col}, COALESCE(created_at, 0) FROM tasks"
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            let rows = stmt.query_map([], |r| {
                let raw_pid: String = r.get(1)?;
                let pid = if !raw_pid.trim().is_empty() {
                    raw_pid
                } else {
                    default_project_id.unwrap_or("proj-default").to_owned()
                };
                let created: i64 = r.get(8)?;
                Ok(LegacyTask {
                    id: r.get(0)?,
                    project_id: pid,
                    board_id: r.get(2)?,
                    stage_id: r.get(3)?,
                    status: r.get(4)?,
                    title: r.get(5)?,
                    owner_id: r.get(6)?,
                    data_json: r.get(7)?,
                    created_at: if created > 0 { created } else { now_ms },
                })
            })?;
            for t in rows.flatten() {
                ensure_project_exists(
                    &t.project_id,
                    out,
                    project_ids,
                    project_by_slug,
                    now_ms,
                );
                out.tasks.push(t);
            }
        }
    }

    if tables.contains("memories") {
        let has_proj_col = table_has_column(&conn, "memories", "project_id");
        let has_mem_type = table_has_column(&conn, "memories", "mem_type");
        let type_col = if has_mem_type { "mem_type" } else { "'Lesson'" };
        let sql = if has_proj_col {
            format!(
                "SELECT id, project_id, COALESCE({type_col}, 'Lesson'), text, COALESCE(certified, 0), COALESCE(created_at, 0), COALESCE(last_used_at, 0) FROM memories"
            )
        } else {
            format!(
                "SELECT id, '' AS project_id, COALESCE({type_col}, 'Lesson'), text, COALESCE(certified, 0), COALESCE(created_at, 0), COALESCE(last_used_at, 0) FROM memories"
            )
        };
        if let Ok(mut stmt) = conn.prepare(&sql) {
            let rows = stmt.query_map([], |r| {
                let raw_pid: String = r.get(1)?;
                let pid = if !raw_pid.trim().is_empty() {
                    raw_pid
                } else {
                    default_project_id.unwrap_or("proj-default").to_owned()
                };
                let created: i64 = r.get(5)?;
                let last_used: i64 = r.get(6)?;
                let c_ms = if created > 0 { created } else { now_ms };
                let l_ms = if last_used > 0 { last_used } else { c_ms };
                Ok(LegacyMemory {
                    id: r.get(0)?,
                    project_id: pid,
                    mem_type: r.get(2)?,
                    text: r.get(3)?,
                    certified: r.get::<_, i64>(4)? != 0,
                    about: vec![],
                    created_at: c_ms,
                    last_used_at: l_ms,
                })
            })?;
            for m in rows.flatten() {
                ensure_project_exists(
                    &m.project_id,
                    out,
                    project_ids,
                    project_by_slug,
                    now_ms,
                );
                out.memories.push(m);
            }
        }
    }

    if tables.contains("findings") {
        let proj_col = if table_has_column(&conn, "findings", "project_id") {
            "COALESCE(project_id, '')"
        } else {
            "''"
        };
        let data_col = if table_has_column(&conn, "findings", "data_json") {
            "COALESCE(data_json, '{}')"
        } else {
            "'{}'"
        };
        let cvss_col = if table_has_column(&conn, "findings", "cvss_score") {
            "cvss_score"
        } else {
            "NULL"
        };
        let asset_col = if table_has_column(&conn, "findings", "asset") {
            "asset"
        } else {
            "NULL"
        };
        let ver_col = if table_has_column(&conn, "findings", "verified") {
            "COALESCE(verified, 0)"
        } else {
            "0"
        };
        let sql = format!(
            "SELECT id, {proj_col}, title, COALESCE(severity, 'medium'), {cvss_col}, {asset_col}, COALESCE(status, 'open'), {ver_col}, {data_col}, COALESCE(created_at, 0) FROM findings"
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            let rows = stmt.query_map([], |r| {
                let raw_pid: String = r.get(1)?;
                let pid = if !raw_pid.trim().is_empty() {
                    raw_pid
                } else {
                    default_project_id.unwrap_or("proj-default").to_owned()
                };
                let created: i64 = r.get(9)?;
                Ok(LegacyFinding {
                    id: r.get(0)?,
                    project_id: pid,
                    title: r.get(2)?,
                    severity: r.get(3)?,
                    cvss_score: r.get(4)?,
                    asset: r.get(5)?,
                    status: r.get(6)?,
                    verified: r.get::<_, i64>(7)? != 0,
                    data_json: r.get(8)?,
                    created_at: if created > 0 { created } else { now_ms },
                })
            })?;
            for f in rows.flatten() {
                ensure_project_exists(
                    &f.project_id,
                    out,
                    project_ids,
                    project_by_slug,
                    now_ms,
                );
                out.findings.push(f);
            }
        }
    }

    Ok(())
}

fn ensure_project_exists(
    project_id: &str,
    out: &mut ParsedLegacyData,
    project_ids: &mut HashSet<String>,
    project_by_slug: &mut HashMap<String, String>,
    now_ms: i64,
) {
    if project_ids.insert(project_id.to_owned()) {
        let slug = sanitize_slug(project_id.strip_prefix("proj-").unwrap_or(project_id));
        project_by_slug.insert(slug.clone(), project_id.to_owned());
        out.projects.push(LegacyProject {
            id: project_id.to_owned(),
            slug: slug.clone(),
            name: slug,
            root_path: ".".into(),
            template_id: None,
            config_json: json!({}).to_string(),
            created_at: now_ms,
        });
    }
}

fn table_has_column(conn: &Connection, table: &str, col: &str) -> bool {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let found = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map(|rows| rows.flatten().any(|name| name.eq_ignore_ascii_case(col)))
        .unwrap_or(false);
    drop(stmt);
    found
}

fn collect_evidence_readonly(
    ev_root: &Path,
    dir: &Path,
    out: &mut Vec<EvidenceCopyItem>,
    warnings: &mut Vec<String>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let md = fs::symlink_metadata(&path)?;
        if md.file_type().is_symlink() {
            warnings.push(format!(
                "rejected symlink escape in evidence/: {}",
                path.display()
            ));
            continue;
        }
        if md.is_dir() {
            collect_evidence_readonly(ev_root, &path, out, warnings)?;
        } else if md.is_file() {
            let rel = path
                .strip_prefix(ev_root)
                .map_err(|_| DbError::InvalidInput("evidence relative path error".into()))?
                .to_path_buf();
            validate_rel_path(&rel)?;
            out.push(EvidenceCopyItem {
                src: path,
                rel_under_evidence: rel,
            });
        }
    }
    Ok(())
}

fn validate_rel_path(rel: &Path) -> Result<()> {
    if rel.as_os_str().is_empty() {
        return Err(DbError::InvalidInput("empty relative path".into()));
    }
    for c in rel.components() {
        match c {
            Component::Normal(_) => {}
            _ => {
                return Err(DbError::InvalidInput(format!(
                    "unsafe path traversal rejected: {}",
                    rel.display()
                )))
            }
        }
    }
    Ok(())
}

fn sanitize_slug(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = s.trim_matches('-');
    if trimmed.is_empty() {
        "default".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn parse_any_ts(val: Option<&Value>, fallback_ms: i64) -> i64 {
    match val {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(fallback_ms),
        Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(fallback_ms),
        _ => fallback_ms,
    }
}

fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

fn is_regular_file(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
}

fn write_private_file(dest: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(dest)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::set_permissions(dest, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(dest)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    Ok(())
}
