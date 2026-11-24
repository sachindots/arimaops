// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::form::FormPayload;
use crate::meeting::{MeetingKind, MeetingUrgency};
use crate::pack::{PackChange, PackFileSummary};

/// Lifecycle state of a visual decision shown in Inbox and inline Chat.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionStatus {
    Open,
    Resolved,
    Dismissed,
}

/// Exhaustive classification of agent-to-user visual decisions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionKind {
    Question,
    SecondOpinion,
    Disagreement,
    Permission,
    MeetingRequest,
    MemoryReview,
    SkillScan,
    PackReview,
    Info,
    Form,
}

/// One selectable option inside a structured `ask_user` prompt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub recommended: bool,
}

/// A single structured question asked by an agent (single-select or multi-select).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPrompt {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub allow_other: bool,
    pub options: Vec<QuestionOption>,
}

/// User's visual answer to one `QuestionPrompt`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
    #[serde(default)]
    pub other_text: Option<String>,
}

/// Payload for structured multi-choice `ask_user` cards.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPayload {
    pub questions: Vec<QuestionPrompt>,
    #[serde(default)]
    pub answers: Vec<QuestionAnswer>,
}

/// One position in a second-opinion review or agent-vs-agent disagreement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpinionSide {
    pub label: String,
    pub author_id: String,
    pub summary: String,
    pub rationale_markdown: String,
    #[serde(default)]
    pub risks: Vec<String>,
}

/// Payload for side-by-side Second-Opinion and escalated Disagreement cards.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecondOpinionPayload {
    pub task_id: Option<String>,
    pub gate_id: Option<String>,
    pub recommendation: Option<String>,
    pub confidence: Option<String>,
    pub option_a: OpinionSide,
    pub option_b: OpinionSide,
    pub can_waive_gate: bool,
    pub chosen_side: Option<String>,
}

/// Payload for visual CLI / `--permission-prompt-tool` / trust prompts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPayload {
    pub tool_name: String,
    pub command_or_path: String,
    pub reason: String,
    pub scope_hint: Option<String>,
    pub resolution: Option<String>,
}

/// Discriminated union carrying kind-specific metadata for any visual decision card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DecisionPayload {
    Question(QuestionPayload),
    SecondOpinion(SecondOpinionPayload),
    Disagreement(SecondOpinionPayload),
    Permission(PermissionPayload),
    MeetingRequest {
        #[serde(rename = "meetingId")]
        meeting_id: String,
        #[serde(rename = "meetingKind")]
        meeting_kind: MeetingKind,
        urgency: MeetingUrgency,
        #[serde(rename = "participantIds")]
        participant_ids: Vec<String>,
        #[serde(rename = "agendaPreview")]
        agenda_preview: Vec<String>,
    },
    MemoryReview {
        memories: Value,
    },
    SkillScan {
        pack: String,
        findings: Vec<String>,
    },
    /// A pack to install, or a change to an installed one (new commit or a server's live tool list).
    PackReview {
        pack: String,
        /// The approved commit; none on first install.
        from: Option<String>,
        to: String,
        /// Tree hash of the approved pack; none on first install. Used to fetch collapsed file diffs on demand.
        #[serde(default, rename = "fromTree")]
        from_tree: Option<String>,
        /// Tree hash of the pack under review. Used to fetch collapsed file diffs on demand.
        #[serde(default, rename = "toTree")]
        to_tree: String,
        changed: Vec<PackChange>,
        /// Changed shipped files other than SKILL.md and agents/*.md, shown collapsed.
        #[serde(default, rename = "otherFiles")]
        other_files: Vec<PackFileSummary>,
        egress: Vec<String>,
        secrets: Vec<String>,
        ignored: Vec<String>,
        /// Scan findings, blocking ones first.
        findings: Vec<String>,
        /// The roles that get the pack's skills on approval: the default when the card is filed, then the owner's
        /// answer (a `roles` question answer).
        #[serde(default)]
        roles: Vec<String>,
    },
    Info {
        markdown: String,
    },
    /// An agent form: a checked component list the Inbox renders, and the owner's answer.
    Form(FormPayload),
}

/// Unified decision record rendered in Inbox and inline inside Chat threads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct VisualDecision {
    pub id: String,
    pub project_id: String,
    pub from_id: String,
    pub task_id: Option<String>,
    pub title: String,
    pub details: String,
    pub waiting: bool,
    pub owner_only: bool,
    pub status: DecisionStatus,
    pub payload: DecisionPayload,
    pub note: Option<String>,
    pub created_at: String,
    pub closed_at: Option<String>,
}
