// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::decision::VisualDecision;
use crate::feedback::{PreviewTarget, VisualFeedback};
use crate::meeting::{MeetingSession, MeetingTurn};

/// Correlated command frame sent from the React UI to HQ over `/ws`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct WsClientMessage {
    pub id: String,
    pub cmd: String,
    pub args: Vec<Value>,
}

/// Direct acknowledgement sent back to the originating client so failed commands never hang silently.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct WsCommandAck {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Real-time server events pushed over `/ws`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[allow(clippy::large_enum_variant)]
pub enum WsServerEvent {
    CommandAck(WsCommandAck),
    DecisionUpdated {
        decision: VisualDecision,
    },
    FeedbackCreated {
        feedback: VisualFeedback,
    },
    PreviewTargets {
        targets: Vec<PreviewTarget>,
    },
    MeetingUpdated {
        meeting: MeetingSession,
    },
    MeetingTurnAdded {
        turn: MeetingTurn,
    },
    AgentStatus {
        #[serde(rename = "agentId")]
        agent_id: String,
        state: String,
        note: Option<String>,
    },
    Error {
        message: String,
    },
}
