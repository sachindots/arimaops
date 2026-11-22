// SPDX-License-Identifier: AGPL-3.0-or-later

//! Static container/sandbox agent shim library for ArimaOps v2.0 (Milestone 2):
//! - On-demand PTY/terminal multiplexer (`pty`): buffers scrollback and streams bytes ONLY when `attached_viewers > 0`
//! - `stream-json` runner (`stream_runner`) with atomically persisted `(epoch, seq, ack)` state (`state`)
//! - `--permission-prompt-tool` interceptor (`permission`) emitting structured `PermissionPayload` cards

pub mod permission;
pub mod pty;
pub mod state;
pub mod stream_runner;

use thiserror::Error;

pub use permission::{
    evaluate_stdio_hook_json, PendingPermissionPrompt, PermissionHookRequest,
    PermissionHookResponse, PermissionInterceptor, PermissionVerdict,
};
pub use pty::{validate_safe_argv, PtyControlMessage, PtyMultiplexer, PtyOutboundFrame};
pub use state::{ShimCursorState, ShimStateStore};
pub use stream_runner::{StreamJsonEnvelope, StreamJsonRunner};

#[derive(Debug, Error)]
pub enum ShimError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("security violation: {0}")]
    SecurityViolation(String),
    #[error("protocol error: {0}")]
    Protocol(String),
}

pub type Result<T> = std::result::Result<T, ShimError>;

#[must_use]
pub fn version_string() -> String {
    format!("arima-shim {}", env!("CARGO_PKG_VERSION"))
}
