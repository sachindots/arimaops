// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::IpAddr;

use percent_encoding::percent_decode;

use crate::error::{AuthError, Result};

pub const SESSION_COOKIE_NAME: &str = "hq_sid";
pub const SESSION_MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;

/// Strict percent-decoding that rejects malformed `%XX` escapes and invalid UTF-8
/// instead of crashing or silently passing invalid sequences.
pub fn strict_percent_decode(raw: &str) -> Result<String> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return Err(AuthError::MalformedCookie);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    let decoded = percent_decode(bytes)
        .decode_utf8()
        .map_err(|_| AuthError::MalformedCookie)?;
    Ok(decoded.into_owned())
}

/// Parses cookie `name` from a raw `Cookie` HTTP header safely.
pub fn parse_cookie(cookie_header: &str, name: &str) -> Result<Option<String>> {
    for part in cookie_header.split(';') {
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == name {
                return Ok(Some(strict_percent_decode(v.trim())?));
            }
        }
    }
    Ok(None)
}

/// Builds an `HttpOnly; SameSite=Strict` `Set-Cookie` header value.
#[must_use]
pub fn build_session_cookie(token: &str, secure: bool, max_age_secs: i64) -> String {
    let mut header = format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age_secs}"
    );
    if secure {
        header.push_str("; Secure");
    }
    header
}

/// Builds a clearing `Set-Cookie` header value for sign-out.
#[must_use]
pub fn build_clear_cookie(secure: bool) -> String {
    let mut header = format!("{SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    if secure {
        header.push_str("; Secure");
    }
    header
}

/// Extracts client IP from `peer_ip`, only honoring `X-Forwarded-For` when explicitly trusted
/// AND `peer_ip` is loopback (prevents header spoofing bypasses on login rate limiting).
#[must_use]
pub fn extract_client_ip(peer_ip: IpAddr, xff: Option<&str>, trust_proxy: bool) -> String {
    if trust_proxy && peer_ip.is_loopback() {
        if let Some(header) = xff {
            // Take the right-most valid IP added by the immediate trusted proxy hop,
            // or the first valid IP if single-hop; fall back to peer_ip if malformed.
            if let Some(candidate) = header
                .split(',')
                .rev()
                .map(str::trim)
                .find(|part| part.parse::<IpAddr>().is_ok())
            {
                return candidate.to_owned();
            }
        }
    }
    peer_ip.to_string()
}
