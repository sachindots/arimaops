// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Kind of persisted message queued in `agent_outbox` for delivery to an agent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum OutboxMessageKind {
    Text,
    Reset,
    DecisionAnswer,
    VisualFeedback,
}

impl OutboxMessageKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Reset => "reset",
            Self::DecisionAnswer => "decision-answer",
            Self::VisualFeedback => "visual-feedback",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "text" => Some(Self::Text),
            "reset" => Some(Self::Reset),
            "decision-answer" => Some(Self::DecisionAnswer),
            "visual-feedback" => Some(Self::VisualFeedback),
            _ => None,
        }
    }
}

/// Durable delivery record keyed by `(project_id, agent_id, epoch, seq)` so HQ restarts never drop messages.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct OutboxMessage {
    pub project_id: String,
    pub agent_id: String,
    #[ts(type = "number")]
    pub epoch: i64,
    #[ts(type = "number")]
    pub seq: i64,
    pub kind: OutboxMessageKind,
    pub payload_json: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub acked_at: Option<i64>,
}
