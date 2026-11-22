// SPDX-License-Identifier: AGPL-3.0-or-later

//! Factory metrics, task scores, nightly improvement proposals, replay benchmarks,
//! vaulted tool connections, and server-wide key/value settings persistence.

use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Db, DbError, Result};

const DAY_MS: i64 = 86_400_000;

fn format_ts_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

/// Aggregated Factory metrics for one time window (current or previous period).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryWindowMetrics {
    pub completed_tasks: usize,
    pub avg_score: f64,
    pub pass_rate: f64,
    pub total_cost_usd: f64,
    pub avg_cycle_mins: f64,
}

/// One persisted task score row in `scores`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScoreRecord {
    pub id: i64,
    pub project_id: String,
    pub task_id: String,
    pub scorer: String,
    pub score: f64,
    pub pass: bool,
    pub reason: String,
    pub cost_usd: f64,
    pub created_at: String,
}

/// One nightly improvement proposal row in `improvement_proposals`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImprovementProposal {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub rationale: String,
    pub category: String,
    pub diff_hint: String,
    pub status: String,
    pub note: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

/// One case result inside a Replay Benchmark run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkCaseResult {
    pub id: String,
    pub prompt: String,
    pub expected_keywords: Vec<String>,
    pub matched_keywords: Vec<String>,
    pub passed: bool,
    pub score: f64,
    pub latency_ms: f64,
    pub output_preview: String,
}

/// Persisted Replay Benchmark Harness run in `benchmark_runs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRun {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub pass_rate: f64,
    pub avg_score: f64,
    pub avg_latency_ms: f64,
    pub cases: Vec<BenchmarkCaseResult>,
    pub created_at: String,
}

/// Complete payload returned by `GET /api/projects/{id}/factory/metrics`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryMetricsReport {
    pub days: u32,
    pub current: FactoryWindowMetrics,
    pub previous: FactoryWindowMetrics,
    pub scores: Vec<TaskScoreRecord>,
    pub proposals: Vec<ImprovementProposal>,
    pub benchmarks: Vec<BenchmarkRun>,
}

/// Input for recording a task score.
#[derive(Debug, Clone)]
pub struct RecordScoreInput {
    pub task_id: String,
    pub scorer: String,
    pub score: f64,
    pub pass: bool,
    pub reason: String,
    pub cost_usd: f64,
}

/// Input for creating an improvement proposal.
#[derive(Debug, Clone)]
pub struct CreateProposalInput {
    pub title: String,
    pub rationale: String,
    pub category: String,
    pub diff_hint: String,
}

/// Public metadata for a stored vaulted tool connection (NEVER contains raw secrets!).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolConnectionSummary {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub endpoint: String,
    pub has_secret: bool,
    pub created_at: String,
}

fn encode_score_reason(score: f64, reason: &str) -> String {
    let clamped = score.clamp(0.0, 1.0);
    let clean = reason.trim();
    format!("[score={clamped:.3}] {clean}")
}

fn decode_score_reason(raw: &str, pass: bool) -> (f64, String) {
    if let Some(rest) = raw.strip_prefix("[score=") {
        if let Some((num, tail)) = rest.split_once(']') {
            if let Ok(parsed) = num.trim().parse::<f64>() {
                return (parsed.clamp(0.0, 1.0), tail.trim().to_owned());
            }
        }
    }
    (if pass { 1.0 } else { 0.0 }, raw.to_owned())
}

/// Repository for Factory metrics, scores, nightly improvement proposals, and replay benchmarks.
#[derive(Debug, Clone)]
pub struct FactoryRepo {
    db: Db,
}

