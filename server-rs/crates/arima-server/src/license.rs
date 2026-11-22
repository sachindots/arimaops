// SPDX-License-Identifier: AGPL-3.0-or-later

//! `ee/` Ed25519 licensing engine using `ed25519-dalek`:
//! - Verifies canonical Ed25519-signed license keys (`ARIMA1.<b64url_payload>.<b64url_sig>`)
//! - Enforces runtime expiry (falling back cleanly to Community tier limits)
//! - Enforces active seat limits (`maxSeats`) on user creation (`POST /api/users`)

use std::sync::RwLock;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::json;

use arima_db::{Db, DbError, ServerSettingsRepo};

const LICENSE_SETTING_KEY: &str = "ee_license_key";
const LICENSE_PREFIX: &str = "ARIMA1";

pub const COMMUNITY_MAX_SEATS: usize = 5;
pub const COMMUNITY_MAX_PROJECTS: usize = 5;

/// Default ArimaOps v2 release Ed25519 verifying key (can be overridden in tests or self-hosted builds
/// via `ARIMA_LICENSE_PUBKEY_HEX` or [`LicenseService::set_verifying_key`]).
const DEFAULT_VERIFYING_KEY_BYTES: [u8; 32] = [
    0x3b, 0x6a, 0x27, 0xbc, 0xce, 0xb6, 0xa4, 0x2d, 0x62, 0xa3, 0xa8, 0xd0, 0x2a, 0x6f, 0x0d,
    0x73, 0x65, 0x32, 0x15, 0x77, 0x1d, 0xe2, 0x43, 0xa6, 0x3a, 0xc0, 0x48, 0xa1, 0x8b, 0x59,
    0xda, 0x29,
];

/// Canonical Ed25519-signed license payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    pub licensee: String,
    pub tier: String,
    pub max_seats: usize,
    pub max_projects: usize,
    pub expires_at: String,
    #[serde(default)]
    pub features: Vec<String>,
}

/// Live evaluated license status returned by `GET /api/license` and `POST /api/license`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub tier: String,
    pub status: String, // "community" | "active" | "expired" | "invalid"
    pub licensee: Option<String>,
    pub max_seats: usize,
    pub active_seats: usize,
    pub max_projects: usize,
    pub expires_at: Option<String>,
    pub features: Vec<String>,
}

/// Signs a [`LicensePayload`] with an Ed25519 [`SigningKey`] into canonical `ARIMA1.<payload>.<sig>` form.
pub fn sign_license_payload(
    signing_key: &SigningKey,
    payload: &LicensePayload,
) -> Result<String, String> {
    let raw = serde_json::to_vec(payload).map_err(|e| format!("serialize license: {e}"))?;
    let sig: Signature = signing_key.sign(&raw);
    Ok(format!(
        "{LICENSE_PREFIX}.{}.{}",
        B64URL.encode(&raw),
        B64URL.encode(sig.to_bytes())
    ))
}

/// Verifies an Ed25519-signed `ARIMA1.<payload>.<sig>` license key against `verifying_key`.
pub fn verify_license_key(
    verifying_key: &VerifyingKey,
    license_key: &str,
) -> Result<LicensePayload, String> {
    let trimmed = license_key.trim();
    let mut parts = trimmed.split('.');
    let (Some(prefix), Some(payload_b64), Some(sig_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("malformed license key format (expected ARIMA1.<payload>.<signature>)".into());
    };
    if prefix != LICENSE_PREFIX {
        return Err(format!("unsupported license key prefix '{prefix}'"));
    }

    let payload_bytes = B64URL
        .decode(payload_b64)
        .map_err(|_| "invalid base64url license payload".to_owned())?;
    let sig_bytes = B64URL
        .decode(sig_b64)
        .map_err(|_| "invalid base64url license signature".to_owned())?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "invalid Ed25519 signature length (expected 64 bytes)".to_owned())?;
    let signature = Signature::from_bytes(&sig_arr);

    verifying_key
        .verify(&payload_bytes, &signature)
        .map_err(|_| "Ed25519 license signature verification failed".to_owned())?;

    let payload: LicensePayload = serde_json::from_slice(&payload_bytes)
        .map_err(|e| format!("invalid license payload JSON: {e}"))?;
    if payload.licensee.trim().is_empty() {
        return Err("license payload missing licensee".into());
    }
    if payload.max_seats == 0 {
        return Err("license maxSeats must be >= 1".into());
    }
    DateTime::parse_from_rfc3339(&payload.expires_at)
        .map_err(|_| "license expiresAt must be valid RFC 3339 timestamp".to_owned())?;
    Ok(payload)
}

fn community_features() -> Vec<String> {
    vec![
        "core".into(),
        "visual-decisions".into(),
        "preview-annotation".into(),
        "fts5-memory".into(),
        "encrypted-backups".into(),
    ]
}

fn default_verifying_key() -> VerifyingKey {
    if let Ok(hex_str) = std::env::var("ARIMA_LICENSE_PUBKEY_HEX") {
        if let Ok(bytes) = hex::decode(hex_str.trim()) {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                if let Ok(vk) = VerifyingKey::from_bytes(&arr) {
                    return vk;
                }
            }
        }
    }
    VerifyingKey::from_bytes(&DEFAULT_VERIFYING_KEY_BYTES)
        .expect("default Ed25519 verifying key must be valid")
}

