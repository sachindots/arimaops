// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_core::{
    DecisionPayload, DecisionStatus, FormAnswer, QuestionAnswer, ServerRole, VisualDecision,
};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;

use crate::{Db, DbError, Result};

/// Determines whether a [`VisualDecision`] must be restricted strictly to [`ServerRole::Owner`].
///
/// Prevents the v1 30-minute stall auto-escalation bug and blocks operators from approving
/// owner-only gates, specs, plans, outbound send proposals, memory reviews, spend alerts,
/// or skill scans.
#[must_use]
pub fn classify_owner_only(payload: &DecisionPayload, explicit: bool) -> bool {
    if explicit {
        return true;
    }
    match payload {
        DecisionPayload::SpecApproval { .. }
        | DecisionPayload::PlanApproval { .. }
        | DecisionPayload::GateApproval { .. }
        | DecisionPayload::SendProposal { .. }
        | DecisionPayload::MemoryReview { .. }
        | DecisionPayload::SpendAlert { .. }
        | DecisionPayload::SkillScan { .. }
        | DecisionPayload::PackReview { .. } => true,
        DecisionPayload::SecondOpinion(so) | DecisionPayload::Disagreement(so) => {
            so.can_waive_gate
        }
        DecisionPayload::Question(_)
        | DecisionPayload::Permission(_)
        | DecisionPayload::MeetingRequest { .. }
        | DecisionPayload::OverflowFallback { .. }
        | DecisionPayload::Info { .. }
        | DecisionPayload::Form(_) => false,
    }
}

fn status_as_str(status: DecisionStatus) -> &'static str {
    match status {
        DecisionStatus::Open => "open",
        DecisionStatus::Resolved => "resolved",
        DecisionStatus::Dismissed => "dismissed",
    }
}

fn parse_status(s: &str) -> DecisionStatus {
    match s {
        "resolved" => DecisionStatus::Resolved,
        "dismissed" => DecisionStatus::Dismissed,
        _ => DecisionStatus::Open,
    }
}

fn payload_kind_str(payload: &DecisionPayload) -> &'static str {
    match payload {
        DecisionPayload::Question(_) => "question",
        DecisionPayload::SecondOpinion(_) => "second-opinion",
        DecisionPayload::Disagreement(_) => "disagreement",
        DecisionPayload::Permission(_) => "permission",
        DecisionPayload::MeetingRequest { .. } => "meeting-request",
        DecisionPayload::SpecApproval { .. } => "spec-approval",
        DecisionPayload::PlanApproval { .. } => "plan-approval",
        DecisionPayload::GateApproval { .. } => "gate-approval",
        DecisionPayload::SendProposal { .. } => "send-proposal",
        DecisionPayload::MemoryReview { .. } => "memory-review",
        DecisionPayload::SpendAlert { .. } => "spend-alert",
        DecisionPayload::SkillScan { .. } => "skill-scan",
        DecisionPayload::PackReview { .. } => "pack-review",
        DecisionPayload::OverflowFallback { .. } => "overflow-fallback",
        DecisionPayload::Info { .. } => "info",
        DecisionPayload::Form(_) => "form",
    }
}

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

/// Resolution input applied when a user answers or dismisses a [`VisualDecision`].
#[derive(Debug, Clone, Default)]
pub struct ResolveDecisionInput {
    pub status: Option<DecisionStatus>,
    pub answers: Option<Vec<QuestionAnswer>>,
    pub form_answer: Option<FormAnswer>,
    pub chosen_side: Option<String>,
    pub permission_resolution: Option<String>,
    pub note: Option<String>,
}

/// SQLite repository for `visual_decisions` and `action_answers`.
#[derive(Debug, Clone)]
pub struct DecisionsRepo {
    db: Db,
}

