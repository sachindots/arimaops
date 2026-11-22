// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::{Arc, Mutex};

use arima_db::{Db, DbError};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// Computes the GitHub `sha256=<hex>` webhook signature for `body` using `secret`.
#[must_use]
pub fn compute_github_signature(secret: &[u8], body: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    let bytes = mac.finalize().into_bytes();
    format!("sha256={}", hex::encode(bytes))
}

/// Verifies a GitHub `X-Hub-Signature-256` header (`sha256=<hex>`) in constant time.
#[must_use]
pub fn verify_github_signature(secret: &[u8], body: &[u8], signature_header: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Some(hex_part) = signature_header.trim().strip_prefix("sha256=") else {
        return false;
    };
    let Ok(provided_bytes) = hex::decode(hex_part) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    let expected_bytes = mac.finalize().into_bytes();
    if provided_bytes.len() != expected_bytes.len() {
        return false;
    }
    bool::from(provided_bytes.ct_eq(expected_bytes.as_slice()))
}

/// Persisted pull request record synchronized from GitHub webhooks or GraphQL sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedPullRequest {
    pub number: i64,
    pub title: String,
    pub branch: String,
    pub author: String,
    pub status: String,
    pub url: String,
    pub sha: String,
    pub updated_at: String,
}

/// Persisted GitHub PR sync state stored inside `projects.config_json` so HQ restarts
/// resume from the exact cursor without PR blind spots and `forget_project` cascades cleanly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSyncState {
    pub cursor: Option<String>,
    pub last_delivery_id: Option<String>,
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub pull_requests: Vec<SyncedPullRequest>,
}

/// Service managing GitHub webhook ingestion and persisted SQLite sync state.
#[derive(Debug, Clone)]
pub struct GithubSyncService {
    db: Db,
    webhook_secret: Arc<Mutex<String>>,
}

impl GithubSyncService {
    #[must_use]
    pub fn new(db: Db) -> Self {
        // Unset env: a random per-process secret, so no signature can match until the owner configures one.
        let default_secret = std::env::var("ARIMA_GITHUB_WEBHOOK_SECRET")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()));
        Self {
            db,
            webhook_secret: Arc::new(Mutex::new(default_secret)),
        }
    }

    pub fn set_webhook_secret(&self, secret: impl Into<String>) {
        if let Ok(mut guard) = self.webhook_secret.lock() {
            *guard = secret.into();
        }
    }

    #[must_use]
    pub fn webhook_secret(&self) -> String {
        self.webhook_secret
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Loads the persisted [`GithubSyncState`] for `project_id` from SQLite.
    pub fn load_state(&self, project_id: &str) -> Result<GithubSyncState, DbError> {
        self.db.read(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(raw_json) = raw else {
                return Ok::<_, DbError>(GithubSyncState::default());
            };
            let root: Value = serde_json::from_str(&raw_json).unwrap_or_else(|_| json!({}));
            let state = root
                .get("githubSync")
                .cloned()
                .and_then(|v| serde_json::from_value::<GithubSyncState>(v).ok())
                .unwrap_or_default();
            Ok::<_, DbError>(state)
        })
    }

    /// Atomically updates [`GithubSyncState`] inside `projects.config_json`.
    pub fn save_state(
        &self,
        project_id: &str,
        sync_state: &GithubSyncState,
    ) -> Result<(), DbError> {
        let now_ms = Utc::now().timestamp_millis();
        self.db.transaction(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT config_json FROM projects WHERE id = ?1",
                    [project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(raw_json) = raw else {
                return Err(DbError::InvalidInput(format!(
                    "project '{project_id}' not found"
                )));
            };
            let mut root: Value = serde_json::from_str(&raw_json).unwrap_or_else(|_| json!({}));
            if !root.is_object() {
                root = json!({});
            }
            root.as_object_mut().expect("object").insert(
                "githubSync".into(),
                serde_json::to_value(sync_state).unwrap_or_else(|_| json!({})),
            );
            conn.execute(
                "UPDATE projects SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![root.to_string(), now_ms, project_id],
            )?;
            Ok::<_, DbError>(())
        })
    }

    /// Processes a verified GitHub webhook payload, upserting PR state and advancing the persisted sync cursor.
    pub fn process_webhook_event(
        &self,
        project_id: &str,
        event_kind: &str,
        delivery_id: Option<&str>,
        payload: &Value,
    ) -> Result<(GithubSyncState, Option<SyncedPullRequest>), DbError> {
        let mut state = self.load_state(project_id)?;
        let now_iso = Utc::now().to_rfc3339();
        state.last_synced_at = Some(now_iso.clone());
        if let Some(did) = delivery_id {
            state.last_delivery_id = Some(did.to_owned());
        }
        if let Some(cursor) = payload.get("cursor").and_then(Value::as_str) {
            state.cursor = Some(cursor.to_owned());
        }

        let mut updated_pr = None;
        if event_kind == "pull_request" || payload.get("pull_request").is_some() {
            let pr_obj = payload.get("pull_request").unwrap_or(payload);
            let number = pr_obj
                .get("number")
                .or_else(|| payload.get("number"))
                .and_then(Value::as_i64)
                .unwrap_or(1);
            let title = pr_obj
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Pull Request")
                .to_owned();
            let branch = pr_obj
                .get("head")
                .and_then(|h| h.get("ref"))
                .or_else(|| pr_obj.get("branch"))
                .and_then(Value::as_str)
                .unwrap_or("main")
                .to_owned();
            let author = pr_obj
                .get("user")
                .and_then(|u| u.get("login"))
                .or_else(|| pr_obj.get("author"))
                .and_then(Value::as_str)
                .unwrap_or("agent")
                .to_owned();
            let merged = pr_obj
                .get("merged")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let raw_state = pr_obj
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("open");
            let status = if merged {
                "merged".into()
            } else {
                raw_state.to_owned()
            };
            let url = pr_obj
                .get("html_url")
                .or_else(|| pr_obj.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let sha = pr_obj
                .get("head")
                .and_then(|h| h.get("sha"))
                .or_else(|| pr_obj.get("sha"))
                .and_then(Value::as_str)
                .unwrap_or("HEAD")
                .to_owned();

            let pr = SyncedPullRequest {
                number,
                title,
                branch,
                author,
                status,
                url,
                sha: sha.clone(),
                updated_at: now_iso,
            };

            state.cursor = Some(format!("pr-{number}-{sha}"));
            if let Some(existing) = state.pull_requests.iter_mut().find(|p| p.number == number) {
                *existing = pr.clone();
            } else {
                state.pull_requests.push(pr.clone());
            }
            updated_pr = Some(pr);
        }

        self.save_state(project_id, &state)?;
        Ok((state, updated_pr))
    }
}
