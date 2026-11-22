// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::{Result, ShimError};

const DEFAULT_SCROLLBACK_BYTES: usize = 64 * 1024;

const FORBIDDEN_ARGV_PATTERNS: &[&str] = &[
    "--api-key",
    "--apikey",
    "--token",
    "--secret",
    "--password",
    "anthropic_api_key=",
    "openai_api_key=",
    "gemini_api_key=",
    "openrouter_api_key=",
    "bearer ",
    "sk-ant-",
    "sk-proj-",
    "ghp_",
];

/// Validates that a child CLI command uses a direct executable and safe argv array with zero
/// shell interpolation and zero secrets/tokens on argv.
pub fn validate_safe_argv(program: &str, args: &[String]) -> Result<()> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err(ShimError::SecurityViolation(
            "program executable cannot be empty".into(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(ShimError::SecurityViolation(
            "program executable contains NUL byte".into(),
        ));
    }

    for arg in args {
        if arg.contains('\0') {
            return Err(ShimError::SecurityViolation(
                "argument contains NUL byte".into(),
            ));
        }
        let lower = arg.to_ascii_lowercase();
        for pat in FORBIDDEN_ARGV_PATTERNS {
            if lower.contains(pat) {
                return Err(ShimError::SecurityViolation(format!(
                    "refusing to pass secret or token pattern '{pat}' on process argv"
                )));
            }
        }
    }
    Ok(())
}

/// Control messages processed by the on-demand PTY multiplexer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PtyControlMessage {
    Attach {
        #[serde(rename = "viewerId")]
        viewer_id: String,
    },
    Detach {
        #[serde(rename = "viewerId")]
        viewer_id: String,
    },
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
}

/// Outbound terminal frame emitted upstream ONLY when at least one viewer is attached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PtyOutboundFrame {
    TerminalOutput {
        #[serde(rename = "agentId")]
        agent_id: String,
        data: String,
    },
    ViewerCount {
        #[serde(rename = "agentId")]
        agent_id: String,
        viewers: usize,
    },
    ProcessExited {
        #[serde(rename = "agentId")]
        agent_id: String,
        code: Option<i32>,
    },
}

#[derive(Debug)]
struct MultiplexerInner {
    agent_id: String,
    scrollback_cap: usize,
    scrollback: VecDeque<u8>,
    attached_viewers: HashSet<String>,
    dimensions: (u16, u16),
    emitted_frames: usize,
}

/// On-demand terminal/PTY multiplexer that buffers output in a bounded ring buffer and streams
/// bytes upstream ONLY while `attached_viewers > 0`.
#[derive(Debug, Clone)]
pub struct PtyMultiplexer {
    inner: Arc<Mutex<MultiplexerInner>>,
    outbound_tx: mpsc::Sender<PtyOutboundFrame>,
}

