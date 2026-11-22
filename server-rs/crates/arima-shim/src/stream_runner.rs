// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::{Path, PathBuf};

use arima_core::OutboxMessage;
use arima_db::OutboxRepo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::{ShimCursorState, ShimStateStore};
use crate::{Result, ShimError};

/// Structured `stream-json` envelope delivered to the child agent CLI over stdin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamJsonEnvelope {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub project_id: String,
    pub agent_id: String,
    pub epoch: i64,
    pub seq: i64,
    pub kind: String,
    pub payload: Value,
}

impl StreamJsonEnvelope {
    /// Converts a durable [`OutboxMessage`] into a `stream-json` input envelope.
    #[must_use]
    pub fn from_outbox(msg: &OutboxMessage) -> Self {
        let payload = serde_json::from_str::<Value>(&msg.payload_json)
            .unwrap_or_else(|_| json!({ "raw": msg.payload_json }));
        Self {
            msg_type: "user".into(),
            project_id: msg.project_id.clone(),
            agent_id: msg.agent_id.clone(),
            epoch: msg.epoch,
            seq: msg.seq,
            kind: msg.kind.as_str().into(),
            payload,
        }
    }

    /// Formats the envelope as a single newline-delimited `stream-json` line.
    pub fn to_jsonl_line(&self) -> Result<String> {
        let mut s = serde_json::to_string(self)?;
        s.push('\n');
        Ok(s)
    }
}

/// Crash-safe `stream-json` protocol runner that persists `(epoch, seq, ack)` atomically
/// to disk and resets stale `ack` cursors whenever HQ restarts with a higher `epoch`.
#[derive(Debug)]
pub struct StreamJsonRunner {
    project_id: String,
    agent_id: String,
    state_path: PathBuf,
    cursor: ShimCursorState,
}

impl StreamJsonRunner {
    /// Loads existing cursor state from `state_path` (or initializes `(epoch=0, ack=0)`).
    pub fn open(
        project_id: impl Into<String>,
        agent_id: impl Into<String>,
        state_path: impl AsRef<Path>,
    ) -> Result<Self> {
        let path = state_path.as_ref().to_path_buf();
        let cursor = ShimStateStore::load_or_default(&path)?;
        Ok(Self {
            project_id: project_id.into(),
            agent_id: agent_id.into(),
            state_path: path,
            cursor,
        })
    }

    #[must_use]
    pub fn cursor(&self) -> &ShimCursorState {
        &self.cursor
    }

    /// Reconciles against HQ's current `server_epoch` and atomically saves the reset cursor
    /// if `server_epoch > self.cursor.epoch`.
    pub fn notify_server_epoch(&mut self, server_epoch: i64) -> Result<bool> {
        if self.cursor.reconcile_server_epoch(server_epoch) {
            ShimStateStore::save_atomic(&self.state_path, &self.cursor)?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Drains all currently pending messages for `(project_id, agent_id)` from `outbox` under
    /// `server_epoch`, invoking `deliver_fn` for each message BEFORE advancing and persisting `ack`.
    ///
    /// Guarantees at-least-once delivery across HQ crashes/epoch bumps and zero dropped messages
    /// when a surviving shim has a high `ack` from an earlier epoch.
    pub fn drain_pending<F>(
        &mut self,
        outbox: &OutboxRepo,
        server_epoch: i64,
        mut deliver_fn: F,
    ) -> Result<Vec<StreamJsonEnvelope>>
    where
        F: FnMut(&StreamJsonEnvelope) -> std::result::Result<(), String>,
    {
        let mut delivered = Vec::new();

        while let Some(msg) = outbox
            .next_pending(
                &self.project_id,
                &self.agent_id,
                server_epoch,
                self.cursor.epoch,
                self.cursor.ack,
            )
            .map_err(|e| ShimError::Protocol(format!("outbox query failed: {e}")))?
        {
            if msg.epoch > self.cursor.epoch {
                self.cursor.reconcile_server_epoch(msg.epoch);
                ShimStateStore::save_atomic(&self.state_path, &self.cursor)?;
            }

            if !self.cursor.should_deliver(&msg) {
                // Already delivered in the current epoch; advance ack on server in next iteration.
                self.cursor.ack = self.cursor.ack.max(msg.seq);
                continue;
            }

            let env = StreamJsonEnvelope::from_outbox(&msg);
            // Deliver to child process BEFORE marking acknowledged so a crash never loses the message.
            deliver_fn(&env).map_err(ShimError::Protocol)?;

            self.cursor.record_delivered(&msg);
            ShimStateStore::save_atomic(&self.state_path, &self.cursor)?;

            // Confirm the acknowledgement in SQLite outbox immediately after local persistence.
            let _ = outbox
                .next_pending(
                    &self.project_id,
                    &self.agent_id,
                    server_epoch,
                    self.cursor.epoch,
                    self.cursor.ack,
                )
                .map_err(|e| ShimError::Protocol(format!("outbox ack failed: {e}")))?;

            delivered.push(env);
        }

        Ok(delivered)
    }
}
