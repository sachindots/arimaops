// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use arima_core::{
    AgentInstruction, DecisionPayload, DecisionStatus, MeetingAgendaItem, MeetingKind,
    MeetingMinutes, MeetingSession, MeetingStatus, MeetingTurn, MeetingUrgency, ProposedDecision,
    ProposedTask, ServerRole, VisualDecision, VoiceProvider, WsServerEvent,
};
use arima_db::{CommitMinutesSummary, ResolveDecisionInput};
use chrono::Utc;

use crate::state::AppState;

/// Parameters for creating or launching a [`MeetingSession`].
#[derive(Debug, Clone)]
pub struct StartMeetingInput {
    pub project_id: String,
    pub kind: MeetingKind,
    pub title: String,
    pub urgency: MeetingUrgency,
    pub moderator_id: String,
    pub participant_ids: Vec<String>,
    pub requested_by: String,
    pub agenda_titles: Vec<String>,
    pub voice_enabled: bool,
    pub voice_provider: VoiceProvider,
}

/// Creates a new [`MeetingSession`].
///
/// - When `immediate_live == true` (user started a meeting from the UI): starts in [`MeetingStatus::Live`],
///   appends the Lead moderator's opening turn, prepares initial committable [`MeetingMinutes`],
///   and broadcasts `MeetingUpdated` + `MeetingTurnAdded`.
/// - When `immediate_live == false` (agent called MCP `request_meeting`): starts in [`MeetingStatus::Requested`],
///   creates an Inbox/Home [`DecisionPayload::MeetingRequest`] card, and broadcasts `MeetingUpdated` + `DecisionUpdated`.
pub fn start_or_request_meeting(
    state: &AppState,
    input: StartMeetingInput,
    immediate_live: bool,
) -> Result<(MeetingSession, Option<MeetingTurn>, Option<VisualDecision>), String> {
    let now_iso = Utc::now().to_rfc3339();
    let meeting_id = format!("mtg-{}", uuid::Uuid::new_v4().simple());

    let moderator_id = if input.moderator_id.trim().is_empty() {
        "lead".into()
    } else {
        input.moderator_id.clone()
    };

    let mut participants = input.participant_ids.clone();
    if !participants.iter().any(|p| p == &moderator_id) {
        participants.insert(0, moderator_id.clone());
    }

    let agenda_titles = if input.agenda_titles.is_empty() {
        vec![
            "Progress & current blockers".into(),
            "Key decisions & task assignments".into(),
        ]
    } else {
        input.agenda_titles.clone()
    };

    let agenda: Vec<MeetingAgendaItem> = agenda_titles
        .iter()
        .enumerate()
        .map(|(idx, t)| MeetingAgendaItem {
            id: format!("ag-{}", idx + 1),
            title: t.clone(),
            status: if idx == 0 && immediate_live {
                "active".into()
            } else {
                "pending".into()
            },
            owner_id: Some(moderator_id.clone()),
            recommendation_decision_id: None,
        })
        .collect();

    let status = if immediate_live {
        MeetingStatus::Live
    } else {
        MeetingStatus::Requested
    };

    let initial_minutes = Some(synthesize_minutes(&input.title, &participants, &agenda, &[]));

    let session = MeetingSession {
        id: meeting_id.clone(),
        project_id: input.project_id.clone(),
        kind: input.kind,
        status,
        urgency: input.urgency,
        title: input.title.clone(),
        moderator_id: moderator_id.clone(),
        participant_ids: participants.clone(),
        requested_by: input.requested_by.clone(),
        voice_enabled: input.voice_enabled,
        voice_provider: input.voice_provider,
        agenda: agenda.clone(),
        minutes: initial_minutes,
        created_at: now_iso.clone(),
        started_at: if immediate_live {
            Some(now_iso.clone())
        } else {
            None
        },
        closed_at: None,
    };

    state
        .inner
        .meetings
        .upsert_session(&session)
        .map_err(|e| e.to_string())?;

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::MeetingUpdated {
            meeting: session.clone(),
        });

    if immediate_live {
        let agenda_bullets = agenda_titles
            .iter()
            .map(|a| format!("- {a}"))
            .collect::<Vec<_>>()
            .join("\n");
        let opening_body = format!(
            "Welcome to **{}**. I'll moderate turn-by-turn so we stay focused.\n\n### Agenda\n{}",
            session.title, agenda_bullets
        );
        let turn = MeetingTurn {
            id: format!("turn-{}", uuid::Uuid::new_v4().simple()),
            meeting_id: session.id.clone(),
            speaker_id: moderator_id,
            speaker_role: "Lead".into(),
            kind: "opening".into(),
            body_markdown: opening_body,
            decision_id: None,
            spoken_text: Some(format!(
                "Starting {}. Let's walk through the agenda items in order.",
                session.title
            )),
            created_at: now_iso,
        };
        state
            .inner
            .meetings
            .add_turn(&session.project_id, &turn)
            .map_err(|e| e.to_string())?;
        state
            .inner
            .ws_hub
            .broadcast_event(&WsServerEvent::MeetingTurnAdded {
                turn: turn.clone(),
            });
        Ok((session, Some(turn), None))
    } else {
        let decision = VisualDecision {
            id: format!("dec-mtg-{}", uuid::Uuid::new_v4().simple()),
            project_id: session.project_id.clone(),
            from_id: input.requested_by,
            task_id: None,
            title: format!("Meeting request: {}", session.title),
            details: format!(
                "{} invited {} to discuss {} agenda items.",
                session.moderator_id,
                participants.join(", "),
                agenda_titles.len()
            ),
            waiting: true,
            owner_only: false,
            status: DecisionStatus::Open,
            payload: DecisionPayload::MeetingRequest {
                meeting_id: session.id.clone(),
                meeting_kind: session.kind,
                urgency: session.urgency,
                participant_ids: participants,
                agenda_preview: agenda_titles,
            },
            note: None,
            created_at: now_iso,
            closed_at: None,
        };
        let saved_dec = state
            .inner
            .decisions
            .upsert(&decision)
            .map_err(|e| e.to_string())?;
        state
            .inner
            .ws_hub
            .broadcast_event(&WsServerEvent::DecisionUpdated {
                decision: saved_dec.clone(),
            });
        Ok((session, None, Some(saved_dec)))
    }
}

