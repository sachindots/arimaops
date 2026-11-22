// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::Mutex;

use arima_core::PasskeyInfo;
use arima_db::Db;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::{Host, Url};
use uuid::Uuid;
use webauthn_rs::prelude::{
    CreationChallengeResponse, Passkey, PasskeyAuthentication, PasskeyRegistration,
    PublicKeyCredential, RegisterPublicKeyCredential, RequestChallengeResponse, Webauthn,
    WebauthnBuilder,
};

use crate::error::{AuthError, Result};

const CHALLENGE_TTL_MS: i64 = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES: usize = 256;

/// Returns `true` only when `origin` supports WebAuthn RP IDs cleanly:
/// `http://localhost(:port)?` OR `https://<domain>(:port)?` (never raw IP literals like `127.0.0.1` or `192.168.x.x`).
#[must_use]
pub fn origin_supports_passkeys(origin: &str) -> bool {
    let Ok(parsed) = Url::parse(origin) else {
        return false;
    };
    match parsed.scheme() {
        "http" => parsed.host_str() == Some("localhost"),
        "https" => matches!(parsed.host(), Some(Host::Domain(_))),
        _ => false,
    }
}

fn build_webauthn(origin: &str) -> Result<Webauthn> {
    if !origin_supports_passkeys(origin) {
        return Err(AuthError::Validation(
            "Passkeys require localhost or an HTTPS domain (plain LAN IPs are unsupported by WebAuthn).".into(),
        ));
    }
    let parsed = Url::parse(origin)
        .map_err(|e| AuthError::Validation(format!("invalid origin URL: {e}")))?;
    let rp_id = parsed
        .host_str()
        .ok_or_else(|| AuthError::Validation("origin missing host".into()))?;
    WebauthnBuilder::new(rp_id, &parsed)
        .map_err(|e| AuthError::Passkey(format!("webauthn builder error: {e}")))?
        .rp_name("ArimaOps")
        .build()
        .map_err(|e| AuthError::Passkey(format!("webauthn build error: {e}")))
}

#[derive(Debug)]
struct PendingReg {
    user_id: String,
    label: String,
    origin: String,
    state: PasskeyRegistration,
    expires_at: i64,
}

