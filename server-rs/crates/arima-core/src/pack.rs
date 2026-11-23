// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::tool_server::ToolServerTransport;

/// What one project has approved, per pack: the trust record. Kept in the `packs:{project_id}` setting and written
/// into a template file's `packs` field.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, TS)]
pub struct PackLock {
    pub v: u32,
    pub packs: BTreeMap<String, PackEntry>,
}

/// One pack at one commit: a plugin from a catalog (`owner/repo:plugin`) or a whole repo of skill folders (`owner/repo`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackEntry {
    pub source: PackSource,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub skills: BTreeMap<String, PackSkill>,
    #[serde(default)]
    pub tool_servers: BTreeMap<String, PackToolServer>,
    /// Hosts the pack says it reaches (its manifest's `network.hosts`).
    #[serde(default)]
    pub egress: Vec<String>,
    /// Secrets the pack asks for (its `userConfig` entries marked sensitive).
    #[serde(default)]
    pub secrets: Vec<String>,
    /// Parts HQ doesn't install: hooks, commands, subagents and command (stdio) tool servers.
    #[serde(default)]
    pub ignored: Vec<String>,
    #[serde(default)]
    pub scan: PackScan,
    /// None until the owner approves this entry; an import never carries it over.
    #[serde(default)]
    pub approved: Option<PackApproval>,
    /// The open review card for this entry or its `update`.
    #[serde(default)]
    pub review: Option<String>,
    /// A newer state waiting for approval; agents keep this entry until then.
    #[serde(default)]
    pub update: Option<Box<PackEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackSource {
    /// An https git URL.
    pub repo: String,
    /// A full 40-hex commit.
    pub commit: String,
    /// The plugin's folder in the repo; none for a whole-repo pack.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackSkill {
    /// The skill folder, relative to the repo root.
    pub path: String,
    /// The hash of the folder's files.
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackToolServer {
    pub transport: ToolServerTransport,
    /// The hash of its normalised `tools/list`; none while HQ couldn't list its tools.
    pub tools_sha256: Option<String>,
    /// The normalised tool list the hash covers, kept so a change can be shown as a diff.
    #[serde(default)]
    pub tools: Vec<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct PackScan {
    /// Findings that block a skill, as `path:line why`.
    pub blocked: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct PackApproval {
    pub by: String,
    /// RFC 3339.
    pub at: String,
}

/// One skill or tool server a review card shows in full, before and after.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackChange {
    /// "skill" or "toolServer".
    pub kind: String,
    pub name: String,
    /// The SKILL.md or tool descriptions as approved; none when new.
    pub before: Option<String>,
    /// None when the item goes away.
    pub after: Option<String>,
}
