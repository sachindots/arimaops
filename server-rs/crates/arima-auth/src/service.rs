// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::Arc;

use arima_core::{AuthUser, DeviceSession, ProjectRole, ServerRole};
use arima_db::Db;
use chrono::{DateTime, Utc};
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use rand::Rng;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::cookies::SESSION_MAX_AGE_SECS;
use crate::error::{AuthError, Result};
use crate::passkeys::PasskeyService;
use crate::password::{
    hash_password, validate_password_policy, verify_dummy_password, verify_password,
};
use crate::throttle::AuthThrottle;
use crate::totp::{
    generate_secret_b32, otpauth_uri, render_qr_svg, verify_totp_for_user, verify_totp_stateless,
};
use crate::vault::VaultKey;

const LOGIN_MAX_FAILURES: i64 = 5;
const LOGIN_WINDOW_MS: i64 = 15 * 60 * 1000;
const LOGIN_LOCK_MS: i64 = 15 * 60 * 1000;

const TOTP_MAX_FAILURES: i64 = 5;
const TOTP_WINDOW_MS: i64 = 5 * 60 * 1000;
const TOTP_LOCK_MS: i64 = 5 * 60 * 1000;

const STEP_UP_DURATION_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct CreateUserOutcome {
    pub user: AuthUser,
    pub otpauth: String,
    pub qr_svg: String,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateUserInput {
    pub role: Option<ServerRole>,
    pub password: Option<String>,
    pub reset_totp: bool,
    pub disabled: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct UpdateUserOutcome {
    pub user: AuthUser,
    pub otpauth: Option<String>,
    pub qr_svg: Option<String>,
    pub revoked_device_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct VerifiedSession {
    pub device_id: String,
    pub role: ServerRole,
    pub user: Option<AuthUser>,
    pub elevated_until_ms: Option<i64>,
    pub is_bootstrap: bool,
}

#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub client_ip: String,
    pub origin: Option<String>,
    pub label: String,
    pub remote: bool,
}

#[derive(Debug, Clone)]
pub struct LoginSuccess {
    pub raw_token: String,
    pub session: DeviceSession,
    pub user: Option<AuthUser>,
}

#[derive(Clone)]
pub struct AuthService {
    db: Db,
    vault: VaultKey,
    throttle: AuthThrottle,
    passkeys: Arc<PasskeyService>,
    server_totp_secret: String,
}

impl std::fmt::Debug for AuthService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthService").finish_non_exhaustive()
    }
}

impl AuthService {
    #[must_use]
    pub fn new(db: Db, vault: VaultKey) -> Self {
        let throttle = AuthThrottle::new(db.clone());
        let passkeys = Arc::new(PasskeyService::new(db.clone()));
        Self {
            db,
            vault,
            throttle,
            passkeys,
            server_totp_secret: generate_secret_b32(),
        }
    }

    /// Sets an explicit server-level TOTP secret (used for bootstrap step-up / deterministic tests).
    #[must_use]
    pub fn with_server_totp_secret(mut self, secret_b32: String) -> Self {
        self.server_totp_secret = secret_b32;
        self
    }

    #[must_use]
    pub fn passkeys(&self) -> &PasskeyService {
        &self.passkeys
    }

    #[must_use]
    pub fn db(&self) -> &Db {
        &self.db
    }

    #[must_use]
    pub fn vault(&self) -> &VaultKey {
        &self.vault
    }

    #[must_use]
    pub fn server_totp_secret(&self) -> &str {
        &self.server_totp_secret
    }

