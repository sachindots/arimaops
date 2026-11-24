// SPDX-License-Identifier: AGPL-3.0-or-later

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::Argon2;

use crate::error::{AuthError, Result};

pub const MIN_PASSWORD_LEN: usize = 10;
pub const MAX_PASSWORD_LEN: usize = 200;

/// Precomputed dummy Argon2id hash used so unknown usernames take equivalent CPU work.
const DUMMY_PASSWORD_HASH: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// Validates password policy (`10..=200` characters).
pub fn validate_password_policy(plain: &str) -> Result<()> {
    let len = plain.chars().count();
    if !(MIN_PASSWORD_LEN..=MAX_PASSWORD_LEN).contains(&len) {
        return Err(AuthError::Validation(format!(
            "Password must be between {MIN_PASSWORD_LEN} and {MAX_PASSWORD_LEN} characters."
        )));
    }
    Ok(())
}

/// Hashes a password with Argon2id on a blocking worker thread.
pub async fn hash_password(plain: String) -> Result<String> {
    validate_password_policy(&plain)?;
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(plain.as_bytes())
            .map(|h| h.to_string())
            .map_err(|e| AuthError::Crypto(format!("argon2 hash failed: {e}")))
    })
    .await
    .map_err(|e| AuthError::Crypto(format!("hash task panicked: {e}")))?
}

/// Verifies `plain` against a PHC Argon2id string on a blocking worker thread.
pub async fn verify_password(plain: String, phc_hash: String) -> Result<bool> {
    if plain.chars().count() > MAX_PASSWORD_LEN {
        return Ok(false);
    }
    tokio::task::spawn_blocking(move || {
        let parsed = PasswordHash::new(&phc_hash)
            .map_err(|e| AuthError::Crypto(format!("invalid password hash: {e}")))?;
        Ok(Argon2::default()
            .verify_password(plain.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|e| AuthError::Crypto(format!("verify task panicked: {e}")))?
}

/// Runs a dummy Argon2id check when the username does not exist to prevent timing enumeration.
pub async fn verify_dummy_password(plain: String) {
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(parsed) = PasswordHash::new(DUMMY_PASSWORD_HASH) {
            let _ = Argon2::default().verify_password(plain.as_bytes(), &parsed);
        }
    })
    .await;
}
