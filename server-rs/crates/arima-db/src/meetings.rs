// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;

use arima_core::{
    MeetingAgendaItem, MeetingKind, MeetingMinutes, MeetingSession, MeetingStatus, MeetingTurn,
    MeetingUrgency, OutboxMessageKind, VoiceProvider,
};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Db, DbError, Result};

fn kind_as_str(k: MeetingKind) -> &'static str {
    match k {
        MeetingKind::Standup => "standup",
        MeetingKind::Discussion => "discussion",
        MeetingKind::Kickoff => "kickoff",
        MeetingKind::Review => "review",
    }
}

fn parse_kind(s: &str) -> MeetingKind {
    match s {
        "discussion" => MeetingKind::Discussion,
        "kickoff" => MeetingKind::Kickoff,
        "review" => MeetingKind::Review,
        _ => MeetingKind::Standup,
    }
}

fn status_as_str(s: MeetingStatus) -> &'static str {
    match s {
        MeetingStatus::Requested => "requested",
        MeetingStatus::Live => "live",
        MeetingStatus::Paused => "paused",
        MeetingStatus::MinutesReview => "minutes-review",
        MeetingStatus::Closed => "closed",
        MeetingStatus::Declined => "declined",
    }
}

fn parse_status(s: &str) -> MeetingStatus {
    match s {
        "live" => MeetingStatus::Live,
        "paused" => MeetingStatus::Paused,
        "minutes-review" => MeetingStatus::MinutesReview,
        "closed" => MeetingStatus::Closed,
        "declined" => MeetingStatus::Declined,
        _ => MeetingStatus::Requested,
    }
}

fn urgency_as_str(u: MeetingUrgency) -> &'static str {
    match u {
        MeetingUrgency::Low => "low",
        MeetingUrgency::Normal => "normal",
        MeetingUrgency::High => "high",
    }
}

fn parse_urgency(s: &str) -> MeetingUrgency {
    match s {
        "low" => MeetingUrgency::Low,
        "high" => MeetingUrgency::High,
        _ => MeetingUrgency::Normal,
    }
}

fn voice_as_str(v: VoiceProvider) -> &'static str {
    match v {
        VoiceProvider::BrowserWebSpeech => "browser-web-speech",
        VoiceProvider::OpenAi => "open-ai",
        VoiceProvider::Gemini => "gemini",
        VoiceProvider::Off => "off",
    }
}

