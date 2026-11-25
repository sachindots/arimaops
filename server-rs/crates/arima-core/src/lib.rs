// SPDX-License-Identifier: AGPL-3.0-or-later

//! Core domain contracts, decision models, preview feedback payloads, outbox items,
//! and WebSocket envelopes shared between the Rust backend (`server-rs/`) and React UI (`src/`).

pub mod auth;
pub mod decision;
pub mod feedback;
pub mod form;
pub mod meeting;
pub mod outbox;
pub mod pack;
pub mod protocol;
pub mod tool_server;

pub use auth::{AuthUser, AuditEntry, DeviceSession, PasskeyInfo, ProjectRole, ServerRole};
pub use decision::{
    DecisionKind, DecisionPayload, DecisionStatus, OpinionSide, PermissionPayload, QuestionAnswer,
    QuestionOption, QuestionPayload, QuestionPrompt, SecondOpinionPayload, VisualDecision,
};
pub use form::{FormAnswer, FormPayload, FormSpec};
pub use feedback::{
    BoundingBox, ConsoleErrorEntry, ElementSelection, FeedbackRoute, PreviewMode, PreviewTarget,
    PreviewTargetStatus, VisualFeedback,
};
pub use meeting::{
    AgentInstruction, MeetingAgendaItem, MeetingKind, MeetingMinutes, MeetingSession,
    MeetingStatus, MeetingTurn, MeetingUrgency, ProposedDecision, ProposedTask, VoiceProvider,
};
pub use outbox::{OutboxMessage, OutboxMessageKind};
pub use pack::{PackAgent, PackApproval, PackChange, PackEntry, PackFileSummary, PackLock, PackScan, PackSkill, PackSource, PackToolServer};
pub use protocol::{WsClientMessage, WsCommandAck, WsServerEvent};
pub use tool_server::{ToolServer, ToolServerCheck, ToolServerSource, ToolServerTransport};
