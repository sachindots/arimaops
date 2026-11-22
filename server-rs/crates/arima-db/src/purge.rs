// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::path::Path;

use crate::{Db, DbError, Result};

/// Summary of rows and artifact directories purged by [`forget_project`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeSummary {
    pub projects_deleted: usize,
    pub fts_deleted: usize,
    pub dirs_removed: usize,
}

/// Validates that a project slug is strictly safe for filesystem path construction.
fn validate_slug(slug: &str) -> Result<()> {
    let valid = !slug.is_empty()
        && slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return Err(DbError::InvalidInput(format!(
            "unsafe project slug '{slug}': must be non-empty [A-Za-z0-9_-]"
        )));
    }
    Ok(())
}

/// Completely purges a project from SQLite (cascading across all project-scoped tables plus
/// `memory_fts`) and removes on-disk evidence, feedback, secrets, and container usage logs.
pub fn forget_project(
    db: &Db,
    project_id: &str,
    project_slug: &str,
    data_root: Option<&Path>,
) -> Result<PurgeSummary> {
    validate_slug(project_slug)?;

    let (projects_deleted, fts_deleted) = db.transaction(|conn| {
        let fts_deleted = conn.execute(
            "DELETE FROM memory_fts WHERE project_id = ?1",
            [project_id],
        )?;
        let projects_deleted =
            conn.execute("DELETE FROM projects WHERE id = ?1", [project_id])?;
        Ok::<_, DbError>((projects_deleted, fts_deleted))
    })?;

    let mut dirs_removed = 0usize;
    if let Some(root) = data_root {
        for folder in ["evidence", "feedback", "secrets"] {
            let candidate = root.join(folder).join(project_slug);
            if remove_non_symlink_path(&candidate)? {
                dirs_removed += 1;
            }
        }

        let usage_dir = root.join("usage");
        if usage_dir.is_dir() {
            let prefix = format!("hq-{project_slug}-");
            for entry in fs::read_dir(&usage_dir)? {
                let entry = entry?;
                let file_name = entry.file_name();
                if file_name.to_string_lossy().starts_with(&prefix)
                    && remove_non_symlink_path(&entry.path())?
                {
                    dirs_removed += 1;
                }
            }
        }
    }

    Ok(PurgeSummary {
        projects_deleted,
        fts_deleted,
        dirs_removed,
    })
}

fn remove_non_symlink_path(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                fs::remove_file(path)?;
            } else if meta.is_dir() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(DbError::Io(err)),
    }
}
