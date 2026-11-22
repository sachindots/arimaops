// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_core::{ConsoleErrorEntry, ElementSelection, FeedbackRoute, VisualFeedback};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;

use crate::{Db, DbError, Result};

fn parse_ts_ms(rfc3339: &str) -> i64 {
    DateTime::parse_from_rfc3339(rfc3339)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| Utc::now().timestamp_millis())
}

fn format_ts_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

/// SQLite repository for `visual_feedback` respecting `ON DELETE CASCADE` on `project_id`.
#[derive(Debug, Clone)]
pub struct FeedbackRepo {
    db: Db,
}

impl FeedbackRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Inserts a [`VisualFeedback`] record into `visual_feedback`.
    pub fn insert(&self, fb: &VisualFeedback) -> Result<VisualFeedback> {
        let sel_json = fb
            .selection
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| DbError::InvalidInput(format!("selection json: {e}")))?;
        let errs_json = serde_json::to_string(&fb.console_errors)
            .map_err(|e| DbError::InvalidInput(format!("console_errors json: {e}")))?;
        let route_json = serde_json::to_string(&fb.route)
            .map_err(|e| DbError::InvalidInput(format!("route json: {e}")))?;
        let created_ms = parse_ts_ms(&fb.created_at);

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO visual_feedback
                    (id, project_id, author_user_id, target_id, source_kind, page_url,
                     viewport_width, viewport_height, note, selection_json, console_errors_json,
                     image_path, workspace_rel_dir, route_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                rusqlite::params![
                    fb.id,
                    fb.project_id,
                    fb.author_user_id,
                    fb.target_id,
                    fb.source_kind,
                    fb.page_url,
                    i64::from(fb.viewport_width),
                    i64::from(fb.viewport_height),
                    fb.note,
                    sel_json,
                    errs_json,
                    fb.image_path,
                    fb.workspace_rel_dir,
                    route_json,
                    created_ms,
                ],
            )?;
            Ok::<_, DbError>(())
        })?;

        Ok(fb.clone())
    }

    /// Retrieves a single [`VisualFeedback`] record scoped strictly to `project_id`.
    pub fn get(&self, project_id: &str, id: &str) -> Result<Option<VisualFeedback>> {
        self.db.read(|conn| {
            conn.query_row(
                "SELECT id, project_id, author_user_id, target_id, source_kind, page_url,
                        viewport_width, viewport_height, note, selection_json, console_errors_json,
                        image_path, workspace_rel_dir, route_json, created_at
                 FROM visual_feedback
                 WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![project_id, id],
                Self::map_row,
            )
            .optional()
            .map_err(DbError::from)
        })
    }

    /// Lists all [`VisualFeedback`] records for `project_id`, newest first.
    pub fn list_by_project(&self, project_id: &str) -> Result<Vec<VisualFeedback>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, author_user_id, target_id, source_kind, page_url,
                        viewport_width, viewport_height, note, selection_json, console_errors_json,
                        image_path, workspace_rel_dir, route_json, created_at
                 FROM visual_feedback
                 WHERE project_id = ?1
                 ORDER BY created_at DESC, rowid DESC",
            )?;
            let rows = stmt.query_map([project_id], Self::map_row)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok::<_, DbError>(out)
        })
    }

    fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<VisualFeedback> {
        let sel_raw: Option<String> = r.get(9)?;
        let errs_raw: String = r.get(10)?;
        let route_raw: String = r.get(13)?;
        let created_ms: i64 = r.get(14)?;

        let selection: Option<ElementSelection> = sel_raw
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok());
        let console_errors: Vec<ConsoleErrorEntry> =
            serde_json::from_str(&errs_raw).unwrap_or_default();
        let route: FeedbackRoute = serde_json::from_str(&route_raw).unwrap_or(
            FeedbackRoute::SendToChat {
                to_agent_id: "lead".into(),
                message_id: None,
            },
        );

        let vw: i64 = r.get(6)?;
        let vh: i64 = r.get(7)?;

        Ok(VisualFeedback {
            id: r.get(0)?,
            project_id: r.get(1)?,
            author_user_id: r.get(2)?,
            target_id: r.get(3)?,
            source_kind: r.get(4)?,
            page_url: r.get(5)?,
            viewport_width: u32::try_from(vw.max(0)).unwrap_or(1440),
            viewport_height: u32::try_from(vh.max(0)).unwrap_or(900),
            note: r.get(8)?,
            selection,
            console_errors,
            image_path: r.get(11)?,
            workspace_rel_dir: r.get(12)?,
            route,
            created_at: format_ts_ms(created_ms),
        })
    }
}
