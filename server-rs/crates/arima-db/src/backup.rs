// SPDX-License-Identifier: AGPL-3.0-or-later

//! Consistent SQLite snapshots (`VACUUM INTO`) and AES-256-GCM + Argon2id encrypted
//! full-system backup, non-mutating integrity verification, atomic restore, and retention pruning.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use rand::Rng;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Db, DbError, Result};

const ARCHIVE_MAGIC: &[u8; 8] = b"ARIMABK2";
const ARCHIVE_VERSION: u8 = 2;
const ARCHIVE_KDF_ARGON2ID: u8 = 1;
const HEADER_AAD_LEN: usize = 8 + 1 + 1 + 16; // magic + version + kdf + salt
const NONCE_LEN: usize = 12;
const MIN_ARCHIVE_LEN: usize = HEADER_AAD_LEN + NONCE_LEN + 16; // + GCM auth tag
const MAX_RESTORE_FILES: usize = 10_000;
const MAX_SINGLE_FILE_BYTES: usize = 32 * 1024 * 1024;

/// Creates a consistent SQLite snapshot at `dest` using parameterized `VACUUM INTO` and
/// an atomic same-directory rename, locking permissions to `0600` on Unix.
pub fn backup_sqlite_to(db: &Db, dest: &Path) -> Result<()> {
    let parent = dest.parent().ok_or_else(|| {
        DbError::InvalidInput("backup destination must have a parent directory".into())
    })?;
    fs::create_dir_all(parent)?;

    let tmp_name = format!(
        ".{}.{}.tmp",
        dest.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("arima"),
        Uuid::new_v4()
    );
    let tmp_path = parent.join(tmp_name);
    let tmp_str = tmp_path.to_str().ok_or_else(|| {
        DbError::InvalidInput("backup destination path must be valid UTF-8".into())
    })?;

    db.read(|conn| {
        conn.execute("VACUUM INTO ?1", [tmp_str])?;
        Ok::<_, DbError>(())
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;
    }

    fs::rename(&tmp_path, dest)?;
    Ok(())
}

/// Summary metadata for a stored `.arimabak` encrypted backup file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub id: String,
    pub filename: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub includes: Vec<String>,
}

/// Non-mutating verification manifest produced by [`verify_encrypted_backup`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub valid: bool,
    pub integrity_ok: bool,
    pub integrity_detail: String,
    pub format_version: u32,
    pub created_at: String,
    pub db_bytes: usize,
    pub projects_count: usize,
    pub users_count: usize,
    pub memories_count: usize,
    pub findings_count: usize,
    pub vault_secrets_count: usize,
    pub evidence_files: usize,
    pub feedback_files: usize,
    pub includes: Vec<String>,
}

