// SPDX-License-Identifier: AGPL-3.0-or-later

//! Consolidated SQLite persistence layer for ArimaOps v2.0.
//!
//! Enforces WAL mode, `PRAGMA foreign_keys = ON` on every connection, `0600` database
//! file permissions, nested `SAVEPOINT` transactions, crash-safe agent outbox queues,
//! complete project purging, and atomic `VACUUM INTO` backups.

pub mod backup;
pub mod decisions;
pub mod factory;
pub mod feedback;
pub mod findings;
pub mod gates;
pub mod meetings;
pub mod memory;
pub mod migrate_v1;
pub mod migrations;
pub mod outbox;
pub mod purge;
pub mod usage;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use thiserror::Error;

pub use backup::{
    backup_sqlite_to, create_encrypted_backup, list_backups, prune_old_backups,
    restore_encrypted_backup, validate_backup_id, verify_encrypted_backup, BackupManifest,
    BackupSummary, RestoreOutcome,
};
pub use decisions::{classify_owner_only, DecisionsRepo, ResolveDecisionInput};
pub use factory::{
    BenchmarkCaseResult, BenchmarkRun, CreateProposalInput, FactoryMetricsReport, FactoryRepo,
    FactoryWindowMetrics, ImprovementProposal, RecordScoreInput, ServerSettingsRepo,
    TaskScoreRecord,
};
pub use feedback::FeedbackRepo;
pub use findings::{
    parse_and_score_cvss4, severity_from_cvss_score, CreateFindingInput, Cvss4Result, FindingsRepo,
    ProjectScope, SecurityFinding, UpdateFindingInput,
};
pub use gates::{is_owner_only_gate, GateEventRecord, GatesRepo};
pub use meetings::{CommitMinutesSummary, MeetingsRepo};
pub use memory::{
    sanitize_fts5_query, scrub_sensitive_and_keep_out, CreateMemoryInput, MemoryExtractionConfig,
    MemoryRecord, MemoryRepo, MemorySettings, MemoryStatusFilter, PromotedLesson, VaultSecretMeta,
    VaultSecretRecord, VaultSecretRepo, DEFAULT_UNCERTIFIED_DECAY_DAYS,
};
pub use migrate_v1::{migrate_v1_data, MigrateV1Options, MigrateV1Report};
pub use outbox::OutboxRepo;
pub use purge::{forget_project, PurgeSummary};
pub use usage::{AgentUsageRow, ProjectUsageReport, UsageEventInput, UsageRepo};

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid identifier: {0}")]
    InvalidInput(String),
    #[error("database mutex poisoned")]
    LockPoisoned,
}

pub type Result<T> = std::result::Result<T, DbError>;

#[derive(Debug)]
struct DbInner {
    conn: Mutex<Connection>,
    sp_seq: AtomicU64,
    path: Option<PathBuf>,
}

impl Drop for DbInner {
    fn drop(&mut self) {
        if self.path.is_some() {
            if let Ok(conn) = self.conn.lock() {
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            }
        }
    }
}

/// Thread-safe handle to the unified ArimaOps v2 SQLite database.
#[derive(Debug, Clone)]
pub struct Db {
    inner: Arc<DbInner>,
}

