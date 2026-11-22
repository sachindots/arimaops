// SPDX-License-Identifier: AGPL-3.0-or-later

use arima_db::Db;
use rusqlite::OptionalExtension;

use crate::error::{AuthError, Result};

/// SQLite-backed rate limiter / lockout tracker so restart never clears login or TOTP lockouts.
#[derive(Debug, Clone)]
pub struct AuthThrottle {
    db: Db,
}

impl AuthThrottle {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Returns `Err(AuthError::Throttled)` if `bucket` is currently locked.
    pub fn check_locked(&self, bucket: &str, now_ms: i64) -> Result<()> {
        let locked_until: Option<i64> = self.db.read(|conn| {
            conn.query_row(
                "SELECT locked_until FROM auth_throttle WHERE bucket = ?1",
                [bucket],
                |r| r.get(0),
            )
            .optional()
            .map_err(AuthError::from)
        })?;
        if let Some(until) = locked_until {
            if until > now_ms {
                let secs = u64::try_from((until - now_ms + 999) / 1000).unwrap_or(1);
                return Err(AuthError::Throttled {
                    retry_after_secs: secs.max(1),
                });
            }
        }
        Ok(())
    }

    /// Increments failure counter for `bucket`, locking for `lock_ms` when reaching `max_failures`.
    pub fn record_failure(
        &self,
        bucket: &str,
        max_failures: i64,
        window_ms: i64,
        lock_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        self.db.transaction(|conn| {
            let existing: Option<(i64, i64, i64)> = conn
                .query_row(
                    "SELECT failures, window_start, locked_until FROM auth_throttle WHERE bucket = ?1",
                    [bucket],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;

            let (failures, window_start, locked_until) = match existing {
                Some((prev_failures, prev_start, prev_locked)) => {
                    if prev_locked > now_ms {
                        (prev_failures + 1, prev_start, prev_locked)
                    } else if now_ms - prev_start >= window_ms || prev_locked > 0 {
                        let next_failures = 1;
                        let next_lock = if next_failures >= max_failures {
                            now_ms + lock_ms
                        } else {
                            0
                        };
                        (next_failures, now_ms, next_lock)
                    } else {
                        let next_failures = prev_failures + 1;
                        let next_lock = if next_failures >= max_failures {
                            now_ms + lock_ms
                        } else {
                            0
                        };
                        (next_failures, prev_start, next_lock)
                    }
                }
                None => {
                    let next_lock = if 1 >= max_failures {
                        now_ms + lock_ms
                    } else {
                        0
                    };
                    (1, now_ms, next_lock)
                }
            };

            conn.execute(
                "INSERT INTO auth_throttle (bucket, failures, window_start, locked_until)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(bucket) DO UPDATE SET
                   failures = excluded.failures,
                   window_start = excluded.window_start,
                   locked_until = excluded.locked_until",
                rusqlite::params![bucket, failures, window_start, locked_until],
            )?;
            Ok::<_, AuthError>(())
        })
    }

    /// Clears failure history for `bucket` upon successful authentication.
    pub fn clear(&self, bucket: &str) -> Result<()> {
        self.db.transaction(|conn| {
            conn.execute("DELETE FROM auth_throttle WHERE bucket = ?1", [bucket])?;
            Ok::<_, AuthError>(())
        })
    }
}