    pub fn users_count(&self) -> Result<usize> {
        let count: i64 = self.db.read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
                .map_err(AuthError::from)
        })?;
        Ok(usize::try_from(count).unwrap_or(0))
    }

    pub fn list_users(&self) -> Result<Vec<AuthUser>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT u.id, u.name, u.role, u.disabled, u.totp_enabled, u.created_at,
                        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS pk_count
                 FROM users u
                 ORDER BY u.created_at ASC",
            )?;
            let rows = stmt.query_map([], map_auth_user)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
    }

    pub fn get_user_by_id(&self, user_id: &str) -> Result<Option<AuthUser>> {
        self.db.read(|conn| {
            conn.query_row(
                "SELECT u.id, u.name, u.role, u.disabled, u.totp_enabled, u.created_at,
                        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS pk_count
                 FROM users u
                 WHERE u.id = ?1",
                [user_id],
                map_auth_user,
            )
            .optional()
            .map_err(AuthError::from)
        })
    }

    pub fn find_user_by_name(&self, name: &str) -> Result<Option<AuthUser>> {
        let clean = name.trim();
        self.db.read(|conn| {
            conn.query_row(
                "SELECT u.id, u.name, u.role, u.disabled, u.totp_enabled, u.created_at,
                        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS pk_count
                 FROM users u
                 WHERE u.name = ?1 COLLATE NOCASE",
                [clean],
                map_auth_user,
            )
            .optional()
            .map_err(AuthError::from)
        })
    }

    pub async fn create_user(
        &self,
        name: String,
        password: String,
        requested_role: ServerRole,
    ) -> Result<CreateUserOutcome> {
        let clean_name = name.trim().to_owned();
        if clean_name.is_empty() || clean_name.chars().count() > 60 {
            return Err(AuthError::Validation(
                "Name must be between 1 and 60 characters.".into(),
            ));
        }

        let password_hash = hash_password(password).await?;
        let user_id = Uuid::new_v4().to_string();
        let secret_b32 = generate_secret_b32();
        let aad = format!("totp:{user_id}");
        let secret_enc = self.vault.encrypt(aad.as_bytes(), secret_b32.as_bytes())?;
        let otpauth = otpauth_uri(&clean_name, &secret_b32);
        let qr_svg = render_qr_svg(&otpauth)?;
        let now_ms = Utc::now().timestamp_millis();

        let assigned_role = self.db.transaction(|conn| {
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM users WHERE name = ?1 COLLATE NOCASE",
                    [&clean_name],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.is_some() {
                return Err(AuthError::Validation(
                    "That name is already taken.".into(),
                ));
            }
            let total: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            // First person created is always Owner regardless of requested role.
            let final_role = if total == 0 {
                ServerRole::Owner
            } else {
                requested_role
            };
            conn.execute(
                "INSERT INTO users (id, name, password_hash, role, disabled, totp_secret_enc, totp_enabled, created_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, 1, ?6)",
                rusqlite::params![
                    user_id,
                    clean_name,
                    password_hash,
                    final_role.as_str(),
                    secret_enc,
                    now_ms
                ],
            )?;
            Ok::<_, AuthError>(final_role)
        })?;

        Ok(CreateUserOutcome {
            user: AuthUser {
                id: user_id,
                name: clean_name,
                role: assigned_role,
                disabled: false,
                totp_enabled: true,
                passkey_count: 0,
                created_at: format_ts(now_ms),
            },
            otpauth,
            qr_svg,
        })
    }

    pub async fn update_user(
        &self,
        user_id: &str,
        patch: UpdateUserInput,
    ) -> Result<UpdateUserOutcome> {
        let new_hash = match patch.password {
            Some(pw) => Some(hash_password(pw).await?),
            None => None,
        };

        let mut new_totp: Option<(String, String, String)> = None;
        if patch.reset_totp {
            let existing = self
                .get_user_by_id(user_id)?
                .ok_or_else(|| AuthError::NotFound("User not found.".into()))?;
            let secret = generate_secret_b32();
            let aad = format!("totp:{user_id}");
            let enc = self.vault.encrypt(aad.as_bytes(), secret.as_bytes())?;
            let uri = otpauth_uri(&existing.name, &secret);
            let svg = render_qr_svg(&uri)?;
            new_totp = Some((enc, uri, svg));
        }

        let revoke_sessions = new_hash.is_some()
            || patch.reset_totp
            || patch.disabled == Some(true)
            || patch.role.is_some();

        let (updated_user, revoked_device_ids) = self.db.transaction(|conn| {
            let current: Option<AuthUser> = conn
                .query_row(
                    "SELECT u.id, u.name, u.role, u.disabled, u.totp_enabled, u.created_at,
                            (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS pk_count
                     FROM users u WHERE u.id = ?1",
                    [user_id],
                    map_auth_user,
                )
                .optional()?;
            let current = current.ok_or_else(|| AuthError::NotFound("User not found.".into()))?;

            let next_role = patch.role.unwrap_or(current.role);
            let next_disabled = patch.disabled.unwrap_or(current.disabled);

            // Prevent removing/disabling the last active owner.
            if matches!(current.role, ServerRole::Owner)
                && !current.disabled
                && (next_disabled || !matches!(next_role, ServerRole::Owner))
            {
                let other_owners: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?1",
                    [user_id],
                    |r| r.get(0),
                )?;
                if other_owners == 0 {
                    return Err(AuthError::Validation(
                        "Cannot demote or disable the last active owner.".into(),
                    ));
                }
            }

            conn.execute(
                "UPDATE users SET role = ?1, disabled = ?2 WHERE id = ?3",
                rusqlite::params![next_role.as_str(), i64::from(next_disabled), user_id],
            )?;

            if let Some(ref hash) = new_hash {
                conn.execute(
                    "UPDATE users SET password_hash = ?1 WHERE id = ?2",
                    rusqlite::params![hash, user_id],
                )?;
            }

            if let Some((ref enc, _, _)) = new_totp {
                conn.execute(
                    "UPDATE users SET totp_secret_enc = ?1, totp_enabled = 1 WHERE id = ?2",
                    rusqlite::params![enc, user_id],
                )?;
                conn.execute("DELETE FROM totp_used_steps WHERE user_id = ?1", [user_id])?;
            }

            let mut revoked = Vec::new();
            if revoke_sessions {
                let mut stmt =
                    conn.prepare("SELECT id FROM device_sessions WHERE user_id = ?1")?;
                let ids = stmt.query_map([user_id], |r| r.get::<_, String>(0))?;
                for id in ids {
                    revoked.push(id?);
                }
                conn.execute("DELETE FROM device_sessions WHERE user_id = ?1", [user_id])?;
            }

            let refreshed = conn.query_row(
                "SELECT u.id, u.name, u.role, u.disabled, u.totp_enabled, u.created_at,
                        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS pk_count
                 FROM users u WHERE u.id = ?1",
                [user_id],
                map_auth_user,
            )?;

            Ok::<_, AuthError>((refreshed, revoked))
        })?;

        let (otpauth, qr_svg) = match new_totp {
            Some((_, u, s)) => (Some(u), Some(s)),
            None => (None, None),
        };

        Ok(UpdateUserOutcome {
            user: updated_user,
            otpauth,
            qr_svg,
            revoked_device_ids,
        })
    }

    pub fn delete_user(&self, user_id: &str) -> Result<Vec<String>> {
        self.db.transaction(|conn| {
            let current: Option<(String, i64)> = conn
                .query_row(
                    "SELECT role, disabled FROM users WHERE id = ?1",
                    [user_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((role_str, disabled)) = current else {
                return Err(AuthError::NotFound("User not found.".into()));
            };
            if role_str == "owner" && disabled == 0 {
                let other_owners: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?1",
                    [user_id],
                    |r| r.get(0),
                )?;
                if other_owners == 0 {
                    return Err(AuthError::Validation(
                        "Cannot remove the last active owner.".into(),
                    ));
                }
            }

            let mut revoked = Vec::new();
            {
                let mut stmt =
                    conn.prepare("SELECT id FROM device_sessions WHERE user_id = ?1")?;
                let ids = stmt.query_map([user_id], |r| r.get::<_, String>(0))?;
                for id in ids {
                    revoked.push(id?);
                }
            }
            conn.execute("DELETE FROM users WHERE id = ?1", [user_id])?;
            Ok::<_, AuthError>(revoked)
        })
    }

    pub async fn login_with_password(
        &self,
        name: String,
        password: String,
        meta: SessionMeta,
    ) -> Result<LoginSuccess> {
        let now_ms = Utc::now().timestamp_millis();
        let clean_name = name.trim().to_owned();
        let ip_bucket = format!("login:ip:{}", meta.client_ip);
        let name_bucket = format!("login:name:{}", clean_name.to_ascii_lowercase());

        self.throttle.check_locked(&ip_bucket, now_ms)?;
        self.throttle.check_locked(&name_bucket, now_ms)?;

        let row: Option<(AuthUser, String)> = self.db.read(|conn| {
            conn.query_row(
                "SELECT u.id, u.name, u.role, u.disabled, u.totp_enabled, u.created_at,
                        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS pk_count,
                        u.password_hash
                 FROM users u WHERE u.name = ?1 COLLATE NOCASE",
                [&clean_name],
                |r| Ok((map_auth_user(r)?, r.get(7)?)),
            )
            .optional()
            .map_err(AuthError::from)
        })?;

        let Some((user, hash)) = row else {
            verify_dummy_password(password).await;
            self.throttle.record_failure(
                &ip_bucket,
                LOGIN_MAX_FAILURES,
                LOGIN_WINDOW_MS,
                LOGIN_LOCK_MS,
                now_ms,
            )?;
            self.throttle.record_failure(
                &name_bucket,
                LOGIN_MAX_FAILURES,
                LOGIN_WINDOW_MS,
                LOGIN_LOCK_MS,
                now_ms,
            )?;
            return Err(AuthError::InvalidCredentials);
        };

        let valid = verify_password(password, hash).await?;
        if !valid {
            self.throttle.record_failure(
                &ip_bucket,
                LOGIN_MAX_FAILURES,
                LOGIN_WINDOW_MS,
                LOGIN_LOCK_MS,
                now_ms,
            )?;
            self.throttle.record_failure(
                &name_bucket,
                LOGIN_MAX_FAILURES,
                LOGIN_WINDOW_MS,
                LOGIN_LOCK_MS,
                now_ms,
            )?;
            return Err(AuthError::InvalidCredentials);
        }

        if user.disabled {
            return Err(AuthError::AccountDisabled);
        }

        self.throttle.clear(&ip_bucket)?;
        self.throttle.clear(&name_bucket)?;

        let (raw_token, session) = self.create_device_session(
            &user.id,
            meta.origin,
            meta.label,
            meta.remote,
            now_ms,
        )?;
        Ok(LoginSuccess {
            raw_token,
            session,
            user: Some(user),
        })
    }

    pub fn login_with_passkey(&self, user_id: &str, meta: SessionMeta) -> Result<LoginSuccess> {
        let user = self
            .get_user_by_id(user_id)?
            .ok_or(AuthError::InvalidCredentials)?;
        if user.disabled {
            return Err(AuthError::AccountDisabled);
        }
        let now_ms = Utc::now().timestamp_millis();
        let (raw_token, session) = self.create_device_session(
            &user.id,
            meta.origin,
            meta.label,
            meta.remote,
            now_ms,
        )?;
        Ok(LoginSuccess {
            raw_token,
            session,
            user: Some(user),
        })
    }

    pub async fn change_password(
        &self,
        user_id: &str,
        current_device_id: &str,
        current_password: String,
        new_password: String,
        meta: SessionMeta,
    ) -> Result<(String, Vec<String>)> {
        let now_ms = Utc::now().timestamp_millis();
        let bucket = format!("pw:{user_id}:{}", meta.client_ip);
        self.throttle.check_locked(&bucket, now_ms)?;
        validate_password_policy(&new_password)?;

        let existing_hash: Option<String> = self.db.read(|conn| {
            conn.query_row(
                "SELECT password_hash FROM users WHERE id = ?1 AND disabled = 0",
                [user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(AuthError::from)
        })?;
        let existing_hash =
            existing_hash.ok_or_else(|| AuthError::Unauthorized("Account unavailable.".into()))?;

        if !verify_password(current_password, existing_hash).await? {
            self.throttle.record_failure(
                &bucket,
                LOGIN_MAX_FAILURES,
                LOGIN_WINDOW_MS,
                LOGIN_LOCK_MS,
                now_ms,
            )?;
            return Err(AuthError::Validation(
                "Current password is incorrect.".into(),
            ));
        }

        self.throttle.clear(&bucket)?;
        let new_hash = hash_password(new_password).await?;
        let (new_raw_token, new_token_hash) = generate_session_token();
        let new_device_id = Uuid::new_v4().to_string();
        let expires_at = now_ms + SESSION_MAX_AGE_SECS * 1000;

        let revoked_others = self.db.transaction(|conn| {
            conn.execute(
                "UPDATE users SET password_hash = ?1 WHERE id = ?2",
                rusqlite::params![new_hash, user_id],
            )?;

            let mut revoked = Vec::new();
            {
                let mut stmt =
                    conn.prepare("SELECT id FROM device_sessions WHERE user_id = ?1")?;
                let ids = stmt.query_map([user_id], |r| r.get::<_, String>(0))?;
                for id in ids {
                    let id = id?;
                    if id != current_device_id {
                        revoked.push(id);
                    }
                }
            }

            conn.execute("DELETE FROM device_sessions WHERE user_id = ?1", [user_id])?;
            conn.execute(
                "INSERT INTO device_sessions
                    (id, user_id, token_hash, label, origin, remote, elevated_until, last_seen_at, expires_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?7)",
                rusqlite::params![
                    new_device_id,
                    user_id,
                    new_token_hash,
                    meta.label,
                    meta.origin,
                    i64::from(meta.remote),
                    now_ms,
                    expires_at
                ],
            )?;

            Ok::<_, AuthError>(revoked)
        })?;

        Ok((new_raw_token, revoked_others))
    }

    pub fn exchange_bootstrap_token(
        &self,
        provided_token: &str,
        expected_bootstrap_token: &str,
        is_local: bool,
        origin: Option<String>,
        label: String,
    ) -> Result<(String, String)> {
        let eq: bool = provided_token
            .as_bytes()
            .ct_eq(expected_bootstrap_token.as_bytes())
            .into();
        if !eq || expected_bootstrap_token.is_empty() {
            return Err(AuthError::InvalidCredentials);
        }

        let people = self.users_count()?;
        if people > 0 && !is_local {
            return Err(AuthError::Unauthorized(
                "Start-up link only works on the host machine once user accounts exist.".into(),
            ));
        }

        let now_ms = Utc::now().timestamp_millis();
        let (raw_token, token_hash) = generate_session_token();
        let device_id = Uuid::new_v4().to_string();
        let expires_at = now_ms + SESSION_MAX_AGE_SECS * 1000;

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO bootstrap_sessions
                    (id, token_hash, label, origin, remote, elevated_until, last_seen_at, expires_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?6)",
                rusqlite::params![
                    device_id,
                    token_hash,
                    label,
                    origin,
                    i64::from(!is_local),
                    now_ms,
                    expires_at
                ],
            )?;
            Ok::<_, AuthError>(())
        })?;

        Ok((raw_token, device_id))
    }

    pub fn verify_session(&self, raw_token: &str, touch: bool) -> Result<Option<VerifiedSession>> {
        let token_hash = hash_token(raw_token);
        let now_ms = Utc::now().timestamp_millis();

        let user_row = self.db.read(|conn| {
            conn.query_row(
                "SELECT d.id, d.expires_at, d.elevated_until,
                        u.id, u.name, u.role, u.disabled, u.totp_enabled, u.created_at,
                        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS pk_count
                 FROM device_sessions d
                 JOIN users u ON u.id = d.user_id
                 WHERE d.token_hash = ?1",
                [&token_hash],
                |r| {
                    let device_id: String = r.get(0)?;
                    let expires_at: i64 = r.get(1)?;
                    let elevated_until: Option<i64> = r.get(2)?;
                    let role_raw: String = r.get(5)?;
                    let user = AuthUser {
                        id: r.get(3)?,
                        name: r.get(4)?,
                        role: parse_role(&role_raw)?,
                        disabled: r.get::<_, i64>(6)? != 0,
                        totp_enabled: r.get::<_, i64>(7)? != 0,
                        passkey_count: u32::try_from(r.get::<_, i64>(9)?).unwrap_or(0),
                        created_at: format_ts(r.get::<_, i64>(8)?),
                    };
                    Ok((device_id, expires_at, elevated_until, user))
                },
            )
            .optional()
            .map_err(AuthError::from)
        })?;

        if let Some((device_id, expires_at, elevated_until, user)) = user_row {
            if expires_at <= now_ms || user.disabled {
                let _ = self.delete_session_by_id(&device_id);
                return Ok(None);
            }
            if touch {
                let _ = self.touch_device_session(&device_id, now_ms);
            }
            return Ok(Some(VerifiedSession {
                device_id,
                role: user.role,
                user: Some(user),
                elevated_until_ms: elevated_until,
                is_bootstrap: false,
            }));
        }

        // Fall back to bootstrap_sessions (only valid while 0 users OR local).
        let boot_row: Option<(String, i64, Option<i64>, i64)> = self.db.read(|conn| {
            conn.query_row(
                "SELECT id, expires_at, elevated_until, remote FROM bootstrap_sessions WHERE token_hash = ?1",
                [&token_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(AuthError::from)
        })?;

        if let Some((device_id, expires_at, elevated_until, remote_flag)) = boot_row {
            if expires_at <= now_ms {
                let _ = self.delete_bootstrap_by_id(&device_id);
                return Ok(None);
            }
            if remote_flag != 0 && self.users_count()? > 0 {
                let _ = self.delete_bootstrap_by_id(&device_id);
                return Ok(None);
            }
            if touch {
                let _ = self.db.transaction(|conn| {
                    conn.execute(
                        "UPDATE bootstrap_sessions SET last_seen_at = ?1 WHERE id = ?2",
                        rusqlite::params![now_ms, device_id],
                    )?;
                    Ok::<_, AuthError>(())
                });
            }
            return Ok(Some(VerifiedSession {
                device_id,
                role: ServerRole::Owner,
                user: None,
                elevated_until_ms: elevated_until,
                is_bootstrap: true,
            }));
        }

        Ok(None)
    }

    pub fn logout_token(&self, raw_token: &str) -> Result<()> {
        let token_hash = hash_token(raw_token);
        self.db.transaction(|conn| {
            conn.execute(
                "DELETE FROM device_sessions WHERE token_hash = ?1",
                [&token_hash],
            )?;
            conn.execute(
                "DELETE FROM bootstrap_sessions WHERE token_hash = ?1",
                [&token_hash],
            )?;
            Ok::<_, AuthError>(())
        })
    }

    pub fn list_devices(&self, user_id: &str, current_device_id: &str) -> Result<Vec<DeviceSession>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, user_id, label, origin, remote, elevated_until, last_seen_at, expires_at, created_at
                 FROM device_sessions
                 WHERE user_id = ?1
                 ORDER BY last_seen_at DESC",
            )?;
            let rows = stmt.query_map([user_id], |r| {
                let id: String = r.get(0)?;
                let elevated: Option<i64> = r.get(5)?;
                Ok(DeviceSession {
                    current: id == current_device_id,
                    id,
                    user_id: r.get(1)?,
                    label: r.get(2)?,
                    origin: r.get(3)?,
                    remote: r.get::<_, i64>(4)? != 0,
                    elevated_until: elevated.map(format_ts),
                    last_seen_at: format_ts(r.get::<_, i64>(6)?),
                    expires_at: format_ts(r.get::<_, i64>(7)?),
                    created_at: format_ts(r.get::<_, i64>(8)?),
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
    }

    pub fn revoke_device(&self, user_id: &str, device_id: &str) -> Result<bool> {
        let deleted = self.db.transaction(|conn| {
            let n = conn.execute(
                "DELETE FROM device_sessions WHERE id = ?1 AND user_id = ?2",
                rusqlite::params![device_id, user_id],
            )?;
            Ok::<_, AuthError>(n)
        })?;
        Ok(deleted > 0)
    }

    pub fn verify_totp_step_up(
        &self,
        session: &VerifiedSession,
        code: &str,
    ) -> Result<i64> {
        let now = Utc::now();
        let now_ms = now.timestamp_millis();
        let now_secs = now.timestamp();
        let bucket = match session.user.as_ref() {
            Some(u) => format!("totp:{}", u.id),
            None => "totp:bootstrap".to_owned(),
        };
        self.throttle.check_locked(&bucket, now_ms)?;

        let accepted = match session.user.as_ref() {
            Some(user) => {
                let enc: Option<String> = self.db.read(|conn| {
                    conn.query_row(
                        "SELECT totp_secret_enc FROM users WHERE id = ?1 AND disabled = 0",
                        [&user.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(AuthError::from)
                })?
                .flatten();
                let Some(enc) = enc else {
                    return Err(AuthError::Unauthorized("No TOTP configured.".into()));
                };
                let aad = format!("totp:{}", user.id);
                let secret_bytes = self.vault.decrypt(aad.as_bytes(), &enc)?;
                let secret_b32 = String::from_utf8(secret_bytes)
                    .map_err(|_| AuthError::Crypto("invalid UTF-8 TOTP secret".into()))?;
                verify_totp_for_user(&self.db, &user.id, &secret_b32, code, now_secs)?
            }
            None => verify_totp_stateless(&self.server_totp_secret, code, now_secs)?.is_some(),
        };

        if !accepted {
            self.throttle.record_failure(
                &bucket,
                TOTP_MAX_FAILURES,
                TOTP_WINDOW_MS,
                TOTP_LOCK_MS,
                now_ms,
            )?;
            return Err(AuthError::Unauthorized("Invalid or reused authenticator code.".into()));
        }

        self.throttle.clear(&bucket)?;
        let until = now_ms + STEP_UP_DURATION_MS;
        self.db.transaction(|conn| {
            if session.is_bootstrap {
                conn.execute(
                    "UPDATE bootstrap_sessions SET elevated_until = ?1 WHERE id = ?2",
                    rusqlite::params![until, session.device_id],
                )?;
            } else {
                conn.execute(
                    "UPDATE device_sessions SET elevated_until = ?1 WHERE id = ?2",
                    rusqlite::params![until, session.device_id],
                )?;
            }
            Ok::<_, AuthError>(())
        })?;

        Ok(until)
    }

    pub fn set_project_role(
        &self,
        project_id: &str,
        user_id: &str,
        role: ServerRole,
    ) -> Result<ProjectRole> {
        let now_ms = Utc::now().timestamp_millis();
        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO user_project_roles (user_id, project_id, role, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role",
                rusqlite::params![user_id, project_id, role.as_str(), now_ms],
            )?;
            Ok::<_, AuthError>(())
        })?;
        Ok(ProjectRole {
            user_id: user_id.to_owned(),
            project_id: project_id.to_owned(),
            role,
        })
    }

    pub fn remove_project_role(&self, project_id: &str, user_id: &str) -> Result<bool> {
        let n = self.db.transaction(|conn| {
            let n = conn.execute(
                "DELETE FROM user_project_roles WHERE project_id = ?1 AND user_id = ?2",
                rusqlite::params![project_id, user_id],
            )?;
            Ok::<_, AuthError>(n)
        })?;
        Ok(n > 0)
    }

    pub fn list_project_roles(&self, project_id: &str) -> Result<Vec<ProjectRole>> {
        self.db.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT user_id, project_id, role FROM user_project_roles WHERE project_id = ?1 ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map([project_id], |r| {
                let role_raw: String = r.get(2)?;
                Ok(ProjectRole {
                    user_id: r.get(0)?,
                    project_id: r.get(1)?,
                    role: parse_role(&role_raw)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
    }

    pub fn get_project_role(
        &self,
        project_id: &str,
        user_id: &str,
    ) -> Result<Option<ServerRole>> {
        self.db.read(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT role FROM user_project_roles WHERE project_id = ?1 AND user_id = ?2",
                    rusqlite::params![project_id, user_id],
                    |r| r.get(0),
                )
                .optional()?;
            match raw {
                Some(r) => Ok(Some(parse_role(&r)?)),
                None => Ok(None),
            }
        })
    }

    fn create_device_session(
        &self,
        user_id: &str,
        origin: Option<String>,
        label: String,
        remote: bool,
        now_ms: i64,
    ) -> Result<(String, DeviceSession)> {
        let (raw_token, token_hash) = generate_session_token();
        let id = Uuid::new_v4().to_string();
        let expires_at = now_ms + SESSION_MAX_AGE_SECS * 1000;
        let clean_label: String = if label.trim().is_empty() {
            "Browser".to_owned()
        } else {
            label.trim().chars().take(100).collect()
        };

        self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO device_sessions
                    (id, user_id, token_hash, label, origin, remote, elevated_until, last_seen_at, expires_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?7)",
                rusqlite::params![
                    id,
                    user_id,
                    token_hash,
                    clean_label,
                    origin,
                    i64::from(remote),
                    now_ms,
                    expires_at
                ],
            )?;
            Ok::<_, AuthError>(())
        })?;

        let session = DeviceSession {
            id,
            user_id: user_id.to_owned(),
            label: clean_label,
            origin,
            remote,
            elevated_until: None,
            last_seen_at: format_ts(now_ms),
            expires_at: format_ts(expires_at),
            created_at: format_ts(now_ms),
            current: true,
        };
        Ok((raw_token, session))
    }

    fn delete_session_by_id(&self, id: &str) -> Result<()> {
        self.db.transaction(|conn| {
            conn.execute("DELETE FROM device_sessions WHERE id = ?1", [id])?;
            Ok::<_, AuthError>(())
        })
    }

    fn delete_bootstrap_by_id(&self, id: &str) -> Result<()> {
        self.db.transaction(|conn| {
            conn.execute("DELETE FROM bootstrap_sessions WHERE id = ?1", [id])?;
            Ok::<_, AuthError>(())
        })
    }

    fn touch_device_session(&self, id: &str, now_ms: i64) -> Result<()> {
        self.db.transaction(|conn| {
            conn.execute(
                "UPDATE device_sessions SET last_seen_at = ?1 WHERE id = ?2",
                rusqlite::params![now_ms, id],
            )?;
            Ok::<_, AuthError>(())
        })
    }
}

fn generate_session_token() -> (String, String) {
    let mut raw = [0u8; 32];
    UnwrapErr(SysRng).fill_bytes(&mut raw);
    let hex_token = hex::encode(raw);
    let hash = hash_token(&hex_token);
    (hex_token, hash)
}

#[must_use]
pub fn hash_token(raw_token: &str) -> String {
    hex::encode(Sha256::digest(raw_token.as_bytes()))
}

fn format_ts(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn parse_role(raw: &str) -> std::result::Result<ServerRole, rusqlite::Error> {
    match raw {
        "owner" => Ok(ServerRole::Owner),
        "operator" => Ok(ServerRole::Operator),
        "viewer" => Ok(ServerRole::Viewer),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("invalid server role: {other}").into(),
        )),
    }
}

fn map_auth_user(r: &rusqlite::Row<'_>) -> std::result::Result<AuthUser, rusqlite::Error> {
    let role_raw: String = r.get(2)?;
    let pk_count: i64 = r.get(6)?;
    Ok(AuthUser {
        id: r.get(0)?,
        name: r.get(1)?,
        role: parse_role(&role_raw)?,
        disabled: r.get::<_, i64>(3)? != 0,
        totp_enabled: r.get::<_, i64>(4)? != 0,
        passkey_count: u32::try_from(pk_count).unwrap_or(0),
        created_at: format_ts(r.get::<_, i64>(5)?),
    })
}