/// Handles `joinMeeting` actions (`join`, `resume`, `pause`, `snooze`, `decline`, `close`).
pub fn handle_meeting_action(
    state: &AppState,
    meeting_id: &str,
    action: Option<&str>,
    voice_enabled: Option<bool>,
    actor_role: ServerRole,
) -> Result<MeetingSession, String> {
    if matches!(actor_role, ServerRole::Viewer) {
        return Err("viewer role is strictly read-only".into());
    }

    let act = action.unwrap_or("join").trim().to_ascii_lowercase();
    let target_status = match act.as_str() {
        "join" | "resume" | "start" | "live" => MeetingStatus::Live,
        "pause" | "snooze" => MeetingStatus::Paused,
        "decline" => MeetingStatus::Declined,
        "close" | "minutes" | "minutes-review" => MeetingStatus::MinutesReview,
        _ => MeetingStatus::Live,
    };

    let mut session = state
        .inner
        .meetings
        .update_status(meeting_id, target_status, voice_enabled, None)
        .map_err(|e| e.to_string())?;

    // Resolve or dismiss any open MeetingRequest visual decision linked to this meeting.
    if let Ok(decisions) = state
        .inner
        .decisions
        .list_by_project(&session.project_id, Some(DecisionStatus::Open))
    {
        for dec in decisions {
            if let DecisionPayload::MeetingRequest {
                meeting_id: ref mid,
                ..
            } = dec.payload
            {
                if mid == meeting_id {
                    let dec_status = if matches!(target_status, MeetingStatus::Declined) {
                        DecisionStatus::Dismissed
                    } else {
                        DecisionStatus::Resolved
                    };
                    if let Ok(resolved) = state.inner.decisions.resolve(
                        &dec.id,
                        ResolveDecisionInput {
                            status: Some(dec_status),
                            note: Some(format!("meeting {act}")),
                            ..Default::default()
                        },
                        actor_role,
                    ) {
                        state
                            .inner
                            .ws_hub
                            .broadcast_event(&WsServerEvent::DecisionUpdated {
                                decision: resolved,
                            });
                    }
                }
            }
        }
    }

    // If transitioning to Live and there are no turns yet, add Lead opening turn.
    if matches!(target_status, MeetingStatus::Live) {
        let existing_turns = state
            .inner
            .meetings
            .list_turns(meeting_id)
            .unwrap_or_default();
        if existing_turns.is_empty() {
            let turn = MeetingTurn {
                id: format!("turn-{}", uuid::Uuid::new_v4().simple()),
                meeting_id: session.id.clone(),
                speaker_id: session.moderator_id.clone(),
                speaker_role: "Lead".into(),
                kind: "opening".into(),
                body_markdown: format!(
                    "Welcome to **{}**. Let's review our agenda and unblock next steps.",
                    session.title
                ),
                decision_id: None,
                spoken_text: Some(format!("Joined {}. Let's begin.", session.title)),
                created_at: Utc::now().to_rfc3339(),
            };
            if let Ok(saved_turn) = state.inner.meetings.add_turn(&session.project_id, &turn) {
                state
                    .inner
                    .ws_hub
                    .broadcast_event(&WsServerEvent::MeetingTurnAdded { turn: saved_turn });
            }
        }
    }

    // Ensure minutes are refreshed whenever entering Live or MinutesReview.
    if session.minutes.is_none() || matches!(target_status, MeetingStatus::MinutesReview) {
        let turns = state
            .inner
            .meetings
            .list_turns(meeting_id)
            .unwrap_or_default();
        let mins = synthesize_minutes(
            &session.title,
            &session.participant_ids,
            &session.agenda,
            &turns,
        );
        if let Ok(updated) = state.inner.meetings.set_minutes(meeting_id, &mins) {
            session = updated;
        }
    }

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::MeetingUpdated {
            meeting: session.clone(),
        });

    Ok(session)
}