fn parse_voice(s: &str) -> VoiceProvider {
    match s {
        "open-ai" => VoiceProvider::OpenAi,
        "gemini" => VoiceProvider::Gemini,
        "off" => VoiceProvider::Off,
        _ => VoiceProvider::BrowserWebSpeech,
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

/// Summary returned after an atomic 1-click [`MeetingMinutes`] commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMinutesSummary {
    pub tasks_created: usize,
    pub memories_certified: usize,
    pub instructions_queued: usize,
}

/// SQLite repository for `meetings`, `meeting_turns`, and atomic 1-click minutes commit.
#[derive(Debug, Clone)]
pub struct MeetingsRepo {
    db: Db,
}

impl MeetingsRepo {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Creates or updates a [`MeetingSession`].
    pub fn upsert_session(&self, session: &MeetingSession) -> Result<MeetingSession> {
        let participants_json = serde_json::to_string(&session.participant_ids)
            .map_err(|e| DbError::InvalidInput(format!("participants json: {e}")))?;
        let agenda_json = serde_json::to_string(&session.agenda)
            .map_err(|e| DbError::InvalidInput(format!("agenda json: {e}")))?;
        let minutes_json = session
            .minutes
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| DbError::InvalidInput(format!("minutes json: {e}")))?;
        let created_ms = parse_ts_ms(&session.created_at);
        let started_ms = session.started_at.as_deref().map(parse_ts_ms);
        let closed_ms = session.closed_at.as_deref().map(parse_ts_ms);

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO meetings
                    (id, project_id, kind, status, urgency, title, moderator_id,
                     participant_ids_json, requested_by, voice_enabled, voice_provider,
                     agenda_json, minutes_json, created_at, started_at, closed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    urgency = excluded.urgency,
                    title = excluded.title,
                    participant_ids_json = excluded.participant_ids_json,
                    voice_enabled = excluded.voice_enabled,
                    voice_provider = excluded.voice_provider,
                    agenda_json = excluded.agenda_json,
                    minutes_json = excluded.minutes_json,
                    started_at = excluded.started_at,
                    closed_at = excluded.closed_at",
                rusqlite::params![
                    session.id,
                    session.project_id,
                    kind_as_str(session.kind),
                    status_as_str(session.status),
                    urgency_as_str(session.urgency),
                    session.title,
                    session.moderator_id,
                    participants_json,
                    session.requested_by,
                    i64::from(session.voice_enabled),
                    voice_as_str(session.voice_provider),
                    agenda_json,
                    minutes_json,
                    created_ms,
                    started_ms,
                    closed_ms,
                ],
            )?;
            Ok::<_, DbError>(())
        })?;

        Ok(session.clone())
    }

    /// Loads a [`MeetingSession`] by `id`.
    pub fn get_session(&self, id: &str) -> Result<Option<MeetingSession>> {
        self.db.read(|conn| Self::query_session(conn, id))
    }

    /// Lists all [`MeetingSession`] records for `project_id`, newest first.
    pub fn list_sessions(&self, project_id: &str) -> Result<Vec<MeetingSession>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, kind, status, urgency, title, moderator_id,
                        participant_ids_json, requested_by, voice_enabled, voice_provider,
                        agenda_json, minutes_json, created_at, started_at, closed_at
                 FROM meetings
                 WHERE project_id = ?1
                 ORDER BY created_at DESC, id ASC",
            )?;
            let rows = stmt.query_map([project_id], Self::map_session_row)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Transitions a meeting's status and optional voice settings.
    pub fn update_status(
        &self,
        id: &str,
        status: MeetingStatus,
        voice_enabled: Option<bool>,
        voice_provider: Option<VoiceProvider>,
    ) -> Result<MeetingSession> {
        let now_ms = Utc::now().timestamp_millis();
        let now_iso = format_ts_ms(now_ms);
        self.db.transaction(|conn| {
            let mut session = Self::query_session(conn, id)?.ok_or_else(|| {
                DbError::InvalidInput(format!("meeting '{id}' not found"))
            })?;
            session.status = status;
            if let Some(ve) = voice_enabled {
                session.voice_enabled = ve;
            }
            if let Some(vp) = voice_provider {
                session.voice_provider = vp;
            }
            if matches!(status, MeetingStatus::Live) && session.started_at.is_none() {
                session.started_at = Some(now_iso.clone());
            }
            if matches!(status, MeetingStatus::Closed | MeetingStatus::Declined) {
                session.closed_at = Some(now_iso);
            }
            let started_ms = session.started_at.as_deref().map(parse_ts_ms);
            let closed_ms = session.closed_at.as_deref().map(parse_ts_ms);

            conn.execute(
                "UPDATE meetings
                 SET status = ?1,
                     voice_enabled = ?2,
                     voice_provider = ?3,
                     started_at = ?4,
                     closed_at = ?5
                 WHERE id = ?6",
                rusqlite::params![
                    status_as_str(session.status),
                    i64::from(session.voice_enabled),
                    voice_as_str(session.voice_provider),
                    started_ms,
                    closed_ms,
                    session.id,
                ],
            )?;
            Ok::<_, DbError>(session)
        })
    }

    /// Saves draft or updated [`MeetingMinutes`] on a meeting session.
    pub fn set_minutes(&self, id: &str, minutes: &MeetingMinutes) -> Result<MeetingSession> {
        let minutes_json = serde_json::to_string(minutes)
            .map_err(|e| DbError::InvalidInput(format!("minutes json: {e}")))?;
        self.db.transaction(|conn| {
            let mut session = Self::query_session(conn, id)?.ok_or_else(|| {
                DbError::InvalidInput(format!("meeting '{id}' not found"))
            })?;
            session.minutes = Some(minutes.clone());
            conn.execute(
                "UPDATE meetings SET minutes_json = ?1 WHERE id = ?2",
                rusqlite::params![minutes_json, id],
            )?;
            Ok::<_, DbError>(session)
        })
    }

    /// Appends an ordered [`MeetingTurn`] to `meeting_turns`.
    pub fn add_turn(&self, project_id: &str, turn: &MeetingTurn) -> Result<MeetingTurn> {
        let created_ms = parse_ts_ms(&turn.created_at);
        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO meeting_turns
                    (id, project_id, meeting_id, speaker_id, speaker_role, kind,
                     body_markdown, decision_id, spoken_text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    turn.id,
                    project_id,
                    turn.meeting_id,
                    turn.speaker_id,
                    turn.speaker_role,
                    turn.kind,
                    turn.body_markdown,
                    turn.decision_id,
                    turn.spoken_text,
                    created_ms,
                ],
            )?;
            Ok::<_, DbError>(turn.clone())
        })
    }

    /// Lists turns for a single meeting in chronological order.
    pub fn list_turns(&self, meeting_id: &str) -> Result<Vec<MeetingTurn>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, meeting_id, speaker_id, speaker_role, kind,
                        body_markdown, decision_id, spoken_text, created_at
                 FROM meeting_turns
                 WHERE meeting_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map([meeting_id], Self::map_turn_row)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok::<_, DbError>(out)
        })
    }

    /// Lists all turns for a project grouped by `meeting_id` (for `OfficeSnapshot.meetingTurns`).
    pub fn list_turns_by_project(
        &self,
        project_id: &str,
    ) -> Result<HashMap<String, Vec<MeetingTurn>>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, meeting_id, speaker_id, speaker_role, kind,
                        body_markdown, decision_id, spoken_text, created_at
                 FROM meeting_turns
                 WHERE project_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map([project_id], Self::map_turn_row)?;
            let mut map: HashMap<String, Vec<MeetingTurn>> = HashMap::new();
            for r in rows {
                let turn = r?;
                map.entry(turn.meeting_id.clone()).or_default().push(turn);
            }
            Ok::<_, DbError>(map)
        })
    }

    /// Atomically commits [`MeetingMinutes`] inside a single SQLite `SAVEPOINT` transaction:
    /// 1. Approved [`ProposedTask`] items -> `tasks` + `task_events` (ensuring target board exists)
    /// 2. Approved [`ProposedDecision`] items (`save_to_memory`) -> certified `memories` + `memory_fts`
    /// 3. Approved [`AgentInstruction`] items -> `agent_outbox` under `epoch`
    /// 4. Marks `minutes.committed_at` and transitions the meeting to [`MeetingStatus::Closed`].
    pub fn commit_minutes(
        &self,
        meeting_id: &str,
        epoch: i64,
        override_minutes: Option<MeetingMinutes>,
    ) -> Result<(MeetingSession, CommitMinutesSummary)> {
        let now_ms = Utc::now().timestamp_millis();
        let now_iso = format_ts_ms(now_ms);

        self.db.transaction(|conn| {
            let mut session = Self::query_session(conn, meeting_id)?.ok_or_else(|| {
                DbError::InvalidInput(format!("meeting '{meeting_id}' not found"))
            })?;

            let mut minutes = override_minutes
                .or_else(|| session.minutes.clone())
                .ok_or_else(|| {
                    DbError::InvalidInput(format!(
                        "meeting '{meeting_id}' has no minutes to commit"
                    ))
                })?;

            if minutes.committed_at.is_some() {
                return Err(DbError::InvalidInput(format!(
                    "meeting '{meeting_id}' minutes have already been committed"
                )));
            }

            let mut tasks_created = 0usize;
            for task in &minutes.proposed_tasks {
                if !task.approved {
                    continue;
                }
                let board_id = task
                    .board_id
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("B1");

                conn.execute(
                    "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                     VALUES (?1, ?2, 'Main Board', 'active', ?3, ?3)",
                    rusqlite::params![board_id, session.project_id, now_ms],
                )?;

                let stage_id = task
                    .stage_id
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("build");
                let task_id = if task.id.trim().is_empty() {
                    format!("T-{}", uuid::Uuid::new_v4().simple())
                } else {
                    task.id.clone()
                };
                let data_json = json!({
                    "description": task.description,
                    "sourceMeetingId": session.id,
                })
                .to_string();

                conn.execute(
                    "INSERT INTO tasks
                        (id, project_id, board_id, goal_id, stage_id, status, title, owner_id, data_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, NULL, ?4, 'todo', ?5, ?6, ?7, ?8, ?8)
                     ON CONFLICT(project_id, id) DO UPDATE SET
                        title = excluded.title,
                        owner_id = excluded.owner_id,
                        stage_id = excluded.stage_id,
                        data_json = excluded.data_json,
                        updated_at = excluded.updated_at",
                    rusqlite::params![
                        task_id,
                        session.project_id,
                        board_id,
                        stage_id,
                        task.title,
                        task.assignee_id,
                        data_json,
                        now_ms,
                    ],
                )?;

                conn.execute(
                    "INSERT INTO task_events (project_id, task_id, status, stage_id, owner_id, at)
                     VALUES (?1, ?2, 'todo', ?3, ?4, ?5)",
                    rusqlite::params![
                        session.project_id,
                        task_id,
                        stage_id,
                        task.assignee_id,
                        now_ms,
                    ],
                )?;
                tasks_created += 1;
            }

            let mut memories_certified = 0usize;
            for dec in &minutes.decisions {
                if !dec.save_to_memory {
                    continue;
                }
                let mem_id = if dec.id.trim().is_empty() {
                    format!("mem-{}", uuid::Uuid::new_v4().simple())
                } else {
                    dec.id.clone()
                };
                let text = format!("{}: {}", dec.title.trim(), dec.rationale.trim());
                conn.execute(
                    "INSERT INTO memories (id, project_id, mem_type, text, certified, created_at, last_used_at)
                     VALUES (?1, ?2, 'Decision', ?3, 1, ?4, ?4)
                     ON CONFLICT(project_id, id) DO UPDATE SET
                        text = excluded.text,
                        certified = 1,
                        last_used_at = excluded.last_used_at",
                    rusqlite::params![mem_id, session.project_id, text, now_ms],
                )?;
                conn.execute(
                    "DELETE FROM memory_fts WHERE project_id = ?1 AND id = ?2",
                    rusqlite::params![session.project_id, mem_id],
                )?;
                conn.execute(
                    "INSERT INTO memory_fts (id, project_id, text) VALUES (?1, ?2, ?3)",
                    rusqlite::params![mem_id, session.project_id, text],
                )?;
                conn.execute(
                    "INSERT OR IGNORE INTO memory_about (project_id, memory_id, about)
                     VALUES (?1, ?2, 'meeting')",
                    rusqlite::params![session.project_id, mem_id],
                )?;
                memories_certified += 1;
            }

            let mut instructions_queued = 0usize;
            for inst in &minutes.agent_instructions {
                if !inst.approved || inst.agent_id.trim().is_empty() {
                    continue;
                }
                let next_seq: i64 = conn.query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1
                     FROM agent_outbox
                     WHERE project_id = ?1 AND agent_id = ?2 AND epoch = ?3",
                    rusqlite::params![session.project_id, inst.agent_id, epoch],
                    |r| r.get(0),
                )?;
                let payload_json = json!({
                    "source": "meeting-minutes",
                    "meetingId": session.id,
                    "meetingTitle": session.title,
                    "instruction": inst.instruction,
                })
                .to_string();
                conn.execute(
                    "INSERT INTO agent_outbox
                        (project_id, agent_id, epoch, seq, kind, payload_json, created_at, acked_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                    rusqlite::params![
                        session.project_id,
                        inst.agent_id,
                        epoch,
                        next_seq,
                        OutboxMessageKind::Text.as_str(),
                        payload_json,
                        now_ms,
                    ],
                )?;
                instructions_queued += 1;
            }

            minutes.committed_at = Some(now_iso.clone());
            session.minutes = Some(minutes.clone());
            session.status = MeetingStatus::Closed;
            session.closed_at = Some(now_iso);

            let minutes_json = serde_json::to_string(&minutes)
                .map_err(|e| DbError::InvalidInput(format!("minutes json: {e}")))?;

            conn.execute(
                "UPDATE meetings
                 SET status = 'closed',
                     minutes_json = ?1,
                     closed_at = ?2
                 WHERE id = ?3",
                rusqlite::params![minutes_json, now_ms, session.id],
            )?;

            Ok::<_, DbError>((
                session,
                CommitMinutesSummary {
                    tasks_created,
                    memories_certified,
                    instructions_queued,
                },
            ))
        })
    }

    fn query_session(conn: &rusqlite::Connection, id: &str) -> Result<Option<MeetingSession>> {
        conn.query_row(
            "SELECT id, project_id, kind, status, urgency, title, moderator_id,
                    participant_ids_json, requested_by, voice_enabled, voice_provider,
                    agenda_json, minutes_json, created_at, started_at, closed_at
             FROM meetings
             WHERE id = ?1",
            [id],
            Self::map_session_row,
        )
        .optional()
        .map_err(DbError::from)
    }

    fn map_session_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingSession> {
        let kind_raw: String = r.get(2)?;
        let status_raw: String = r.get(3)?;
        let urgency_raw: String = r.get(4)?;
        let participants_raw: String = r.get(7)?;
        let voice_raw: String = r.get(10)?;
        let agenda_raw: String = r.get(11)?;
        let minutes_raw: Option<String> = r.get(12)?;
        let created_ms: i64 = r.get(13)?;
        let started_ms: Option<i64> = r.get(14)?;
        let closed_ms: Option<i64> = r.get(15)?;

        let participant_ids: Vec<String> =
            serde_json::from_str(&participants_raw).unwrap_or_default();
        let agenda: Vec<MeetingAgendaItem> =
            serde_json::from_str(&agenda_raw).unwrap_or_default();
        let minutes: Option<MeetingMinutes> = minutes_raw
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(MeetingSession {
            id: r.get(0)?,
            project_id: r.get(1)?,
            kind: parse_kind(&kind_raw),
            status: parse_status(&status_raw),
            urgency: parse_urgency(&urgency_raw),
            title: r.get(5)?,
            moderator_id: r.get(6)?,
            participant_ids,
            requested_by: r.get(8)?,
            voice_enabled: r.get::<_, i64>(9)? != 0,
            voice_provider: parse_voice(&voice_raw),
            agenda,
            minutes,
            created_at: format_ts_ms(created_ms),
            started_at: started_ms.map(format_ts_ms),
            closed_at: closed_ms.map(format_ts_ms),
        })
    }

    fn map_turn_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingTurn> {
        let created_ms: i64 = r.get(8)?;
        Ok(MeetingTurn {
            id: r.get(0)?,
            meeting_id: r.get(1)?,
            speaker_id: r.get(2)?,
            speaker_role: r.get(3)?,
            kind: r.get(4)?,
            body_markdown: r.get(5)?,
            decision_id: r.get(6)?,
            spoken_text: r.get(7)?,
            created_at: format_ts_ms(created_ms),
        })
    }
}
