// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_db::Db;
use base32::Alphabet;
use chrono::Utc;
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use qrcode::render::svg;
use qrcode::QrCode;
use rand::rngs::OsRng;
use rand::RngCore;
use rusqlite::OptionalExtension;
use sha1::Sha1;
use subtle::ConstantTimeEq;

use crate::error::{AuthError, Result};

type HmacSha1 = Hmac<Sha1>;

pub const TOTP_PERIOD_SECS: i64 = 30;
pub const TOTP_DIGITS: u32 = 6;

/// Generates a random 20-byte RFC 4648 Base32 secret (no padding).
#[must_use]
pub fn generate_secret_b32() -> String {
    let mut raw = [0u8; 20];
    OsRng.fill_bytes(&mut raw);
    base32::encode(Alphabet::Rfc4648 { padding: false }, &raw)
}

/// Formats a standard `otpauth://totp/...` URI for authenticator apps.
#[must_use]
pub fn otpauth_uri(user_name: &str, secret_b32: &str) -> String {
    let label = utf8_percent_encode(&format!("ArimaOps:{user_name}"), NON_ALPHANUMERIC).to_string();
    format!("otpauth://totp/{label}?secret={secret_b32}&issuer=ArimaOps&digits=6&period=30")
}

/// Renders an SVG QR code string for `otpauth_uri` (rendered safely via `<img src="data:image/svg+xml,...">`).
pub fn render_qr_svg(otpauth_uri: &str) -> Result<String> {
    let code = QrCode::new(otpauth_uri.as_bytes())
        .map_err(|e| AuthError::Crypto(format!("qr encode failed: {e}")))?;
    Ok(code
        .render::<svg::Color<'_>>()
        .min_dimensions(180, 180)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

/// Computes the 6-digit RFC 6238 TOTP code for a given 30-second `step`.
pub fn totp_code_for_step(secret_b32: &str, step: i64) -> Result<String> {
    let normalized = secret_b32.trim().replace(' ', "").to_ascii_uppercase();
    let key = base32::decode(Alphabet::Rfc4648 { padding: false }, &normalized)
        .ok_or_else(|| AuthError::Crypto("invalid base32 TOTP secret".into()))?;
    let counter = u64::try_from(step)
        .map_err(|_| AuthError::Crypto("negative TOTP step".into()))?
        .to_be_bytes();
    let mut mac = <HmacSha1 as Mac>::new_from_slice(&key)
        .map_err(|e| AuthError::Crypto(format!("hmac init failed: {e}")))?;
    mac.update(&counter);
    let hash = mac.finalize().into_bytes();
    let offset = usize::from(hash[19] & 0x0f);
    let bin = ((u32::from(hash[offset]) & 0x7f) << 24)
        | (u32::from(hash[offset + 1]) << 16)
        | (u32::from(hash[offset + 2]) << 8)
        | u32::from(hash[offset + 3]);
    let otp = bin % 10u32.pow(TOTP_DIGITS);
    Ok(format!("{otp:06}"))
}

/// Constant-time stateless TOTP check across `step - 1 ..= step + 1`, returning the matched step.
pub fn verify_totp_stateless(secret_b32: &str, code: &str, now_secs: i64) -> Result<Option<i64>> {
    let clean: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() != 6 || !clean.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(None);
    }
    let current_step = now_secs.div_euclid(TOTP_PERIOD_SECS);
    let mut matched: Option<i64> = None;
    for candidate in (current_step - 1)..=(current_step + 1) {
        let expected = totp_code_for_step(secret_b32, candidate)?;
        if expected.as_bytes().ct_eq(clean.as_bytes()).into() {
            matched = Some(candidate);
        }
    }
    Ok(matched)
}

/// Constant-time TOTP check for a user with SQLite replay rejection (`totp_used_steps`).
pub fn verify_totp_for_user(
    db: &Db,
    user_id: &str,
    secret_b32: &str,
    code: &str,
    now_secs: i64,
) -> Result<bool> {
    let Some(step) = verify_totp_stateless(secret_b32, code, now_secs)? else {
        return Ok(false);
    };
    let now_ms = Utc::now().timestamp_millis();
    let accepted = db.transaction(|conn| {
        let already: Option<i64> = conn
            .query_row(
                "SELECT step FROM totp_used_steps WHERE user_id = ?1 AND step = ?2",
                rusqlite::params![user_id, step],
                |r| r.get(0),
            )
            .optional()?;
        if already.is_some() {
            return Ok::<_, AuthError>(false);
        }
        conn.execute(
            "INSERT INTO totp_used_steps (user_id, step, used_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![user_id, step, now_ms],
        )?;
        // Prune stale replay entries older than 10 steps (~5 minutes).
        conn.execute(
            "DELETE FROM totp_used_steps WHERE user_id = ?1 AND step < ?2",
            rusqlite::params![user_id, step - 10],
        )?;
        Ok::<_, AuthError>(true)
    })?;
    Ok(accepted)
}