/// Outcome of an atomic restore operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub manifest: BackupManifest,
    pub pre_restore_backup: Option<BackupSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileEntry {
    rel_path: String,
    sha256: String,
    content_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupBundle {
    format_version: u32,
    created_at: String,
    engine_version: String,
    db_b64: String,
    db_sha256: String,
    vault_metadata: Value,
    #[serde(default)]
    vault_key_hex: Option<String>,
    #[serde(default)]
    files: Vec<BackupFileEntry>,
}

/// Validates that a backup filename/id is strictly safe (`[A-Za-z0-9._-]+.arimabak`).
pub fn validate_backup_id(id: &str) -> Result<String> {
    let trimmed = id.trim();
    let ok = !trimmed.is_empty()
        && trimmed.ends_with(".arimabak")
        && !trimmed.contains("..")
        && !trimmed.contains('/')
        && !trimmed.contains('\\')
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !ok {
        return Err(DbError::InvalidInput(format!(
            "invalid backup archive id '{trimmed}'"
        )));
    }
    Ok(trimmed.to_owned())
}

fn derive_archive_key(key_material: &[u8], salt: &[u8; 16]) -> Result<[u8; 32]> {
    let params = Params::new(8192, 2, 1, Some(32))
        .map_err(|e| DbError::InvalidInput(format!("argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut derived = [0u8; 32];
    argon2
        .hash_password_into(key_material, salt, &mut derived)
        .map_err(|e| DbError::InvalidInput(format!("argon2 key derivation failed: {e}")))?;
    Ok(derived)
}

fn encrypt_bundle(bundle: &BackupBundle, key_material: &[u8]) -> Result<Vec<u8>> {
    let plaintext = serde_json::to_vec(bundle)
        .map_err(|e| DbError::InvalidInput(format!("serialize backup bundle: {e}")))?;

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    UnwrapErr(SysRng).fill_bytes(&mut salt);
    UnwrapErr(SysRng).fill_bytes(&mut nonce_bytes);

    let key = derive_archive_key(key_material, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| DbError::InvalidInput(format!("cipher init: {e}")))?;

    let mut header = Vec::with_capacity(HEADER_AAD_LEN);
    header.extend_from_slice(ARCHIVE_MAGIC);
    header.push(ARCHIVE_VERSION);
    header.push(ARCHIVE_KDF_ARGON2ID);
    header.extend_from_slice(&salt);

    let ciphertext = cipher
        .encrypt(
            &Nonce::from(nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &header,
            },
        )
        .map_err(|e| DbError::InvalidInput(format!("backup encryption failed: {e}")))?;

    let mut archive = Vec::with_capacity(HEADER_AAD_LEN + NONCE_LEN + ciphertext.len());
    archive.extend_from_slice(&header);
    archive.extend_from_slice(&nonce_bytes);
    archive.extend_from_slice(&ciphertext);
    Ok(archive)
}

fn decrypt_bundle(archive_bytes: &[u8], key_material: &[u8]) -> Result<BackupBundle> {
    if archive_bytes.len() < MIN_ARCHIVE_LEN {
        return Err(DbError::InvalidInput(
            "backup archive is truncated or corrupt".into(),
        ));
    }
    if &archive_bytes[0..8] != ARCHIVE_MAGIC {
        return Err(DbError::InvalidInput(
            "invalid backup archive header (expected ARIMABK2)".into(),
        ));
    }
    let version = archive_bytes[8];
    let kdf = archive_bytes[9];
    if version != ARCHIVE_VERSION || kdf != ARCHIVE_KDF_ARGON2ID {
        return Err(DbError::InvalidInput(format!(
            "unsupported backup archive version={version} kdf={kdf}"
        )));
    }
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&archive_bytes[10..26]);
    let aad = &archive_bytes[0..HEADER_AAD_LEN];
    let nonce_bytes = &archive_bytes[HEADER_AAD_LEN..HEADER_AAD_LEN + NONCE_LEN];
    let ciphertext = &archive_bytes[HEADER_AAD_LEN + NONCE_LEN..];

    let key = derive_archive_key(key_material, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| DbError::InvalidInput(format!("cipher init: {e}")))?;

    let plaintext = cipher
        .decrypt(
            &Nonce::try_from(nonce_bytes)
                .map_err(|_| DbError::InvalidInput("bad backup nonce length".into()))?,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| {
            DbError::InvalidInput(
                "backup archive authentication failed: tampered data or wrong vault key".into(),
            )
        })?;

    serde_json::from_slice::<BackupBundle>(&plaintext)
        .map_err(|e| DbError::InvalidInput(format!("corrupt backup bundle JSON: {e}")))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_safe_bundle_rel_path(rel: &str) -> Result<PathBuf> {
    if rel.is_empty() || rel.contains('\0') || rel.contains('\\') {
        return Err(DbError::InvalidInput(format!(
            "unsafe backup file path '{rel}'"
        )));
    }
    if !(rel.starts_with("evidence/") || rel.starts_with("feedback/")) {
        return Err(DbError::InvalidInput(format!(
            "backup file path must be under evidence/ or feedback/: '{rel}'"
        )));
    }
    let p = Path::new(rel);
    for comp in p.components() {
        match comp {
            Component::Normal(_) => {}
            _ => {
                return Err(DbError::InvalidInput(format!(
                    "path traversal rejected in backup archive: '{rel}'"
                )))
            }
        }
    }
    Ok(p.to_path_buf())
}

fn collect_tree_files(
    base_root: &Path,
    subdir: &str,
    out: &mut Vec<BackupFileEntry>,
) -> Result<()> {
    let start = base_root.join(subdir);
    let meta = match fs::symlink_metadata(&start) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(DbError::Io(e)),
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Ok(());
    }
    let mut stack = vec![start];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let md = fs::symlink_metadata(&path)?;
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                stack.push(path);
            } else if md.is_file() {
                if out.len() >= MAX_RESTORE_FILES {
                    return Err(DbError::InvalidInput(
                        "backup file count limit exceeded".into(),
                    ));
                }
                let bytes = fs::read(&path)?;
                if bytes.len() > MAX_SINGLE_FILE_BYTES {
                    return Err(DbError::InvalidInput(format!(
                        "backup artifact '{}' exceeds 32 MiB limit",
                        path.display()
                    )));
                }
                let rel = path
                    .strip_prefix(base_root)
                    .map_err(|_| DbError::InvalidInput("relative path error".into()))?;
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                validate_safe_bundle_rel_path(&rel_str)?;
                out.push(BackupFileEntry {
                    rel_path: rel_str,
                    sha256: sha256_hex(&bytes),
                    content_b64: BASE64.encode(&bytes),
                });
            }
        }
    }
    Ok(())
}