/// Appends a turn to a meeting, refreshes draft [`MeetingMinutes`], and broadcasts WS events.
#[allow(clippy::too_many_arguments)]
pub fn add_turn_and_refresh_minutes(
    state: &AppState,
    meeting_id: &str,
    speaker_id: &str,
    speaker_role: Option<&str>,
    kind: Option<&str>,
    body_markdown: &str,
    decision_id: Option<String>,
    spoken_text: Option<String>,
) -> Result<(MeetingTurn, MeetingSession), String> {
    let session = state
        .inner
        .meetings
        .get_session(meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("meeting '{meeting_id}' not found"))?;

    let role = speaker_role.unwrap_or_else(|| {
        if speaker_id == "you" || speaker_id == "owner" {
            "Owner"
        } else if speaker_id == session.moderator_id {
            "Lead"
        } else {
            "Specialist"
        }
    });

    let turn = MeetingTurn {
        id: format!("turn-{}", uuid::Uuid::new_v4().simple()),
        meeting_id: meeting_id.to_owned(),
        speaker_id: speaker_id.to_owned(),
        speaker_role: role.to_owned(),
        kind: kind.unwrap_or("message").to_owned(),
        body_markdown: body_markdown.to_owned(),
        decision_id,
        spoken_text: spoken_text.or_else(|| Some(body_markdown.chars().take(180).collect())),
        created_at: Utc::now().to_rfc3339(),
    };

    let saved_turn = state
        .inner
        .meetings
        .add_turn(&session.project_id, &turn)
        .map_err(|e| e.to_string())?;

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::MeetingTurnAdded {
            turn: saved_turn.clone(),
        });

    let all_turns = state
        .inner
        .meetings
        .list_turns(meeting_id)
        .unwrap_or_else(|_| vec![saved_turn.clone()]);
    let updated_minutes = synthesize_minutes(
        &session.title,
        &session.participant_ids,
        &session.agenda,
        &all_turns,
    );
    let updated_session = state
        .inner
        .meetings
        .set_minutes(meeting_id, &updated_minutes)
        .map_err(|e| e.to_string())?;

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::MeetingUpdated {
            meeting: updated_session.clone(),
        });

    Ok((saved_turn, updated_session))
}

/// Atomically commits [`MeetingMinutes`] into `tasks`, `memories`, and `agent_outbox` and broadcasts `MeetingUpdated`.
pub fn commit_minutes_and_broadcast(
    state: &AppState,
    meeting_id: &str,
    override_minutes: Option<MeetingMinutes>,
) -> Result<(MeetingSession, CommitMinutesSummary), String> {
    let epoch = state.inner.supervisor.current_epoch();
    let (session, summary) = state
        .inner
        .meetings
        .commit_minutes(meeting_id, epoch, override_minutes)
        .map_err(|e| e.to_string())?;

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::MeetingUpdated {
            meeting: session.clone(),
        });

    Ok((session, summary))
}