impl PtyMultiplexer {
    #[must_use]
    pub fn new(
        agent_id: impl Into<String>,
        scrollback_cap: Option<usize>,
        outbound_tx: mpsc::Sender<PtyOutboundFrame>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MultiplexerInner {
                agent_id: agent_id.into(),
                scrollback_cap: scrollback_cap.unwrap_or(DEFAULT_SCROLLBACK_BYTES).max(256),
                scrollback: VecDeque::new(),
                attached_viewers: HashSet::new(),
                dimensions: (120, 36),
                emitted_frames: 0,
            })),
            outbound_tx,
        }
    }

    /// Number of currently attached terminal viewers.
    #[must_use]
    pub fn attached_viewers(&self) -> usize {
        self.inner
            .lock()
            .map(|g| g.attached_viewers.len())
            .unwrap_or(0)
    }

    /// Total `TerminalOutput` frames emitted upstream so far.
    #[must_use]
    pub fn emitted_output_frames(&self) -> usize {
        self.inner.lock().map(|g| g.emitted_frames).unwrap_or(0)
    }

    /// Snapshot of the bounded scrollback ring buffer as UTF-8 (lossy).
    #[must_use]
    pub fn scrollback_snapshot(&self) -> String {
        let Ok(guard) = self.inner.lock() else {
            return String::new();
        };
        let bytes: Vec<u8> = guard.scrollback.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Current terminal `(cols, rows)`.
    #[must_use]
    pub fn dimensions(&self) -> (u16, u16) {
        self.inner
            .lock()
            .map(|g| g.dimensions)
            .unwrap_or((120, 36))
    }

    /// Applies a viewer control message (`Attach`, `Detach`, `Resize`).
    ///
    /// When the first viewer attaches (`0 -> 1`) and the scrollback ring buffer is non-empty,
    /// immediately flushes the scrollback snapshot to the upstream channel.
    pub fn handle_control(&self, msg: PtyControlMessage) {
        let mut flush_frame = None;
        let mut count_frame = None;

        if let Ok(mut guard) = self.inner.lock() {
            match msg {
                PtyControlMessage::Attach { viewer_id } => {
                    let was_empty = guard.attached_viewers.is_empty();
                    guard.attached_viewers.insert(viewer_id);
                    count_frame = Some(PtyOutboundFrame::ViewerCount {
                        agent_id: guard.agent_id.clone(),
                        viewers: guard.attached_viewers.len(),
                    });
                    if was_empty && !guard.scrollback.is_empty() {
                        let bytes: Vec<u8> = guard.scrollback.iter().copied().collect();
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        guard.emitted_frames += 1;
                        flush_frame = Some(PtyOutboundFrame::TerminalOutput {
                            agent_id: guard.agent_id.clone(),
                            data: text,
                        });
                    }
                }
                PtyControlMessage::Detach { viewer_id } => {
                    guard.attached_viewers.remove(&viewer_id);
                    count_frame = Some(PtyOutboundFrame::ViewerCount {
                        agent_id: guard.agent_id.clone(),
                        viewers: guard.attached_viewers.len(),
                    });
                }
                PtyControlMessage::Resize { cols, rows } => {
                    guard.dimensions = (cols.max(20), rows.max(5));
                }
                PtyControlMessage::Input { .. } => {}
            }
        }

        if let Some(cf) = count_frame {
            let _ = self.outbound_tx.try_send(cf);
        }
        if let Some(ff) = flush_frame {
            let _ = self.outbound_tx.try_send(ff);
        }
    }

    /// Ingests raw output bytes produced by the child process.
    ///
    /// Always appends to the bounded scrollback ring buffer, and emits a [`PtyOutboundFrame::TerminalOutput`]
    /// frame ONLY when `attached_viewers > 0`.
    pub fn ingest_output(&self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let mut frame = None;
        if let Ok(mut guard) = self.inner.lock() {
            for &b in chunk {
                if guard.scrollback.len() >= guard.scrollback_cap {
                    guard.scrollback.pop_front();
                }
                guard.scrollback.push_back(b);
            }
            if !guard.attached_viewers.is_empty() {
                guard.emitted_frames += 1;
                frame = Some(PtyOutboundFrame::TerminalOutput {
                    agent_id: guard.agent_id.clone(),
                    data: String::from_utf8_lossy(chunk).into_owned(),
                });
            }
        }
        if let Some(f) = frame {
            let _ = self.outbound_tx.try_send(f);
        }
    }

    /// Spawns a child CLI process using `tokio::process::Command` with validated argv arrays
    /// (zero shell interpolation, secrets passed only via `env_vars` or `stdin_rx`) and wires
    /// its stdout/stderr through this on-demand multiplexer.
    pub async fn spawn_process(
        &self,
        program: &str,
        args: &[String],
        env_vars: &HashMap<String, String>,
        mut stdin_rx: Option<mpsc::Receiver<Vec<u8>>>,
    ) -> Result<Option<i32>> {
        validate_safe_argv(program, args)?;

        let mut cmd = Command::new(program);
        cmd.args(args)
            .envs(env_vars)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()?;

        if let (Some(mut child_stdin), Some(mut rx)) = (child.stdin.take(), stdin_rx.take()) {
            tokio::spawn(async move {
                while let Some(bytes) = rx.recv().await {
                    if child_stdin.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = child_stdin.flush().await;
                }
            });
        }

        let mux_out = self.clone();
        let stdout_task = child.stdout.take().map(|mut out| {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = out.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    mux_out.ingest_output(&buf[..n]);
                }
            })
        });

        let mux_err = self.clone();
        let stderr_task = child.stderr.take().map(|mut err| {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = err.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    mux_err.ingest_output(&buf[..n]);
                }
            })
        });

        let status = child.wait().await?;
        if let Some(t) = stdout_task {
            let _ = t.await;
        }
        if let Some(t) = stderr_task {
            let _ = t.await;
        }

        let agent_id = self
            .inner
            .lock()
            .map(|g| g.agent_id.clone())
            .unwrap_or_default();
        let _ = self.outbound_tx.try_send(PtyOutboundFrame::ProcessExited {
            agent_id,
            code: status.code(),
        });

        Ok(status.code())
    }
}