fn write_private_atomic(dest: &Path, bytes: &[u8]) -> Result<()> {
    let parent = dest.parent().ok_or_else(|| {
        DbError::InvalidInput("destination must have a parent directory".into())
    })?;
    crate::ensure_private_dir(parent)?;

    let tmp_name = format!(
        ".{}.{}.tmp",
        dest.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("backup"),
        Uuid::new_v4()
    );
    let tmp_path = parent.join(tmp_name);

    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }

    fs::rename(&tmp_path, dest)?;
    Ok(())
}

fn build_backup_bundle(db: &Db, data_root: Option<&Path>) -> Result<BackupBundle> {
    let temp_dir = std::env::temp_dir().join(format!("arima-bk-{}", Uuid::new_v4()));
    crate::ensure_private_dir(&temp_dir)?;
    let snap_path = temp_dir.join("arima.db");
    let snap_res = backup_sqlite_to(db, &snap_path);
    let db_bytes = match snap_res {
        Ok(()) => fs::read(&snap_path),
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(e);
        }
    };
    let _ = fs::remove_dir_all(&temp_dir);
    let db_bytes = db_bytes?;

    let mut files = Vec::new();
    let mut vault_key_hex = None;
    let mut env_keys = Vec::new();

    if let Some(root) = data_root {
        collect_tree_files(root, "evidence", &mut files)?;
        collect_tree_files(root, "feedback", &mut files)?;
        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

        let vk_path = root.join("vault.key");
        if let Ok(md) = fs::symlink_metadata(&vk_path) {
            if md.is_file() && !md.file_type().is_symlink() {
                if let Ok(raw) = fs::read_to_string(&vk_path) {
                    let clean = raw.trim().to_owned();
                    if !clean.is_empty() {
                        vault_key_hex = Some(clean);
                    }
                }
            }
        }
    }

    for k in [
        "HQ_PORT",
        "HQ_PREVIEW_PORT",
        "HQ_PUBLIC_ORIGIN",
        "HQ_PREVIEW_DOMAIN",
        "HQ_TRUST_PROXY",
    ] {
        if std::env::var(k).is_ok() {
            env_keys.push(k);
        }
    }

    let vault_secrets_count: usize = db
        .read(|conn| {
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM vault_secrets", [], |r| r.get(0))
                .unwrap_or(0);
            Ok::<_, DbError>(usize::try_from(n).unwrap_or(0))
        })
        .unwrap_or(0);

    let vault_metadata = json!({
        "hasVaultKey": vault_key_hex.is_some(),
        "vaultSecretsCount": vault_secrets_count,
        "envConfigKeys": env_keys,
    });

    Ok(BackupBundle {
        format_version: 2,
        created_at: Utc::now().to_rfc3339(),
        engine_version: env!("CARGO_PKG_VERSION").to_owned(),
        db_sha256: sha256_hex(&db_bytes),
        db_b64: BASE64.encode(&db_bytes),
        vault_metadata,
        vault_key_hex,
        files,
    })
}