/// Synthesizes structured [`MeetingMinutes`] from agenda items and conversation turns.
#[must_use]
pub fn synthesize_minutes(
    title: &str,
    participant_ids: &[String],
    agenda: &[MeetingAgendaItem],
    turns: &[MeetingTurn],
) -> MeetingMinutes {
    let summary_markdown = if turns.is_empty() {
        format!(
            "### {title}\nParticipants: {}\nAgenda topics ready for review.",
            participant_ids.join(", ")
        )
    } else {
        let highlights: Vec<String> = turns
            .iter()
            .take(5)
            .map(|t| format!("- **{}**: {}", t.speaker_id, t.body_markdown.lines().next().unwrap_or("")))
            .collect();
        format!(
            "### {title} — Summary\n{}\n",
            highlights.join("\n")
        )
    };

    let decisions = vec![ProposedDecision {
        id: "dec-1".into(),
        title: format!("Aligned on {title} priorities"),
        rationale: turns
            .last()
            .map(|t| t.body_markdown.clone())
            .unwrap_or_else(|| "Proceed with recommended plan.".into()),
        save_to_memory: true,
    }];

    let assignee = participant_ids
        .iter()
        .find(|p| *p != "you" && *p != "owner")
        .cloned()
        .unwrap_or_else(|| "lead".into());

    let task_title = agenda
        .first()
        .map(|a| format!("Execute: {}", a.title))
        .unwrap_or_else(|| format!("Follow up on {title}"));

    let proposed_tasks = vec![ProposedTask {
        id: "T-MTG-1".into(),
        title: task_title.clone(),
        board_id: Some("B1".into()),
        assignee_id: Some(assignee.clone()),
        stage_id: Some("build".into()),
        description: format!("Action item from meeting '{title}'"),
        approved: true,
    }];

    let agent_instructions = vec![AgentInstruction {
        agent_id: assignee,
        instruction: format!("Proceed with agreed action from '{title}': {task_title}"),
        approved: true,
    }];

    MeetingMinutes {
        summary_markdown,
        decisions,
        proposed_tasks,
        agent_instructions,
        committed_at: None,
    }
}

/// Scheduled `09:00` and `18:00` standup trigger tracker.
#[derive(Debug, Clone, Default)]
pub struct StandupScheduler {
    triggered_slots: Arc<Mutex<HashSet<(String, String, String)>>>,
}

impl StandupScheduler {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Checks whether the `09:00` (morning) or `18:00` (evening) standup window has arrived
    /// and triggers an interactive Standup session once per slot when `has_activity_or_blockers` is true.
    pub fn check_and_trigger(
        &self,
        state: &AppState,
        project_id: &str,
        date_ymd: &str,
        hour: u32,
        minute: u32,
        has_activity_or_blockers: bool,
    ) -> Result<Option<MeetingSession>, String> {
        if !has_activity_or_blockers {
            return Ok(None);
        }
        let slot = match (hour, minute) {
            (9, 0..=14) => "09:00",
            (18, 0..=14) => "18:00",
            _ => return Ok(None),
        };

        let key = (project_id.to_owned(), date_ymd.to_owned(), slot.to_owned());
        {
            let mut guard = self
                .triggered_slots
                .lock()
                .map_err(|_| "standup scheduler lock poisoned".to_owned())?;
            if guard.contains(&key) {
                return Ok(None);
            }
            guard.insert(key);
        }

        let title = if slot == "09:00" {
            "Morning Standup (09:00)"
        } else {
            "Evening Standup (18:00)"
        };

        let (session, _, _) = start_or_request_meeting(
            state,
            StartMeetingInput {
                project_id: project_id.to_owned(),
                kind: MeetingKind::Standup,
                title: title.into(),
                urgency: MeetingUrgency::Normal,
                moderator_id: "lead".into(),
                participant_ids: vec!["lead".into(), "coder".into(), "verifier".into()],
                requested_by: "lead".into(),
                agenda_titles: vec![
                    "Shipped since last standup".into(),
                    "Active blockers & decisions needed".into(),
                    "Next priorities".into(),
                ],
                voice_enabled: false,
                voice_provider: VoiceProvider::BrowserWebSpeech,
            },
            false,
        )?;

        Ok(Some(session))
    }
}
