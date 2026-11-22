// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Machine-wide user privilege level.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ServerRole {
    Owner,
    Operator,
    Viewer,
}

impl ServerRole {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Operator => "operator",
            Self::Viewer => "viewer",
        }
    }
}

/// Per-project role binding overriding or narrowing server-wide permissions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRole {
    pub user_id: String,
    pub project_id: String,
    pub role: ServerRole,
}

/// Authenticated user record safe to expose to UI settings (never contains hashes or secrets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub name: String,
    pub role: ServerRole,
    pub disabled: bool,
    pub totp_enabled: bool,
    pub passkey_count: u32,
    pub created_at: String,
}

/// Active browser/mobile session bound to a device cookie (never includes session token hash).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSession {
    pub id: String,
    pub user_id: String,
    pub label: String,
    pub origin: Option<String>,
    pub remote: bool,
    pub elevated_until: Option<String>,
    pub last_seen_at: String,
    pub expires_at: String,
    pub created_at: String,
    pub current: bool,
}

/// Registered WebAuthn / Passkey credential metadata shown in Security settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyInfo {
    pub id: String,
    pub user_id: String,
    pub label: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// Immutable, redacted security & command audit entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    #[ts(type = "number")]
    pub id: i64,
    pub actor_user_id: Option<String>,
    pub actor_name: String,
    pub actor_role: Option<ServerRole>,
    pub project_id: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub summary: String,
    pub remote: bool,
    pub allowed: bool,
    pub created_at: String,
}
