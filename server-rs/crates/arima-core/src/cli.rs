// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Supported agent CLI identifiers shared with the UI via `ts-rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AgentCli {
    Claude,
    Codex,
    Agy,
    Opencode,
    Gemini,
    Copilot,
}

impl AgentCli {
    pub const ALL: [Self; 6] = [
        Self::Claude,
        Self::Codex,
        Self::Agy,
        Self::Opencode,
        Self::Gemini,
        Self::Copilot,
    ];

    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Agy => "agy",
            Self::Opencode => "opencode",
            Self::Gemini => "gemini",
            Self::Copilot => "copilot",
        }
    }
}
