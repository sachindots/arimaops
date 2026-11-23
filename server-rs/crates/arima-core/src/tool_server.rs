// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A tool server one project's agents may be given. Each project keeps its own list in the
/// `mcpServers:{project_id}` setting; its key, if any, sits in the vault as `mcp:{project_id}:{name}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolServer {
    /// Lowercase letters, digits and dashes; "arima" is HQ's own server and never stored here.
    pub name: String,
    pub transport: ToolServerTransport,
    #[serde(default)]
    pub has_key: bool,
    #[serde(default)]
    pub source: ToolServerSource,
    /// The last live check; none before the first one.
    #[serde(default)]
    pub check: Option<ToolServerCheck>,
    /// The hash of the tool list at the last live check.
    #[serde(default)]
    pub tools_sha256: Option<String>,
    /// Why HQ won't give this server to agents (a pack server whose tools differ from the approved ones).
    #[serde(default)]
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolServerTransport {
    Http { url: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolServerSource {
    /// Added by hand in this project's settings.
    #[default]
    Manual,
    /// Installed by a pack, pinned to a commit; edited only through its pack.
    Pack {
        #[serde(rename = "packId")]
        pack_id: String,
        commit: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolServerCheck {
    pub ok: bool,
    pub error: Option<String>,
    /// RFC 3339 time of the check.
    pub at: String,
}
