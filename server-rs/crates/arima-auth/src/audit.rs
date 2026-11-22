// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_core::{AuditEntry, ServerRole};
use arima_db::Db;
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::error::Result;

const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "newpassword",
    "currentpassword",
    "token",
    "secret",
    "apikey",
    "totp",
    "cookie",
    "authorization",
    "credential",
    "privatekey",
    "value",
];

/// Input structure for appending a redacted entry into `audit_log`.
#[derive(Debug, Clone)]
pub struct AuditWrite<'a> {
    pub actor_user_id: Option<&'a str>,
    pub actor_name: &'a str,
    pub actor_role: Option<ServerRole>,
    pub project_id: Option<&'a str>,
    pub action: &'a str,
    pub target: Option<&'a str>,
    pub summary: String,
    pub remote: bool,
    pub allowed: bool,
}

/// Recursively redacts sensitive fields before writing arguments/summaries to `audit_log`.
#[must_use]
pub fn redact_json_value(val: &Value) -> Value {
    match val {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                let lower = k.to_ascii_lowercase();
                if SENSITIVE_KEYS.iter().any(|s| lower.contains(s)) {
                    out.insert(k.clone(), Value::String("[REDACTED]".into()));
                } else {
                    out.insert(k.clone(), redact_json_value(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_json_value).collect()),
        _ => val.clone(),
    }
}

/// Inserts an immutable entry into `audit_log`.
pub fn record_audit(db: &Db, entry: AuditWrite<'_>) -> Result<()> {
    let now_ms = Utc::now().timestamp_millis();
    let role_str = entry.actor_role.map(ServerRole::as_str);
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO audit_log
                (actor_user_id, actor_name, actor_role, project_id, action, target, summary, remote, allowed, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                entry.actor_user_id,
                entry.actor_name,
                role_str,
                entry.project_id,
                entry.action,
                entry.target,
                entry.summary,
                i64::from(entry.remote),
                i64::from(entry.allowed),
                now_ms
            ],
        )?;
        Ok::<_, crate::error::AuthError>(())
    })
}

/// Lists recent audit log entries newest-first (capped at `limit`).
pub fn list_audit(db: &Db, limit: usize) -> Result<Vec<AuditEntry>> {
    let capped = i64::try_from(limit.clamp(1, 500)).unwrap_or(100);
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, actor_user_id, actor_name, actor_role, project_id, action, target, summary, remote, allowed, created_at
             FROM audit_log
             ORDER BY id DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([capped], |r| {
            let role_raw: Option<String> = r.get(3)?;
            let role = role_raw.as_deref().and_then(|s| match s {
                "owner" => Some(ServerRole::Owner),
                "operator" => Some(ServerRole::Operator),
                "viewer" => Some(ServerRole::Viewer),
                _ => None,
            });
            let ts_ms: i64 = r.get(10)?;
            let ts = DateTime::from_timestamp_millis(ts_ms)
                .unwrap_or_else(Utc::now)
                .to_rfc3339();
            Ok(AuditEntry {
                id: r.get(0)?,
                actor_user_id: r.get(1)?,
                actor_name: r.get(2)?,
                actor_role: role,
                project_id: r.get(4)?,
                action: r.get(5)?,
                target: r.get(6)?,
                summary: r.get(7)?,
                remote: r.get::<_, i64>(8)? != 0,
                allowed: r.get::<_, i64>(9)? != 0,
                created_at: ts,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok::<_, crate::error::AuthError>(out)
    })
}