/// Runtime Ed25519 licensing service backed by SQLite `server_settings`.
pub struct LicenseService {
    db: Db,
    settings: ServerSettingsRepo,
    verifying_key: RwLock<VerifyingKey>,
}

impl LicenseService {
    #[must_use]
    pub fn new(db: Db) -> Self {
        let settings = ServerSettingsRepo::new(db.clone());
        Self {
            db,
            settings,
            verifying_key: RwLock::new(default_verifying_key()),
        }
    }

    /// Overrides the Ed25519 verifying key at runtime (used in tests and custom enterprise builds).
    pub fn set_verifying_key(&self, key: VerifyingKey) {
        if let Ok(mut guard) = self.verifying_key.write() {
            *guard = key;
        }
    }

    #[must_use]
    pub fn verifying_key(&self) -> VerifyingKey {
        self.verifying_key
            .read()
            .map(|g| *g)
            .unwrap_or_else(|_| default_verifying_key())
    }

    fn count_active_seats(&self) -> usize {
        self.db
            .read(|conn| {
                let n: i64 = conn
                    .query_row("SELECT COUNT(*) FROM users WHERE disabled = 0", [], |r| {
                        r.get(0)
                    })
                    .unwrap_or(0);
                Ok::<_, DbError>(usize::try_from(n).unwrap_or(0))
            })
            .unwrap_or(0)
    }

    /// Evaluates the currently stored license key against the verifying key and current clock.
    /// Expired or invalid keys automatically fall back to Community limits!
    #[must_use]
    pub fn current_status(&self) -> LicenseStatus {
        let active_seats = self.count_active_seats();
        let stored = self
            .settings
            .get(LICENSE_SETTING_KEY)
            .ok()
            .flatten()
            .and_then(|v| v.as_str().map(str::to_owned));

        let Some(raw_key) = stored.filter(|s| !s.trim().is_empty()) else {
            return LicenseStatus {
                tier: "community".into(),
                status: "community".into(),
                licensee: None,
                max_seats: COMMUNITY_MAX_SEATS,
                active_seats,
                max_projects: COMMUNITY_MAX_PROJECTS,
                expires_at: None,
                features: community_features(),
            };
        };

        let vk = self.verifying_key();
        match verify_license_key(&vk, &raw_key) {
            Ok(payload) => {
                let expired = DateTime::parse_from_rfc3339(&payload.expires_at)
                    .map(|dt| dt.with_timezone(&Utc) <= Utc::now())
                    .unwrap_or(true);
                if expired {
                    // Expired license falls back strictly to Community limits!
                    LicenseStatus {
                        tier: "community".into(),
                        status: "expired".into(),
                        licensee: Some(payload.licensee),
                        max_seats: COMMUNITY_MAX_SEATS,
                        active_seats,
                        max_projects: COMMUNITY_MAX_PROJECTS,
                        expires_at: Some(payload.expires_at),
                        features: community_features(),
                    }
                } else {
                    LicenseStatus {
                        tier: payload.tier,
                        status: "active".into(),
                        licensee: Some(payload.licensee),
                        max_seats: payload.max_seats,
                        active_seats,
                        max_projects: payload.max_projects,
                        expires_at: Some(payload.expires_at),
                        features: if payload.features.is_empty() {
                            community_features()
                        } else {
                            payload.features
                        },
                    }
                }
            }
            Err(_) => LicenseStatus {
                tier: "community".into(),
                status: "invalid".into(),
                licensee: None,
                max_seats: COMMUNITY_MAX_SEATS,
                active_seats,
                max_projects: COMMUNITY_MAX_PROJECTS,
                expires_at: None,
                features: community_features(),
            },
        }
    }

    /// Validates Ed25519 signature and runtime expiry, persists the license key in SQLite,
    /// and returns the activated [`LicenseStatus`].
    pub fn activate(&self, license_key: &str) -> Result<LicenseStatus, String> {
        let vk = self.verifying_key();
        let payload = verify_license_key(&vk, license_key)?;

        let expires_dt = DateTime::parse_from_rfc3339(&payload.expires_at)
            .map_err(|_| "invalid expiresAt timestamp".to_owned())?
            .with_timezone(&Utc);
        if expires_dt <= Utc::now() {
            return Err(format!(
                "license expired at {} — falling back to community limits",
                payload.expires_at
            ));
        }

        self.settings
            .set(LICENSE_SETTING_KEY, &json!(license_key.trim()))
            .map_err(|e| format!("failed to persist license: {e}"))?;

        Ok(self.current_status())
    }

    /// Enforces the active license's `maxSeats` ceiling before adding a new user.
    pub fn ensure_seat_available(&self) -> Result<(), String> {
        let st = self.current_status();
        if st.active_seats >= st.max_seats {
            return Err(format!(
                "Active seat limit reached ({}/{} on '{}' plan). Upgrade your ArimaOps license or disable an unused account.",
                st.active_seats, st.max_seats, st.tier
            ));
        }
        Ok(())
    }
}
