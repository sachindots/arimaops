// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_db::DbError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("database error: {0}")]
    Db(#[from] DbError),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Validation(String),
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("account is disabled")]
    AccountDisabled,
    #[error("too many attempts; wait {retry_after_secs}s")]
    Throttled { retry_after_secs: u64 },
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("malformed cookie encoding")]
    MalformedCookie,
    #[error("cryptographic error: {0}")]
    Crypto(String),
    #[error("passkey error: {0}")]
    Passkey(String),
}

pub type Result<T> = std::result::Result<T, AuthError>;
