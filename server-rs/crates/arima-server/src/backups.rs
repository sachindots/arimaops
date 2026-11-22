// SPDX-License-Identifier: AGPL-3.0-or-later

//! Encrypted backup management (`ARIMABK2`), verification, atomic restore, and
//! scheduled nightly backup background task with configurable retention pruning.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use arima_db::{
    create_encrypted_backup, list_backups, prune_old_backups, restore_encrypted_backup,
    validate_backup_id, verify_encrypted_backup, BackupManifest, BackupSummary, DbError,
    RestoreOutcome,
};
use chrono::{DateTime, Timelike, Utc};
use tracing::{info, warn};

use crate::state::AppState;

pub const DEFAULT_BACKUP_RETENTION: usize = 7;

/// Resolves the directory where encrypted `.arimabak` archives are stored.
#[must_use]
pub fn backups_dir_for(state: &AppState) -> PathBuf {
    if let Some(ref root) = state.inner.config.data_root {
        root.join("backups")
    } else {
        state.inner.fallback_backups_dir.clone()
    }
}

/// Derives the 32-byte archive key material from the server's `VaultKey`.
#[must_use]
pub fn backup_key_material(state: &AppState) -> [u8; 32] {
    state.inner.auth.vault().derive_subkey(b"arima-backup-v2")
}

/// Creates a new encrypted backup archive and applies retention pruning.
pub fn create_backup_now(
    state: &AppState,
    prefix: &str,
) -> Result<(BackupSummary, BackupManifest), DbError> {
    let bdir = backups_dir_for(state);
    let key = backup_key_material(state);
    let (summary, manifest, _bytes) = create_encrypted_backup(
        &state.inner.db,
        state.inner.config.data_root.as_deref(),
        &bdir,
        &key,
        prefix,
    )?;
    let _ = prune_old_backups(&bdir, state.inner.backup_retention);
    Ok((summary, manifest))
}

/// Lists all encrypted `.arimabak` backups, newest first.
pub fn list_stored_backups(state: &AppState) -> Result<Vec<BackupSummary>, DbError> {
    list_backups(&backups_dir_for(state))
}

/// Reads raw encrypted bytes of a stored backup archive after strict ID validation.
pub fn read_stored_backup(state: &AppState, id: &str) -> Result<(String, Vec<u8>), DbError> {
    let safe_id = validate_backup_id(id)?;
    let path = backups_dir_for(state).join(&safe_id);
    let md = fs::symlink_metadata(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            DbError::InvalidInput(format!("backup '{safe_id}' not found"))
        } else {
            DbError::Io(e)
        }
    })?;
    if md.file_type().is_symlink() || !md.is_file() {
        return Err(DbError::InvalidInput(format!(
            "backup '{safe_id}' is not a regular file"
        )));
    }
    let bytes = fs::read(&path)?;
    Ok((safe_id, bytes))
}

/// Non-mutating verification of raw archive bytes.
pub fn verify_backup_bytes(state: &AppState, bytes: &[u8]) -> Result<BackupManifest, DbError> {
    let key = backup_key_material(state);
    verify_encrypted_backup(bytes, &key)
}

/// Atomically restores live DB + vault + `evidence/` + `feedback/` after verifying and
/// saving a pre-restore safety snapshot.
pub fn restore_backup_bytes(state: &AppState, bytes: &[u8]) -> Result<RestoreOutcome, DbError> {
    let bdir = backups_dir_for(state);
    let key = backup_key_material(state);
    restore_encrypted_backup(
        &state.inner.db,
        state.inner.config.data_root.as_deref(),
        Some(&bdir),
        bytes,
        &key,
    )
}

/// Returns `true` when the nightly 03:00 UTC backup window is active and hasn't run today yet.
#[must_use]
pub fn should_run_nightly_backup(now: DateTime<Utc>, last_run_day: Option<&str>) -> bool {
    let today = now.format("%Y-%m-%d").to_string();
    if last_run_day == Some(today.as_str()) {
        return false;
    }
    now.hour() == 3
}

/// Spawns the scheduled nightly encrypted backup loop (runs at 03:00 UTC and prunes to retention).
pub fn spawn_nightly_backup_scheduler(state: AppState) -> tokio::task::JoinHandle<()> {
    let last_day: Mutex<Option<String>> = Mutex::new(None);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15 * 60));
        loop {
            interval.tick().await;
            let now = Utc::now();
            let should_run = {
                let guard = last_day.lock().ok();
                let prev = guard.as_deref().and_then(|o| o.as_deref());
                should_run_nightly_backup(now, prev)
            };
            if should_run {
                match create_backup_now(&state, "arima-nightly") {
                    Ok((summary, _)) => {
                        if let Ok(mut guard) = last_day.lock() {
                            *guard = Some(now.format("%Y-%m-%d").to_string());
                        }
                        info!(
                            "scheduled nightly encrypted backup created: {} ({} bytes)",
                            summary.filename, summary.size_bytes
                        );
                    }
                    Err(err) => {
                        warn!("scheduled nightly encrypted backup failed: {err}");
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn nightly_backup_window_runs_once_per_day_at_0300_utc() {
        let dt_02 = Utc.with_ymd_and_hms(2026, 11, 22, 2, 59, 0).unwrap();
        let dt_03 = Utc.with_ymd_and_hms(2026, 11, 22, 3, 5, 0).unwrap();
        let dt_04 = Utc.with_ymd_and_hms(2026, 11, 22, 4, 0, 0).unwrap();

        assert!(!should_run_nightly_backup(dt_02, None));
        assert!(should_run_nightly_backup(dt_03, None));
        assert!(!should_run_nightly_backup(dt_03, Some("2026-11-22")));
        assert!(should_run_nightly_backup(dt_03, Some("2026-11-21")));
        assert!(!should_run_nightly_backup(dt_04, None));
    }
}