/// Creates an authenticated AES-256-GCM + Argon2id encrypted backup archive (`ARIMABK2`)
/// bundling consistent `VACUUM INTO` `arima.db`, vault metadata, `evidence/`, and `feedback/`,
/// and writes it atomically (`0600`) inside `<backups_dir>`.
pub fn create_encrypted_backup(
    db: &Db,
    data_root: Option<&Path>,
    backups_dir: &Path,
    key_material: &[u8],
    prefix: &str,
) -> Result<(BackupSummary, BackupManifest, Vec<u8>)> {
    let bundle = build_backup_bundle(db, data_root)?;
    let archive_bytes = encrypt_bundle(&bundle, key_material)?;
    let manifest = verify_encrypted_backup(&archive_bytes, key_material)?;

    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    let short_id = &Uuid::new_v4().simple().to_string()[..8];
    let safe_prefix: String = prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let label = if safe_prefix.is_empty() {
        "arima-backup"
    } else {
        &safe_prefix
    };
    let filename = format!("{label}-{ts}-{short_id}.arimabak");
    let dest = backups_dir.join(&filename);
    write_private_atomic(&dest, &archive_bytes)?;

    let summary = BackupSummary {
        id: filename.clone(),
        filename,
        created_at: manifest.created_at.clone(),
        size_bytes: archive_bytes.len() as u64,
        includes: manifest.includes.clone(),
    };
    Ok((summary, manifest, archive_bytes))
}

