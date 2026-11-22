// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Category of interactive team meeting or standup session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MeetingKind {
    Standup,
    Discussion,
    Kickoff,
    Review,
}

/// Lifecycle state of a [`MeetingSession`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MeetingStatus {
    Requested,
    Live,
    Paused,
    MinutesReview,
    Closed,
    Declined,
}

/// Priority level requested by an agent or owner when starting a meeting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MeetingUrgency {
    Low,
    Normal,
    High,
}

/// Pluggable voice synthesis / recognition backend used during `"Join Call"` mode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProvider {
    BrowserWebSpeech,
    OpenAi,
    Gemini,
    Off,
}

/// One agenda topic tracked inside a [`MeetingSession`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAgendaItem {
    pub id: String,
    pub title: String,
    pub status: String,
    pub owner_id: Option<String>,
    pub recommendation_decision_id: Option<String>,
}

/// One moderated turn inside a discussion session or standup call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTurn {
    pub id: String,
    pub meeting_id: String,
    pub speaker_id: String,
    pub speaker_role: String,
    pub kind: String,
    pub body_markdown: String,
    pub decision_id: Option<String>,
    pub spoken_text: Option<String>,
    pub created_at: String,
}

/// Proposed Board task surfaced in auto-generated meeting minutes for 1-click commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProposedTask {
    pub id: String,
    pub title: String,
    pub board_id: Option<String>,
    pub assignee_id: Option<String>,
    pub stage_id: Option<String>,
    pub description: String,
    #[serde(default)]
    pub approved: bool,
}

/// Proposed decision surfaced in meeting minutes (committed to certified Team Memory).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProposedDecision {
    pub id: String,
    pub title: String,
    pub rationale: String,
    #[serde(default)]
    pub save_to_memory: bool,
}

/// Proposed instruction queued to an agent's `agent_outbox` when meeting minutes commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstruction {
    pub agent_id: String,
    pub instruction: String,
    #[serde(default)]
    pub approved: bool,
}

/// Auto-generated meeting minutes reviewed and committed in one click when ending a meeting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MeetingMinutes {
    pub summary_markdown: String,
    #[serde(default)]
    pub decisions: Vec<ProposedDecision>,
    #[serde(default)]
    pub proposed_tasks: Vec<ProposedTask>,
    #[serde(default)]
    pub agent_instructions: Vec<AgentInstruction>,
    pub committed_at: Option<String>,
}

/// Lead-moderated interactive discussion room or standup call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSession {
    pub id: String,
    pub project_id: String,
    pub kind: MeetingKind,
    pub status: MeetingStatus,
    pub urgency: MeetingUrgency,
    pub title: String,
    pub moderator_id: String,
    #[serde(default)]
    pub participant_ids: Vec<String>,
    pub requested_by: String,
    #[serde(default)]
    pub voice_enabled: bool,
    pub voice_provider: VoiceProvider,
    #[serde(default)]
    pub agenda: Vec<MeetingAgendaItem>,
    pub minutes: Option<MeetingMinutes>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub closed_at: Option<String>,
}