impl DecisionsRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Inserts or updates a [`VisualDecision`], automatically enforcing `owner_only` classification.
    pub fn upsert(&self, decision: &VisualDecision) -> Result<VisualDecision> {
        let mut normalized = decision.clone();
        normalized.owner_only = classify_owner_only(&normalized.payload, normalized.owner_only);
        let payload_json = serde_json::to_string(&normalized.payload)
            .map_err(|e| DbError::InvalidInput(format!("invalid decision payload: {e}")))?;
        let created_ms = parse_ts_ms(&normalized.created_at);
        let closed_ms = normalized.closed_at.as_deref().map(parse_ts_ms);

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO visual_decisions
                    (id, project_id, from_id, task_id, title, details, waiting, owner_only, status, payload_json, note, created_at, closed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    details = excluded.details,
                    waiting = excluded.waiting,
                    owner_only = excluded.owner_only,
                    status = excluded.status,
                    payload_json = excluded.payload_json,
                    note = excluded.note,
                    closed_at = excluded.closed_at",
                rusqlite::params![
                    normalized.id,
                    normalized.project_id,
                    normalized.from_id,
                    normalized.task_id,
                    normalized.title,
                    normalized.details,
                    i64::from(normalized.waiting),
                    i64::from(normalized.owner_only),
                    status_as_str(normalized.status),
                    payload_json,
                    normalized.note,
                    created_ms,
                    closed_ms,
                ],
            )?;
            Ok::<_, DbError>(())
        })?;

        Ok(normalized)
    }

    /// Loads a single [`VisualDecision`] by `id`.
    pub fn get(&self, id: &str) -> Result<Option<VisualDecision>> {
        self.db.read(|conn| Self::query_one(conn, id))
    }

    /// Lists all [`VisualDecision`] rows for `project_id`, newest first.
    pub fn list_by_project(
        &self,
        project_id: &str,
        status_filter: Option<DecisionStatus>,
    ) -> Result<Vec<VisualDecision>> {
        self.db.read(|conn| {
            let mut sql = String::from(
                "SELECT id, project_id, from_id, task_id, title, details, waiting, owner_only,
                        status, payload_json, note, created_at, closed_at
                 FROM visual_decisions
                 WHERE project_id = ?1",
            );
            if status_filter.is_some() {
                sql.push_str(" AND status = ?2");
            }
            sql.push_str(" ORDER BY created_at DESC, id ASC");

            let mut stmt = conn.prepare(&sql)?;
            let mut out = Vec::new();
            if let Some(st) = status_filter {
                let rows = stmt.query_map(
                    rusqlite::params![project_id, status_as_str(st)],
                    Self::map_row,
                )?;
                for r in rows {
                    out.push(r?);
                }
            } else {
                let rows = stmt.query_map([project_id], Self::map_row)?;
                for r in rows {
                    out.push(r?);
                }
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Returns stalled open decisions eligible for Lead escalation (strictly excluding `owner_only = 1`).
    pub fn list_escalatable_stalled(
        &self,
        project_id: &str,
        older_than_ms: i64,
    ) -> Result<Vec<VisualDecision>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, from_id, task_id, title, details, waiting, owner_only,
                        status, payload_json, note, created_at, closed_at
                 FROM visual_decisions
                 WHERE project_id = ?1
                   AND status = 'open'
                   AND owner_only = 0
                   AND created_at <= ?2
                 ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_id, older_than_ms], Self::map_row)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Resolves or dismisses a [`VisualDecision`] inside a `SAVEPOINT` transaction, enforcing
    /// viewer read-only and `owner_only` RBAC invariants.
    pub fn resolve(
        &self,
        id: &str,
        input: ResolveDecisionInput,
        actor_role: ServerRole,
    ) -> Result<VisualDecision> {
        if matches!(actor_role, ServerRole::Viewer) {
            return Err(DbError::InvalidInput(
                "viewer role is strictly read-only and cannot resolve decisions".into(),
            ));
        }

        let now_ms = Utc::now().timestamp_millis();
        let now_iso = format_ts_ms(now_ms);

        self.db.transaction(|conn| {
            let mut dec = Self::query_one(conn, id)?.ok_or_else(|| {
                DbError::InvalidInput(format!("visual decision '{id}' not found"))
            })?;

            if dec.owner_only && !matches!(actor_role, ServerRole::Owner) {
                return Err(DbError::InvalidInput(
                    "this approval or decision is restricted to the owner".into(),
                ));
            }

            match &mut dec.payload {
                DecisionPayload::Question(q) => {
                    if let Some(ans) = input.answers {
                        q.answers = ans;
                    }
                }
                DecisionPayload::Form(f) => {
                    if let Some(ans) = input.form_answer {
                        f.answer = Some(ans);
                    }
                }
                DecisionPayload::SecondOpinion(so) | DecisionPayload::Disagreement(so) => {
                    if let Some(ref side) = input.chosen_side {
                        let is_waive = side.eq_ignore_ascii_case("waive-gate")
                            || side.eq_ignore_ascii_case("waivegate")
                            || side.eq_ignore_ascii_case("waive");
                        if is_waive && !matches!(actor_role, ServerRole::Owner) {
                            return Err(DbError::InvalidInput(
                                "waiving a gate requires the owner role".into(),
                            ));
                        }
                        so.chosen_side = Some(side.clone());
                    }
                }
                DecisionPayload::PackReview { roles, .. } => {
                    if let Some(a) = input.answers.and_then(|a| a.into_iter().find(|a| a.question_id == "roles")) {
                        *roles = a.selected_option_ids;
                    }
                }
                DecisionPayload::Permission(perm) => {
                    if let Some(res) = input.permission_resolution {
                        perm.resolution = Some(res);
                    }
                }
                _ => {}
            }

            let new_status = input.status.unwrap_or(DecisionStatus::Resolved);
            dec.status = new_status;
            dec.waiting = false;
            if input.note.is_some() {
                dec.note = input.note;
            }
            dec.closed_at = Some(now_iso);

            let payload_json = serde_json::to_string(&dec.payload)
                .map_err(|e| DbError::InvalidInput(format!("serialize payload: {e}")))?;

            conn.execute(
                "UPDATE visual_decisions
                 SET status = ?1,
                     waiting = 0,
                     payload_json = ?2,
                     note = ?3,
                     closed_at = ?4
                 WHERE id = ?5",
                rusqlite::params![
                    status_as_str(dec.status),
                    payload_json,
                    dec.note,
                    now_ms,
                    dec.id,
                ],
            )?;

            let kind_str = payload_kind_str(&dec.payload);
            let decision_str = match dec.status {
                DecisionStatus::Resolved => "done",
                DecisionStatus::Dismissed => "dismissed",
                DecisionStatus::Open => "open",
            };
            conn.execute(
                "INSERT INTO action_answers (project_id, id, kind, decision, at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    decision = excluded.decision,
                    at = excluded.at",
                rusqlite::params![dec.project_id, dec.id, kind_str, decision_str, now_ms],
            )?;

            Ok::<_, DbError>(dec)
        })
    }

    fn query_one(conn: &rusqlite::Connection, id: &str) -> Result<Option<VisualDecision>> {
        conn.query_row(
            "SELECT id, project_id, from_id, task_id, title, details, waiting, owner_only,
                    status, payload_json, note, created_at, closed_at
             FROM visual_decisions
             WHERE id = ?1",
            [id],
            Self::map_row,
        )
        .optional()
        .map_err(DbError::from)
    }

    fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<VisualDecision> {
        let status_raw: String = r.get(8)?;
        let payload_raw: String = r.get(9)?;
        let created_ms: i64 = r.get(11)?;
        let closed_ms: Option<i64> = r.get(12)?;

        let payload: DecisionPayload = serde_json::from_str(&payload_raw).unwrap_or(
            DecisionPayload::Info {
                markdown: payload_raw,
            },
        );
        let explicit_owner = r.get::<_, i64>(7)? != 0;
        let owner_only = classify_owner_only(&payload, explicit_owner);

        Ok(VisualDecision {
            id: r.get(0)?,
            project_id: r.get(1)?,
            from_id: r.get(2)?,
            task_id: r.get(3)?,
            title: r.get(4)?,
            details: r.get(5)?,
            waiting: r.get::<_, i64>(6)? != 0,
            owner_only,
            status: parse_status(&status_raw),
            payload,
            note: r.get(10)?,
            created_at: format_ts_ms(created_ms),
            closed_at: closed_ms.map(format_ts_ms),
        })
    }
}