/// Decrypts and verifies an encrypted `ARIMABK2` backup archive completely in an isolated
/// temporary directory, validating `PRAGMA integrity_check` and `PRAGMA foreign_key_check`
/// WITHOUT mutating any live database or disk state.
pub fn verify_encrypted_backup(
    archive_bytes: &[u8],
    key_material: &[u8],
) -> Result<BackupManifest> {
    let bundle = decrypt_bundle(archive_bytes, key_material)?;
    let db_bytes = BASE64
        .decode(&bundle.db_b64)
        .map_err(|_| DbError::InvalidInput("corrupt db_b64 payload in backup".into()))?;
    if sha256_hex(&db_bytes) != bundle.db_sha256 {
        return Err(DbError::InvalidInput(
            "backup SQLite SHA-256 digest mismatch".into(),
        ));
    }

    let mut evidence_files = 0usize;
    let mut feedback_files = 0usize;
    if bundle.files.len() > MAX_RESTORE_FILES {
        return Err(DbError::InvalidInput(
            "backup contains too many files".into(),
        ));
    }
    for f in &bundle.files {
        validate_safe_bundle_rel_path(&f.rel_path)?;
        let decoded = BASE64.decode(&f.content_b64).map_err(|_| {
            DbError::InvalidInput(format!("corrupt base64 content for '{}'", f.rel_path))
        })?;
        if sha256_hex(&decoded) != f.sha256 {
            return Err(DbError::InvalidInput(format!(
                "SHA-256 mismatch for archived file '{}'",
                f.rel_path
            )));
        }
        if f.rel_path.starts_with("evidence/") {
            evidence_files += 1;
        } else if f.rel_path.starts_with("feedback/") {
            feedback_files += 1;
        }
    }

    let temp_dir = std::env::temp_dir().join(format!("arima-verify-{}", Uuid::new_v4()));
    crate::ensure_private_dir(&temp_dir)?;
    let verify_db_path = temp_dir.join("verify.db");
    let res = (|| -> Result<BackupManifest> {
        write_private_atomic(&verify_db_path, &db_bytes)?;
        let conn = Connection::open(&verify_db_path)?;
        let integrity: String = conn.query_row("PRAGMA integrity_check;", [], |r| r.get(0))?;
        let integrity_ok = integrity.eq_ignore_ascii_case("ok");
        if !integrity_ok {
            return Err(DbError::InvalidInput(format!(
                "SQLite PRAGMA integrity_check failed: {integrity}"
            )));
        }

        let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check;")?;
        let fk_violations = fk_stmt.query_map([], |_| Ok(()))?.count();
        if fk_violations > 0 {
            return Err(DbError::InvalidInput(format!(
                "SQLite PRAGMA foreign_key_check found {fk_violations} violation(s)"
            )));
        }

        let count_table = |table: &str| -> usize {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .ok()
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(0)
        };

        let projects_count = count_table("projects");
        let users_count = count_table("users");
        let memories_count = count_table("memories");
        let findings_count = count_table("findings");
        let vault_secrets_count = count_table("vault_secrets");

        let mut includes = vec!["arima.db".to_owned(), "vault".to_owned()];
        if evidence_files > 0 {
            includes.push("evidence".to_owned());
        }
        if feedback_files > 0 {
            includes.push("feedback".to_owned());
        }

        Ok(BackupManifest {
            valid: true,
            integrity_ok: true,
            integrity_detail: integrity,
            format_version: bundle.format_version,
            created_at: bundle.created_at,
            db_bytes: db_bytes.len(),
            projects_count,
            users_count,
            memories_count,
            findings_count,
            vault_secrets_count,
            evidence_files,
            feedback_files,
            includes,
        })
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    res
}

/// Verifies an encrypted `ARIMABK2` backup archive, writes a pre-restore safety snapshot,
/// and atomically restores live SQLite DB, vault key, `evidence/`, and `feedback/`.
pub fn restore_encrypted_backup(
    db: &Db,
    data_root: Option<&Path>,
    backups_dir: Option<&Path>,
    archive_bytes: &[u8],
    key_material: &[u8],
) -> Result<RestoreOutcome> {
    // 1. Always verify full decryption, hashes, and SQLite PRAGMA integrity_check first.
    let manifest = verify_encrypted_backup(archive_bytes, key_material)?;
    let bundle = decrypt_bundle(archive_bytes, key_material)?;
    let db_bytes = BASE64
        .decode(&bundle.db_b64)
        .map_err(|_| DbError::InvalidInput("corrupt db_b64 payload".into()))?;

    // 2. Create pre-restore safety snapshot before mutating any live state.
    let pre_restore_backup = if let Some(bdir) = backups_dir {
        let (summary, _, _) =
            create_encrypted_backup(db, data_root, bdir, key_material, "pre-restore")?;
        Some(summary)
    } else {
        None
    };

    // 3. Stage verified SQLite file and atomically restore into the live `Db`.
    let temp_dir = std::env::temp_dir().join(format!("arima-restore-{}", Uuid::new_v4()));
    crate::ensure_private_dir(&temp_dir)?;
    let stage_db = temp_dir.join("restore.db");
    let restore_res = (|| -> Result<()> {
        write_private_atomic(&stage_db, &db_bytes)?;
        db.restore_from_sqlite_file(&stage_db)?;

        // 4. Atomically restore vault.key, evidence/, and feedback/ into data_root.
        if let Some(root) = data_root {
            crate::ensure_private_dir(root)?;
            if let Some(ref vk_hex) = bundle.vault_key_hex {
                write_private_atomic(&root.join("vault.key"), vk_hex.as_bytes())?;
            }

            let stage_artifacts = root.join(format!(".restore-stage-{}", Uuid::new_v4()));
            crate::ensure_private_dir(&stage_artifacts)?;
            let stage_ev = stage_artifacts.join("evidence");
            let stage_fb = stage_artifacts.join("feedback");
            crate::ensure_private_dir(&stage_ev)?;
            crate::ensure_private_dir(&stage_fb)?;

            let unpack_res = (|| -> Result<()> {
                for entry in &bundle.files {
                    let safe_rel = validate_safe_bundle_rel_path(&entry.rel_path)?;
                    let bytes = BASE64.decode(&entry.content_b64).map_err(|_| {
                        DbError::InvalidInput(format!("bad base64 for '{}'", entry.rel_path))
                    })?;
                    let dest = stage_artifacts.join(safe_rel);
                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(&dest, &bytes)?;
                }

                swap_directory_tree(&stage_ev, &root.join("evidence"))?;
                swap_directory_tree(&stage_fb, &root.join("feedback"))?;
                Ok(())
            })();

            let _ = fs::remove_dir_all(&stage_artifacts);
            unpack_res?;
        }
        Ok(())
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    restore_res?;

    Ok(RestoreOutcome {
        manifest,
        pre_restore_backup,
    })
}

fn swap_directory_tree(staged: &Path, live: &Path) -> Result<()> {
    let old_backup = live.with_extension(format!("old-{}", Uuid::new_v4().simple()));
    let live_exists = match fs::symlink_metadata(live) {
        Ok(m) => {
            if m.file_type().is_symlink() {
                fs::remove_file(live)?;
                false
            } else {
                true
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(DbError::Io(e)),
    };

    if live_exists {
        fs::rename(live, &old_backup)?;
    }
    if let Err(err) = fs::rename(staged, live) {
        if live_exists {
            let _ = fs::rename(&old_backup, live);
        }
        return Err(DbError::Io(err));
    }
    if live_exists {
        let _ = fs::remove_dir_all(&old_backup);
    }
    Ok(())
}

/// Lists all `.arimabak` files in `backups_dir`, newest first.
pub fn list_backups(backups_dir: &Path) -> Result<Vec<BackupSummary>> {
    if !backups_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut rows: Vec<(i64, BackupSummary)> = Vec::new();
    for entry in fs::read_dir(backups_dir)? {
        let entry = entry?;
        let path = entry.path();
        let md = fs::symlink_metadata(&path)?;
        if md.file_type().is_symlink() || !md.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_backup_id(name).is_err() {
            continue;
        }
        let modified_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(|| Utc::now().timestamp_millis());
        let created_at = DateTime::from_timestamp_millis(modified_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339();
        rows.push((
            modified_ms,
            BackupSummary {
                id: name.to_owned(),
                filename: name.to_owned(),
                created_at,
                size_bytes: md.len(),
                includes: vec![
                    "arima.db".into(),
                    "vault".into(),
                    "evidence".into(),
                    "feedback".into(),
                ],
            },
        ));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.filename.cmp(&a.1.filename)));
    Ok(rows.into_iter().map(|(_, s)| s).collect())
}

/// Deletes the oldest `.arimabak` archives beyond `keep_last`, returning how many were removed.
pub fn prune_old_backups(backups_dir: &Path, keep_last: usize) -> Result<usize> {
    let keep = keep_last.max(1);
    let all = list_backups(backups_dir)?;
    if all.len() <= keep {
        return Ok(0);
    }
    let mut removed = 0usize;
    for old in all.into_iter().skip(keep) {
        let p = backups_dir.join(&old.filename);
        if let Ok(md) = fs::symlink_metadata(&p) {
            if md.is_file() && !md.file_type().is_symlink() && fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod crypto_golden {
    //! Values captured from the pre-upgrade RustCrypto stack. Archives already on disk must keep
    //! decrypting byte for byte, so these constants must never be regenerated.
    use super::*;

    const KEY_MATERIAL: &[u8] = b"golden-backup-key-material";
    const ARCHIVE_HEX: &str = "4152494d41424b32020154b4ac501b8a82306186b4b2396bf613ed459662841392084ee263b3c433c7302d80e4b5b834b7658402d6084dd8ae505337c6b5e8486d87394ef59a42658c13a02bdd6f3f2bd10b969ca779bd8a0df44e13271fc4e2eeae5d4698f9e2048d3c57d3f59737b7abd91a06bcc7550538f2d86327eadaca11e2cddb7dd1f963085d44a865440129c79166530157ea0dbad8c2b2dd7850c89cd9a8ef1d5e7de3104bca742f95c931c1db27d0967c71b5b631f02195cbf5c75ea36ad8554fdcaca93dc5648a62adef7465031269cac22739c0469218c44d2962a6ed2f24bc6bdc46f29c3616e0e43009e28d14319c946f31cbd0cb97d9311c1c373126d7801a57899c4457bc59e84f41536305ee47377e695b806288380ac99e6fd33a51be68e3775e2a366df5728952f255450f9214aebb6c5310d6a6f1fa55fc0341d540";

    #[test]
    fn argon2_archive_kdf_is_stable() {
        assert_eq!(
            hex::encode(derive_archive_key(KEY_MATERIAL, &[7u8; 16]).unwrap()),
            "29816cdd6e46e85be818973fca26b9a4bb0f601c14f21583a9e4034a207aa8df"
        );
    }

    #[test]
    fn archive_written_before_upgrade_still_decrypts() {
        let archive = hex::decode(ARCHIVE_HEX).unwrap();
        let bundle = decrypt_bundle(&archive, KEY_MATERIAL).unwrap();
        assert_eq!(bundle.created_at, "2026-11-24T00:00:00+00:00");
        assert_eq!(BASE64.decode(&bundle.db_b64).unwrap(), b"not-a-real-sqlite-file");
        assert_eq!(bundle.db_sha256, sha256_hex(b"not-a-real-sqlite-file"));
        assert_eq!(bundle.vault_metadata, json!({"secrets": 1}));
        assert!(decrypt_bundle(&archive, b"wrong-key").is_err());
    }
}