impl FactoryRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Records a task score, ensuring the target board/task row exists safely for FK integrity.
    pub fn record_score(
        &self,
        project_id: &str,
        input: RecordScoreInput,
    ) -> Result<TaskScoreRecord> {
        let task_id = input.task_id.trim();
        if task_id.is_empty() {
            return Err(DbError::InvalidInput("taskId is required".into()));
        }
        let scorer = if input.scorer.trim().is_empty() {
            "rubric-v1"
        } else {
            input.scorer.trim()
        };
        let score = input.score.clamp(0.0, 1.0);
        let encoded_reason = encode_score_reason(score, &input.reason);
        let now_ms = Utc::now().timestamp_millis();

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                 VALUES ('B1', ?1, 'Main Board', 'active', ?2, ?2)",
                rusqlite::params![project_id, now_ms],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO tasks
                    (id, project_id, board_id, stage_id, status, title, created_at, updated_at)
                 VALUES (?1, ?2, 'B1', 'verify', 'done', ?3, ?4, ?4)",
                rusqlite::params![task_id, project_id, format!("Task {task_id}"), now_ms],
            )?;

            conn.execute(
                "INSERT INTO scores (project_id, task_id, scorer, pass, reason, cost_usd, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    project_id,
                    task_id,
                    scorer,
                    i64::from(input.pass),
                    encoded_reason,
                    input.cost_usd.max(0.0),
                    now_ms,
                ],
            )?;
            let id = conn.last_insert_rowid();
            Ok::<_, DbError>(TaskScoreRecord {
                id,
                project_id: project_id.to_owned(),
                task_id: task_id.to_owned(),
                scorer: scorer.to_owned(),
                score,
                pass: input.pass,
                reason: input.reason.trim().to_owned(),
                cost_usd: input.cost_usd.max(0.0),
                created_at: format_ts_ms(now_ms),
            })
        })
    }

    /// Computes Factory metrics comparing the last `days` against the preceding `days` window,
    /// along with recent task scores, improvement proposals, and replay benchmarks.
    pub fn metrics_report(&self, project_id: &str, days: u32) -> Result<FactoryMetricsReport> {
        let clamped_days = days.clamp(1, 90);
        let now_ms = Utc::now().timestamp_millis();
        let cur_start = now_ms - i64::from(clamped_days) * DAY_MS;
        let prev_start = cur_start - i64::from(clamped_days) * DAY_MS;

        let (current, previous, scores) = self.db.read(|conn| {
            let cur = Self::window_metrics_tx(conn, project_id, cur_start, now_ms + 60_000)?;
            let prev = Self::window_metrics_tx(conn, project_id, prev_start, cur_start)?;

            let mut stmt = conn.prepare(
                "SELECT id, project_id, task_id, scorer, pass, reason, cost_usd, at
                 FROM scores
                 WHERE project_id = ?1
                 ORDER BY at DESC, id DESC
                 LIMIT 50",
            )?;
            let rows = stmt.query_map([project_id], |r| {
                let pass = r.get::<_, i64>(4)? != 0;
                let raw_reason: String = r.get(5)?;
                let (score, reason) = decode_score_reason(&raw_reason, pass);
                let at_ms: i64 = r.get(7)?;
                Ok(TaskScoreRecord {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    task_id: r.get(2)?,
                    scorer: r.get(3)?,
                    score,
                    pass,
                    reason,
                    cost_usd: r.get(6)?,
                    created_at: format_ts_ms(at_ms),
                })
            })?;
            let mut list = Vec::new();
            for row in rows {
                list.push(row?);
            }
            Ok::<_, DbError>((cur, prev, list))
        })?;

        let proposals = self.list_proposals(project_id)?;
        let benchmarks = self.list_benchmarks(project_id)?;

        Ok(FactoryMetricsReport {
            days: clamped_days,
            current,
            previous,
            scores,
            proposals,
            benchmarks,
        })
    }

    fn window_metrics_tx(
        conn: &rusqlite::Connection,
        project_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<FactoryWindowMetrics> {
        let mut completed_tasks = 0usize;
        let mut cycle_mins_sum = 0.0f64;
        {
            let mut stmt = conn.prepare(
                "SELECT created_at, updated_at
                 FROM tasks
                 WHERE project_id = ?1
                   AND LOWER(status) IN ('done', 'merged', 'completed')
                   AND updated_at >= ?2 AND updated_at < ?3",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_id, start_ms, end_ms], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?;
            for r in rows {
                let (created, updated) = r?;
                completed_tasks += 1;
                let mins = ((updated - created).max(0) as f64) / 60_000.0;
                cycle_mins_sum += mins;
            }
        }

        let mut score_count = 0usize;
        let mut score_sum = 0.0f64;
        let mut pass_count = 0usize;
        let mut score_cost = 0.0f64;
        {
            let mut stmt = conn.prepare(
                "SELECT pass, reason, cost_usd
                 FROM scores
                 WHERE project_id = ?1 AND at >= ?2 AND at < ?3",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_id, start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, i64>(0)? != 0,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                ))
            })?;
            for r in rows {
                let (pass, raw_reason, cost) = r?;
                let (sc, _) = decode_score_reason(&raw_reason, pass);
                score_count += 1;
                score_sum += sc;
                if pass {
                    pass_count += 1;
                }
                score_cost += cost;
            }
        }

        let usage_cost: f64 = conn.query_row(
            "SELECT COALESCE(SUM(cost_usd), 0.0)
             FROM usage_events
             WHERE project_id = ?1 AND at >= ?2 AND at < ?3",
            rusqlite::params![project_id, start_ms, end_ms],
            |r| r.get(0),
        )?;

        let avg_score = if score_count > 0 {
            ((score_sum / score_count as f64) * 1000.0).round() / 1000.0
        } else {
            0.0
        };
        let pass_rate = if score_count > 0 {
            ((pass_count as f64 / score_count as f64) * 1000.0).round() / 1000.0
        } else {
            0.0
        };
        let avg_cycle_mins = if completed_tasks > 0 {
            ((cycle_mins_sum / completed_tasks as f64) * 10.0).round() / 10.0
        } else {
            0.0
        };
        let total_cost_usd = (((usage_cost + score_cost) * 10_000.0).round()) / 10_000.0;

        Ok(FactoryWindowMetrics {
            completed_tasks,
            avg_score,
            pass_rate,
            total_cost_usd,
            avg_cycle_mins,
        })
    }

    pub fn create_proposal(
        &self,
        project_id: &str,
        input: CreateProposalInput,
    ) -> Result<ImprovementProposal> {
        let now_ms = Utc::now().timestamp_millis();
        let id = format!("prop-{}", uuid::Uuid::new_v4().simple());
        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO improvement_proposals
                    (id, project_id, title, rationale, category, diff_hint, status, note, created_at, decided_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', NULL, ?7, NULL)",
                rusqlite::params![
                    id,
                    project_id,
                    input.title.trim(),
                    input.rationale.trim(),
                    input.category.trim(),
                    input.diff_hint.trim(),
                    now_ms,
                ],
            )?;
            Ok::<_, DbError>(ImprovementProposal {
                id,
                project_id: project_id.to_owned(),
                title: input.title.trim().to_owned(),
                rationale: input.rationale.trim().to_owned(),
                category: input.category.trim().to_owned(),
                diff_hint: input.diff_hint.trim().to_owned(),
                status: "open".into(),
                note: None,
                created_at: format_ts_ms(now_ms),
                decided_at: None,
            })
        })
    }

    pub fn list_proposals(&self, project_id: &str) -> Result<Vec<ImprovementProposal>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, title, rationale, category, diff_hint, status, note, created_at, decided_at
                 FROM improvement_proposals
                 WHERE project_id = ?1
                 ORDER BY created_at DESC, id ASC
                 LIMIT 50",
            )?;
            let rows = stmt.query_map([project_id], Self::map_proposal)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    pub fn decide_proposal(
        &self,
        project_id: &str,
        proposal_id: &str,
        decision: &str,
        note: Option<&str>,
    ) -> Result<ImprovementProposal> {
        let next_status = match decision.trim().to_ascii_lowercase().as_str() {
            "accept" | "accepted" => "accepted",
            "dismiss" | "dismissed" | "reject" => "dismissed",
            other => {
                return Err(DbError::InvalidInput(format!(
                    "invalid proposal decision '{other}': expected accept|dismiss"
                )))
            }
        };
        let now_ms = Utc::now().timestamp_millis();
        self.db.transaction(|conn| {
            let updated = conn.execute(
                "UPDATE improvement_proposals
                 SET status = ?1, note = ?2, decided_at = ?3
                 WHERE project_id = ?4 AND id = ?5",
                rusqlite::params![next_status, note, now_ms, project_id, proposal_id],
            )?;
            if updated == 0 {
                return Err(DbError::InvalidInput(format!(
                    "proposal '{proposal_id}' not found"
                )));
            }
            conn.query_row(
                "SELECT id, project_id, title, rationale, category, diff_hint, status, note, created_at, decided_at
                 FROM improvement_proposals
                 WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![project_id, proposal_id],
                Self::map_proposal,
            )
            .map_err(DbError::from)
        })
    }

    pub fn record_benchmark(
        &self,
        project_id: &str,
        name: &str,
        cases: Vec<BenchmarkCaseResult>,
    ) -> Result<BenchmarkRun> {
        let now_ms = Utc::now().timestamp_millis();
        let id = format!("bench-{}", uuid::Uuid::new_v4().simple());
        let total = cases.len().max(1) as f64;
        let passed = cases.iter().filter(|c| c.passed).count() as f64;
        let pass_rate = if cases.is_empty() {
            0.0
        } else {
            ((passed / total) * 1000.0).round() / 1000.0
        };
        let avg_score = if cases.is_empty() {
            0.0
        } else {
            ((cases.iter().map(|c| c.score).sum::<f64>() / total) * 1000.0).round() / 1000.0
        };
        let avg_latency_ms = if cases.is_empty() {
            0.0
        } else {
            ((cases.iter().map(|c| c.latency_ms).sum::<f64>() / total) * 100.0).round() / 100.0
        };
        let cases_json = serde_json::to_string(&cases)
            .map_err(|e| DbError::InvalidInput(format!("benchmark cases json: {e}")))?;
        let clean_name = if name.trim().is_empty() {
            "Replay Benchmark"
        } else {
            name.trim()
        };

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO benchmark_runs
                    (id, project_id, name, pass_rate, avg_score, avg_latency_ms, cases_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    id,
                    project_id,
                    clean_name,
                    pass_rate,
                    avg_score,
                    avg_latency_ms,
                    cases_json,
                    now_ms,
                ],
            )?;
            Ok::<_, DbError>(BenchmarkRun {
                id,
                project_id: project_id.to_owned(),
                name: clean_name.to_owned(),
                pass_rate,
                avg_score,
                avg_latency_ms,
                cases,
                created_at: format_ts_ms(now_ms),
            })
        })
    }

    pub fn list_benchmarks(&self, project_id: &str) -> Result<Vec<BenchmarkRun>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, name, pass_rate, avg_score, avg_latency_ms, cases_json, created_at
                 FROM benchmark_runs
                 WHERE project_id = ?1
                 ORDER BY created_at DESC, id ASC
                 LIMIT 25",
            )?;
            let rows = stmt.query_map([project_id], |r| {
                let cases_raw: String = r.get(6)?;
                let cases: Vec<BenchmarkCaseResult> =
                    serde_json::from_str(&cases_raw).unwrap_or_default();
                let created_ms: i64 = r.get(7)?;
                Ok(BenchmarkRun {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    name: r.get(2)?,
                    pass_rate: r.get(3)?,
                    avg_score: r.get(4)?,
                    avg_latency_ms: r.get(5)?,
                    cases,
                    created_at: format_ts_ms(created_ms),
                })
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    fn map_proposal(r: &rusqlite::Row<'_>) -> rusqlite::Result<ImprovementProposal> {
        let created_ms: i64 = r.get(8)?;
        let decided_ms: Option<i64> = r.get(9)?;
        Ok(ImprovementProposal {
            id: r.get(0)?,
            project_id: r.get(1)?,
            title: r.get(2)?,
            rationale: r.get(3)?,
            category: r.get(4)?,
            diff_hint: r.get(5)?,
            status: r.get(6)?,
            note: r.get(7)?,
            created_at: format_ts_ms(created_ms),
            decided_at: decided_ms.map(format_ts_ms),
        })
    }
}

/// Repository for vaulted external tool connections (`tool_connections`).
#[derive(Debug, Clone)]
pub struct ConnectionsRepo {
    db: Db,
}

impl ConnectionsRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn upsert(
        &self,
        id: &str,
        kind: &str,
        label: &str,
        endpoint: &str,
        secret_enc: Option<&str>,
    ) -> Result<ToolConnectionSummary> {
        let clean_id = id.trim();
        let valid_id = !clean_id.is_empty()
            && clean_id.len() <= 64
            && clean_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
        if !valid_id {
            return Err(DbError::InvalidInput(
                "connection id must be 1..=64 chars [A-Za-z0-9_-]".into(),
            ));
        }
        let clean_endpoint = endpoint.trim();
        if !(clean_endpoint.starts_with("https://") || clean_endpoint.starts_with("http://")) {
            return Err(DbError::InvalidInput(
                "connection endpoint must start with http:// or https://".into(),
            ));
        }
        let clean_kind = if kind.trim().is_empty() {
            "mcp"
        } else {
            kind.trim()
        };
        let clean_label = if label.trim().is_empty() {
            clean_id
        } else {
            label.trim()
        };
        let now_ms = Utc::now().timestamp_millis();

        self.db.transaction(|conn| {
            let existing_secret: Option<String> = conn
                .query_row(
                    "SELECT secret_enc FROM tool_connections WHERE id = ?1",
                    [clean_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let final_secret = secret_enc.map(str::to_owned).or(existing_secret);
            let has_secret = final_secret.is_some();

            conn.execute(
                "INSERT INTO tool_connections (id, kind, label, endpoint, secret_enc, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    label = excluded.label,
                    endpoint = excluded.endpoint,
                    secret_enc = excluded.secret_enc,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    clean_id,
                    clean_kind,
                    clean_label,
                    clean_endpoint,
                    final_secret,
                    now_ms,
                ],
            )?;
            let created_ms: i64 = conn.query_row(
                "SELECT created_at FROM tool_connections WHERE id = ?1",
                [clean_id],
                |r| r.get(0),
            )?;
            Ok::<_, DbError>(ToolConnectionSummary {
                id: clean_id.to_owned(),
                kind: clean_kind.to_owned(),
                label: clean_label.to_owned(),
                endpoint: clean_endpoint.to_owned(),
                has_secret,
                created_at: format_ts_ms(created_ms),
            })
        })
    }

    pub fn list(&self) -> Result<Vec<ToolConnectionSummary>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, kind, label, endpoint, secret_enc IS NOT NULL, created_at
                 FROM tool_connections
                 ORDER BY created_at DESC, id ASC",
            )?;
            let rows = stmt.query_map([], |r| {
                let created_ms: i64 = r.get(5)?;
                Ok(ToolConnectionSummary {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    label: r.get(2)?,
                    endpoint: r.get(3)?,
                    has_secret: r.get::<_, i64>(4)? != 0,
                    created_at: format_ts_ms(created_ms),
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
            let deleted = conn.execute("DELETE FROM tool_connections WHERE id = ?1", [id])?;
            Ok::<_, DbError>(deleted > 0)
        })
    }
}

/// Repository for server-wide settings persisted in `server_settings` (e.g., Ed25519 license key).
#[derive(Debug, Clone)]
pub struct ServerSettingsRepo {
    db: Db,
}

impl ServerSettingsRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn get(&self, key: &str) -> Result<Option<Value>> {
        self.db.read(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value_json FROM server_settings WHERE key = ?1",
                    [key],
                    |r| r.get(0),
                )
                .optional()?;
            Ok::<_, DbError>(raw.and_then(|s| serde_json::from_str(&s).ok()))
        })
    }

    pub fn set(&self, key: &str, value: &Value) -> Result<()> {
        let now_ms = Utc::now().timestamp_millis();
        let raw = serde_json::to_string(value)
            .map_err(|e| DbError::InvalidInput(format!("setting json: {e}")))?;
        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO server_settings (key, value_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at",
                rusqlite::params![key, raw, now_ms],
            )?;
            Ok::<_, DbError>(())
        })
    }
}