impl Db {
    /// Opens or creates the SQLite database at `path` with strict `0700`/`0600` permissions,
    /// WAL journaling, `busy_timeout = 5000`, `foreign_keys = ON`, and runs pending migrations.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            ensure_private_dir(parent)?;
        }
        ensure_private_file(path)?;

        let conn = Connection::open(path)?;
        configure_connection(&conn, true)?;
        migrations::migrate(&conn)?;

        Ok(Self {
            inner: Arc::new(DbInner {
                conn: Mutex::new(conn),
                sp_seq: AtomicU64::new(1),
                path: Some(path.to_path_buf()),
            }),
        })
    }

    /// Opens a fresh in-memory SQLite database with `foreign_keys = ON` and all migrations applied.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        configure_connection(&conn, false)?;
        migrations::migrate(&conn)?;

        Ok(Self {
            inner: Arc::new(DbInner {
                conn: Mutex::new(conn),
                sp_seq: AtomicU64::new(1),
                path: None,
            }),
        })
    }

    /// Executes a read-only closure while holding the database connection lock.
    pub fn read<T, E>(&self, f: impl FnOnce(&Connection) -> std::result::Result<T, E>) -> std::result::Result<T, E>
    where
        E: From<DbError>,
    {
        let conn = self.inner.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        f(&conn)
    }

    /// Runs `f` inside a `SAVEPOINT` transaction so top-level and nested writes behave identically.
    pub fn transaction<T, E>(
        &self,
        f: impl FnOnce(&Connection) -> std::result::Result<T, E>,
    ) -> std::result::Result<T, E>
    where
        E: From<DbError>,
    {
        let conn = self.inner.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        self.savepoint(&conn, f)
    }

    /// Runs `f` inside a `SAVEPOINT` on an already-locked `&Connection` without deadlocking.
    pub fn savepoint<T, E>(
        &self,
        conn: &Connection,
        f: impl FnOnce(&Connection) -> std::result::Result<T, E>,
    ) -> std::result::Result<T, E>
    where
        E: From<DbError>,
    {
        run_savepoint(conn, &self.inner.sp_seq, f)
    }

    /// Flushes WAL pages into the main database file (`TRUNCATE` checkpoint).
    pub fn checkpoint(&self) -> Result<()> {
        let conn = self.inner.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    /// Explicitly checkpoints the WAL and consumes this handle.
    pub fn checkpoint_and_close(self) -> Result<()> {
        self.checkpoint()?;
        drop(self);
        Ok(())
    }

    /// Atomically replaces the live database contents from a verified SQLite file using
    /// SQLite's online Backup API (safe for both file-backed WAL databases and in-memory DBs).
    pub fn restore_from_sqlite_file(&self, src_path: &Path) -> Result<()> {
        let src = Connection::open(src_path)?;
        let integrity: String = src.query_row("PRAGMA integrity_check;", [], |r| r.get(0))?;
        if !integrity.eq_ignore_ascii_case("ok") {
            return Err(DbError::InvalidInput(format!(
                "source SQLite integrity check failed: {integrity}"
            )));
        }

        let mut dst = self.inner.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        {
            let backup = rusqlite::backup::Backup::new(&src, &mut dst)?;
            backup.run_to_completion(128, Duration::from_millis(5), None)?;
        }
        configure_connection(&dst, self.inner.path.is_some())?;
        migrations::migrate(&dst)?;
        if self.inner.path.is_some() {
            let _ = dst.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        Ok(())
    }

    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.inner.path.as_deref()
    }
}

/// Executes `f` inside a named SQLite `SAVEPOINT` on an existing `&Connection`.
pub fn run_savepoint<T, E>(
    conn: &Connection,
    seq: &AtomicU64,
    f: impl FnOnce(&Connection) -> std::result::Result<T, E>,
) -> std::result::Result<T, E>
where
    E: From<DbError>,
{
    let id = seq.fetch_add(1, Ordering::Relaxed);
    let sp_name = format!("sp_{id}");
    conn.execute_batch(&format!("SAVEPOINT {sp_name};"))
        .map_err(DbError::from)?;
    match f(conn) {
        Ok(val) => {
            conn.execute_batch(&format!("RELEASE SAVEPOINT {sp_name};"))
                .map_err(DbError::from)?;
            Ok(val)
        }
        Err(err) => {
            let _ = conn.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {sp_name}; RELEASE SAVEPOINT {sp_name};"
            ));
            Err(err)
        }
    }
}

fn configure_connection(conn: &Connection, file_backed: bool) -> Result<()> {
    if file_backed {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;",
        )?;
    } else {
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;",
        )?;
    }
    Ok(())
}

fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if !dir.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)?;
    }
    Ok(())
}

fn ensure_private_file(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)?;
        }
        #[cfg(not(unix))]
        {
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