#[derive(Debug)]
struct PendingAuth {
    user_id: Option<String>,
    origin: String,
    state: PasskeyAuthentication,
    expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PasskeyStartRegResponse {
    pub challenge_id: String,
    pub options: CreationChallengeResponse,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PasskeyStartAuthResponse {
    pub challenge_id: String,
    pub options: RequestChallengeResponse,
}

/// Manages WebAuthn Passkey registration, authentication, and credential storage in SQLite.
#[derive(Debug)]
pub struct PasskeyService {
    db: Db,
    pending_regs: Mutex<HashMap<String, PendingReg>>,
    pending_auths: Mutex<HashMap<String, PendingAuth>>,
}

impl PasskeyService {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self {
            db,
            pending_regs: Mutex::new(HashMap::new()),
            pending_auths: Mutex::new(HashMap::new()),
        }
    }

    pub fn list_passkeys(&self, user_id: &str) -> Result<Vec<PasskeyInfo>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, user_id, label, created_at, last_used_at
                 FROM passkeys
                 WHERE user_id = ?1
                 ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map([user_id], |r| {
                let created_ms: i64 = r.get(3)?;
                let last_used_ms: Option<i64> = r.get(4)?;
                Ok(PasskeyInfo {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    label: r.get(2)?,
                    created_at: DateTime::from_timestamp_millis(created_ms)
                        .unwrap_or_else(Utc::now)
                        .to_rfc3339(),
                    last_used_at: last_used_ms.map(|ms| {
                        DateTime::from_timestamp_millis(ms)
                            .unwrap_or_else(Utc::now)
                            .to_rfc3339()
                    }),
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
    }

    pub fn delete_passkey(&self, user_id: &str, passkey_id: &str) -> Result<bool> {
        let deleted = self.db.transaction(|conn| {
            let n = conn.execute(
                "DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2",
                rusqlite::params![passkey_id, user_id],
            )?;
            Ok::<_, AuthError>(n)
        })?;
        Ok(deleted > 0)
    }

    pub fn start_registration(
        &self,
        user_id: &str,
        user_name: &str,
        origin: &str,
        label: String,
    ) -> Result<PasskeyStartRegResponse> {
        let webauthn = build_webauthn(origin)?;
        let existing = self.load_user_passkeys(user_id)?;
        let exclude: Vec<_> = existing.iter().map(|(_, p)| p.cred_id().clone()).collect();
        let uid = Uuid::parse_str(user_id).unwrap_or_else(|_| Uuid::new_v4());
        let w_uid = webauthn_rs::prelude::Uuid::from_bytes(*uid.as_bytes());
        let (options, state) = webauthn
            .start_passkey_registration(w_uid, user_name, user_name, Some(exclude))
            .map_err(|e| AuthError::Passkey(format!("start registration failed: {e}")))?;

        let challenge_id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let clean_label = if label.trim().is_empty() {
            "Passkey".to_owned()
        } else {
            label.trim().chars().take(60).collect()
        };

        let mut guard = self
            .pending_regs
            .lock()
            .map_err(|_| AuthError::Passkey("challenge mutex poisoned".into()))?;
        guard.retain(|_, v| v.expires_at > now);
        if guard.len() >= MAX_PENDING_CHALLENGES {
            return Err(AuthError::Throttled {
                retry_after_secs: 60,
            });
        }
        guard.insert(
            challenge_id.clone(),
            PendingReg {
                user_id: user_id.to_owned(),
                label: clean_label,
                origin: origin.to_owned(),
                state,
                expires_at: now + CHALLENGE_TTL_MS,
            },
        );

        Ok(PasskeyStartRegResponse {
            challenge_id,
            options,
        })
    }

    pub fn finish_registration(
        &self,
        user_id: &str,
        challenge_id: &str,
        credential: RegisterPublicKeyCredential,
    ) -> Result<PasskeyInfo> {
        let now = Utc::now().timestamp_millis();
        let pending = {
            let mut guard = self
                .pending_regs
                .lock()
                .map_err(|_| AuthError::Passkey("challenge mutex poisoned".into()))?;
            guard.remove(challenge_id)
        }
        .ok_or_else(|| AuthError::Unauthorized("missing or expired passkey challenge".into()))?;

        if pending.expires_at <= now || pending.user_id != user_id {
            return Err(AuthError::Unauthorized(
                "expired or mismatched passkey challenge".into(),
            ));
        }

        let webauthn = build_webauthn(&pending.origin)?;
        let passkey = webauthn
            .finish_passkey_registration(&credential, &pending.state)
            .map_err(|e| AuthError::Passkey(format!("registration verification failed: {e}")))?;

        let id = Uuid::new_v4().to_string();
        let cred_json = serde_json::to_string(&passkey)?;
        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO passkeys (id, user_id, credential_json, label, created_at, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                rusqlite::params![id, user_id, cred_json, pending.label, now],
            )?;
            Ok::<_, AuthError>(())
        })?;

        Ok(PasskeyInfo {
            id,
            user_id: user_id.to_owned(),
            label: pending.label,
            created_at: DateTime::from_timestamp_millis(now)
                .unwrap_or_else(Utc::now)
                .to_rfc3339(),
            last_used_at: None,
        })
    }

    pub fn start_authentication(
        &self,
        user_id: Option<&str>,
        origin: &str,
    ) -> Result<PasskeyStartAuthResponse> {
        let webauthn = build_webauthn(origin)?;
        let passkeys: Vec<Passkey> = match user_id {
            Some(uid) => self
                .load_user_passkeys(uid)?
                .into_iter()
                .map(|(_, p)| p)
                .collect(),
            None => self
                .load_all_passkeys()?
                .into_iter()
                .map(|(_, _, p)| p)
                .collect(),
        };
        if passkeys.is_empty() {
            return Err(AuthError::NotFound(
                "No passkeys registered for this account.".into(),
            ));
        }

        let (options, state) = webauthn
            .start_passkey_authentication(&passkeys)
            .map_err(|e| AuthError::Passkey(format!("start auth failed: {e}")))?;
        let challenge_id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();

        let mut guard = self
            .pending_auths
            .lock()
            .map_err(|_| AuthError::Passkey("challenge mutex poisoned".into()))?;
        guard.retain(|_, v| v.expires_at > now);
        if guard.len() >= MAX_PENDING_CHALLENGES {
            return Err(AuthError::Throttled {
                retry_after_secs: 60,
            });
        }
        guard.insert(
            challenge_id.clone(),
            PendingAuth {
                user_id: user_id.map(str::to_owned),
                origin: origin.to_owned(),
                state,
                expires_at: now + CHALLENGE_TTL_MS,
            },
        );

        Ok(PasskeyStartAuthResponse {
            challenge_id,
            options,
        })
    }

    /// Verifies a passkey assertion and returns the matching `user_id`.
    pub fn finish_authentication(
        &self,
        challenge_id: &str,
        credential: PublicKeyCredential,
    ) -> Result<String> {
        let now = Utc::now().timestamp_millis();
        let pending = {
            let mut guard = self
                .pending_auths
                .lock()
                .map_err(|_| AuthError::Passkey("challenge mutex poisoned".into()))?;
            guard.remove(challenge_id)
        }
        .ok_or_else(|| AuthError::Unauthorized("missing or expired passkey challenge".into()))?;

        if pending.expires_at <= now {
            return Err(AuthError::Unauthorized("passkey challenge expired".into()));
        }

        let webauthn = build_webauthn(&pending.origin)?;
        let auth_result = webauthn
            .finish_passkey_authentication(&credential, &pending.state)
            .map_err(|_| AuthError::InvalidCredentials)?;

        let all = match pending.user_id.as_deref() {
            Some(uid) => self
                .load_user_passkeys(uid)?
                .into_iter()
                .map(|(pid, p)| (pid, uid.to_owned(), p))
                .collect::<Vec<_>>(),
            None => self.load_all_passkeys()?,
        };

        for (pid, uid, mut passkey) in all {
            if passkey.cred_id() == auth_result.cred_id() {
                if auth_result.needs_update() {
                    passkey.update_credential(&auth_result);
                }
                let updated_json = serde_json::to_string(&passkey)?;
                self.db.transaction(|conn| {
                    conn.execute(
                        "UPDATE passkeys SET credential_json = ?1, last_used_at = ?2 WHERE id = ?3",
                        rusqlite::params![updated_json, now, pid],
                    )?;
                    Ok::<_, AuthError>(())
                })?;
                return Ok(uid);
            }
        }

        Err(AuthError::InvalidCredentials)
    }

    fn load_user_passkeys(&self, user_id: &str) -> Result<Vec<(String, Passkey)>> {
        self.db.read(|conn| {
            let mut stmt =
                conn.prepare("SELECT id, credential_json FROM passkeys WHERE user_id = ?1")?;
            let rows = stmt.query_map([user_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (id, raw) = row?;
                let parsed: Passkey = serde_json::from_str(&raw)?;
                out.push((id, parsed));
            }
            Ok(out)
        })
    }

    fn load_all_passkeys(&self) -> Result<Vec<(String, String, Passkey)>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare("SELECT id, user_id, credential_json FROM passkeys")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (id, uid, raw) = row?;
                let parsed: Passkey = serde_json::from_str(&raw)?;
                out.push((id, uid, parsed));
            }
            Ok(out)
        })
    }
}
