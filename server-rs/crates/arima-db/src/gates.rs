// SPDX-License-Identifier: AGPL-3.0-or-later

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{Db, DbError, Result};

/// Returns `true` if `gate_id` or `state` represents an owner-only approval or waiver.
#[must_use]
pub fn is_owner_only_gate(gate_id: &str, state: &str, by_id: &str) -> bool {
    let g = gate_id.trim().to_ascii_lowercase();
    let s = state.trim().to_ascii_lowercase();
    let b = by_id.trim().to_ascii_lowercase();
    matches!(g.as_str(), "merge" | "spec" | "plan" | "send" | "owner")
        || matches!(s.as_str(), "waived" | "waive")
        || b == "you"
        || b == "owner"
}

/// Persisted gate transition event (`passed`, `failed`, or `reset`) with unlimited rationale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateEventRecord {
    pub id: i64,
    pub project_id: String,
    pub task_id: String,
    pub gate_id: String,
    pub state: String,
    pub by_id: String,
    pub note: Option<String>,
    pub url: Option<String>,
    pub at: String,
}

/// SQLite repository for `gate_events`.
#[derive(Debug, Clone)]
pub struct GatesRepo {
    db: Db,
}

impl GatesRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Records a gate pass, waive, failure, or reset in `gate_events`.
    ///
    /// Automatically ensures `(project_id, task_id)` exists in `tasks` inside the same
    /// `SAVEPOINT` so foreign-key integrity (`PRAGMA foreign_keys = ON`) is always satisfied.
    #[allow(clippy::too_many_arguments)]
    pub fn record_gate(
        &self,
        project_id: &str,
        task_id: &str,
        gate_id: &str,
        state: &str,
        by_id: &str,
        note: Option<&str>,
        url: Option<&str>,
    ) -> Result<GateEventRecord> {
        let raw_state = state.trim().to_ascii_lowercase();
        let (db_state, effective_note) = match raw_state.as_str() {
            "passed" | "pass" => ("passed", note.map(str::to_owned)),
            "waived" | "waive" => {
                let n = match note {
                    Some(text) if !text.trim().is_empty() => format!("[waived] {text}"),
                    _ => "[waived]".into(),
                };
                ("passed", Some(n))
            }
            "failed" | "fail" => ("failed", note.map(str::to_owned)),
            "reset" => ("reset", note.map(str::to_owned)),
            other => {
                return Err(DbError::InvalidInput(format!(
                    "invalid gate state '{other}': expected passed, waived, failed, or reset"
                )));
            }
        };

        let now_ms = Utc::now().timestamp_millis();
        let now_iso = DateTime::from_timestamp_millis(now_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339();

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                 VALUES ('B1', ?1, 'Main Board', 'active', ?2, ?2)",
                rusqlite::params![project_id, now_ms],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO tasks
                    (id, project_id, board_id, stage_id, status, title, created_at, updated_at)
                 VALUES (?1, ?2, 'B1', 'build', 'doing', ?1, ?3, ?3)",
                rusqlite::params![task_id, project_id, now_ms],
            )?;

            conn.execute(
                "INSERT INTO gate_events (project_id, task_id, gate_id, state, by_id, note, url, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    project_id,
                    task_id,
                    gate_id,
                    db_state,
                    by_id,
                    effective_note,
                    url,
                    now_ms,
                ],
            )?;
            let id = conn.last_insert_rowid();
            Ok::<_, DbError>(GateEventRecord {
                id,
                project_id: project_id.to_owned(),
                task_id: task_id.to_owned(),
                gate_id: gate_id.to_owned(),
                state: db_state.to_owned(),
                by_id: by_id.to_owned(),
                note: effective_note,
                url: url.map(str::to_owned),
                at: now_iso,
            })
        })
    }

    /// Lists all gate events for `(project_id, task_id)` in chronological order.
    pub fn list_for_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Vec<GateEventRecord>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, task_id, gate_id, state, by_id, note, url, at
                 FROM gate_events
                 WHERE project_id = ?1 AND task_id = ?2
                 ORDER BY at ASC, id ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_id, task_id], Self::map_row)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Lists all gate events for `project_id`, newest first.
    pub fn list_for_project(&self, project_id: &str) -> Result<Vec<GateEventRecord>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, task_id, gate_id, state, by_id, note, url, at
                 FROM gate_events
                 WHERE project_id = ?1
                 ORDER BY at DESC, id DESC",
            )?;
            let rows = stmt.query_map([project_id], Self::map_row)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<GateEventRecord> {
        let at_ms: i64 = r.get(8)?;
        let at_iso = DateTime::from_timestamp_millis(at_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339();
        Ok(GateEventRecord {
            id: r.get(0)?,
            project_id: r.get(1)?,
            task_id: r.get(2)?,
            gate_id: r.get(3)?,
            state: r.get(4)?,
            by_id: r.get(5)?,
            note: r.get(6)?,
            url: r.get(7)?,
            at: at_iso,
        })
    }
}
