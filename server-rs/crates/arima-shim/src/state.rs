// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use arima_core::OutboxMessage;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{Result, ShimError};

static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Durable delivery cursor persisted by `arima-shim` across process and HQ restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShimCursorState {
    pub epoch: i64,
    pub ack: i64,
    pub last_seq: i64,
    pub updated_at_ms: i64,
}

impl Default for ShimCursorState {
    fn default() -> Self {
        Self {
            epoch: 0,
            ack: 0,
            last_seq: 0,
            updated_at_ms: Utc::now().timestamp_millis(),
        }
    }
}

impl ShimCursorState {
    /// Reconciles local cursor state when HQ advertises `server_epoch`.
    ///
    /// If HQ restarted and bumped `server_epoch > self.epoch`, the stale `ack` from the old
    /// epoch is reset to `0` so messages `seq 1..=old_ack` in the new epoch are never dropped.
    pub fn reconcile_server_epoch(&mut self, server_epoch: i64) -> bool {
        if server_epoch > self.epoch {
            self.epoch = server_epoch;
            self.ack = 0;
            self.last_seq = 0;
            self.updated_at_ms = Utc::now().timestamp_millis();
            true
        } else {
            false
        }
    }

    /// Checks whether `msg` should be delivered, reconciling epoch bumps automatically.
    #[must_use]
    pub fn should_deliver(&self, msg: &OutboxMessage) -> bool {
        if msg.epoch > self.epoch {
            return msg.seq >= 1;
        }
        if msg.epoch < self.epoch {
            return false;
        }
        msg.seq > self.ack
    }

    /// Marks `msg` as delivered and advances `(epoch, ack, last_seq)`.
    pub fn record_delivered(&mut self, msg: &OutboxMessage) -> bool {
        if msg.epoch > self.epoch {
            self.epoch = msg.epoch;
            self.ack = 0;
            self.last_seq = 0;
        } else if msg.epoch < self.epoch || msg.seq <= self.ack {
            return false;
        }
        self.last_seq = msg.seq;
        self.ack = msg.seq;
        self.updated_at_ms = Utc::now().timestamp_millis();
        true
    }
}

/// Atomic file persistence for [`ShimCursorState`].
pub struct ShimStateStore;

impl ShimStateStore {
    /// Loads [`ShimCursorState`] from `path`, or returns `ShimCursorState::default()` if the file does not exist.
    pub fn load_or_default(path: &Path) -> Result<ShimCursorState> {
        if !path.exists() {
            return Ok(ShimCursorState::default());
        }
        let bytes = fs::read(path)?;
        let state = serde_json::from_slice::<ShimCursorState>(&bytes)?;
        Ok(state)
    }

    /// Atomically persists `state` to `path` via write-to-temp + fsync + rename with `0600` permissions.
    pub fn save_atomic(path: &Path, state: &ShimCursorState) -> Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("shim-state.json");
        let tmp_path = path.with_file_name(format!(".{file_name}.tmp-{pid}-{seq}"));

        let payload = serde_json::to_vec_pretty(state)?;

        {
            #[cfg(unix)]
            let mut file = {
                use std::os::unix::fs::OpenOptionsExt;
                fs::OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .mode(0o600)
                    .open(&tmp_path)?
            };
            #[cfg(not(unix))]
            let mut file = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp_path)?;

            file.write_all(&payload)?;
            file.sync_all()?;
        }

        fs::rename(&tmp_path, path).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            ShimError::Io(e)
        })?;
        Ok(())
    }
}
