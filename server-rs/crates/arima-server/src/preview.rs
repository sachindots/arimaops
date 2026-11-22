// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use arima_core::{
    ConsoleErrorEntry, ElementSelection, FeedbackRoute, OutboxMessageKind, PreviewTarget,
    VisualFeedback, WsServerEvent,
};
use arima_db::DbError;
use arima_proxy::{
    build_subdomain_preview_origin, normalize_strict_origin, DEFAULT_LOCAL_PROBE_PORTS,
};
use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine;
use chrono::Utc;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;
use url::Url;

use crate::state::AppState;

const PNG_MAGIC: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_PNG_BYTES: usize = 10 * 1024 * 1024;

/// Valid 1x1 transparent PNG used when feedback is submitted without an explicit image payload.
const MINIMAL_PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
    0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

static ATOMIC_TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Request body for `POST /api/projects/{id}/feedback`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitFeedbackInput {
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default = "default_source_kind")]
    pub source_kind: String,
    #[serde(default = "default_page_url")]
    pub page_url: String,
    #[serde(default = "default_vw")]
    pub viewport_width: u32,
    #[serde(default = "default_vh")]
    pub viewport_height: u32,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub selection: Option<ElementSelection>,
    #[serde(default)]
    pub console_errors: Vec<ConsoleErrorEntry>,
    pub route: FeedbackRoute,
    #[serde(default)]
    pub image_data_url: Option<String>,
}

fn default_source_kind() -> String {
    "preview".into()
}

fn default_page_url() -> String {
    "/".into()
}

fn default_vw() -> u32 {
    1440
}

fn default_vh() -> u32 {
    900
}

/// Response body for `POST /api/projects/{id}/preview/token`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTokenResponse {
    pub token: String,
    pub preview_url: String,
    pub expires_at: String,
}

/// Validates an identifier strictly (`[A-Za-z0-9_-]`, 1..=96 chars) to prevent path traversal.
pub fn validate_safe_id(raw: &str) -> Result<(), String> {
    if raw.is_empty()
        || raw.len() > 96
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!("invalid identifier '{raw}'"));
    }
    Ok(())
}

/// Decodes and validates a `data:image/png;base64,...` data URL (checking bounded size and PNG magic header).
pub fn decode_and_validate_png_data_url(data_url: Option<&str>) -> Result<Vec<u8>, String> {
    let Some(raw) = data_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(MINIMAL_PNG_1X1.to_vec());
    };
    let Some(b64) = raw.strip_prefix("data:image/png;base64,") else {
        return Err("imageDataUrl must be a base64-encoded PNG (data:image/png;base64,...)".into());
    };
    if b64.len() > (MAX_PNG_BYTES * 4 / 3) + 64 {
        return Err("imageDataUrl exceeds maximum 10 MiB limit".into());
    }
    let decoded = BASE64_STD
        .decode(b64)
        .map_err(|_| "invalid base64 payload in imageDataUrl".to_owned())?;
    if decoded.len() > MAX_PNG_BYTES {
        return Err("decoded PNG exceeds maximum 10 MiB limit".into());
    }
    if decoded.len() < PNG_MAGIC.len() || &decoded[..8] != PNG_MAGIC {
        return Err("decoded image bytes do not have a valid PNG header".into());
    }
    Ok(decoded)
}

/// Looks up `(slug, root_path)` for `project_id` in SQLite.
pub fn lookup_project_meta(state: &AppState, project_id: &str) -> Result<Option<(String, String)>, DbError> {
    state.inner.db.read(|conn| {
        conn.query_row(
            "SELECT slug, root_path FROM projects WHERE id = ?1",
            [project_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(DbError::from)
    })
}

/// Resolves the preview origin and HQ origin for a request:
/// - When `HQ_PREVIEW_DOMAIN` is configured (e.g. `example.com`), generates wildcard HTTPS subdomain
///   origin `https://preview-<slug>.example.com`.
/// - Otherwise returns the configured explicit `preview_origin` or matching local host + `preview_port`.
#[must_use]
pub fn preview_origin_for_request(
    state: &AppState,
    project_slug: Option<&str>,
    origin_hdr: Option<&str>,
    host_hdr: Option<&str>,
    secure_cookie: bool,
) -> (String, String) {
    let scheme = if secure_cookie { "https" } else { "http" };
    let hq_origin = origin_hdr
        .and_then(normalize_strict_origin)
        .or_else(|| state.public_origin())
        .or_else(|| {
            host_hdr.and_then(|h| normalize_strict_origin(&format!("{scheme}://{h}")))
        })
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", state.inner.config.port));

    if let (Some(domain), Some(slug)) = (state.preview_domain(), project_slug) {
        if let Some(sub_origin) = build_subdomain_preview_origin(slug, &domain, true) {
            return (sub_origin, hq_origin);
        }
    }

    if let Some(ref explicit) = state.inner.config.preview_origin {
        if let Some(norm) = normalize_strict_origin(explicit) {
            return (norm, hq_origin);
        }
    }

    let preview_port = state.inner.config.preview_port;
    let req_host = Url::parse(&hq_origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "127.0.0.1".into());
    let preview_origin = format!("{scheme}://{req_host}:{preview_port}");
    (preview_origin, hq_origin)
}

/// Discovers and returns all live/registered [`PreviewTarget`] entries for `project_id`.
pub async fn discover_project_targets(
    state: &AppState,
    project_id: &str,
    preview_origin: &str,
) -> Result<Vec<PreviewTarget>, String> {
    let Some((slug, _)) = lookup_project_meta(state, project_id).map_err(|e| e.to_string())? else {
        return Err(format!("project '{project_id}' not found"));
    };
    let excluded = [state.inner.config.port, state.inner.config.preview_port];
    let targets = state
        .inner
        .preview_registry
        .discover_for_project(
            project_id,
            &slug,
            preview_origin,
            DEFAULT_LOCAL_PROBE_PORTS,
            &excluded,
        )
        .await;
    Ok(targets)
}

/// Issues a short-lived HMAC-signed preview exchange token and returns its `:7421` exchange URL.
pub async fn issue_preview_token(
    state: &AppState,
    project_id: &str,
    target_id: &str,
    next_path: Option<&str>,
    preview_origin: &str,
    hq_origin: &str,
) -> Result<PreviewTokenResponse, String> {
    if state.inner.preview_registry.get(target_id).is_none() {
        let _ = discover_project_targets(state, project_id, preview_origin).await;
    }
    let Some(upstream) = state.inner.preview_registry.get(target_id) else {
        return Err(format!("preview target '{target_id}' not found"));
    };
    if upstream.project_id != project_id {
        return Err("preview target does not belong to this project".into());
    }

    let (token, expires_at) =
        state
            .inner
            .preview_signer
            .sign_token(project_id, target_id, hq_origin, Some(1800));
    let clean_next = next_path
        .map(str::trim)
        .filter(|p| p.starts_with('/') && !p.starts_with("//"))
        .unwrap_or("/");
    let encoded_tok = utf8_percent_encode(&token, NON_ALPHANUMERIC).to_string();
    let encoded_next = utf8_percent_encode(clean_next, NON_ALPHANUMERIC).to_string();
    let preview_url = format!(
        "{}/__arima_preview/exchange?token={encoded_tok}&next={encoded_next}",
        preview_origin.trim_end_matches('/')
    );

    Ok(PreviewTokenResponse {
        token,
        preview_url,
        expires_at,
    })
}

/// Captures a live viewport PNG snapshot via headless Chromium when installed in PATH
/// (using strict `Command::new` argv array with zero shell interpolation and 8s timeout),
/// or gracefully returns `(String::new(), true)` (`fallback: true`) so the UI uses client DOM-to-PNG.
pub async fn capture_live_viewport_snapshot(
    state: &AppState,
    project_id: &str,
    target_id: &str,
    page_url: &str,
    viewport_width: u32,
    viewport_height: u32,
) -> Result<(String, bool), String> {
    let Some(upstream) = state.inner.preview_registry.get(target_id) else {
        return Ok((String::new(), true));
    };
    if upstream.project_id != project_id {
        return Err("preview target does not belong to this project".into());
    }

    // Build target URL strictly from the registered upstream authority + sanitized relative path (zero SSRF).
    let rel_path = extract_safe_relative_path(page_url);
    let safe_url = format!("http://{}{rel_path}", upstream.upstream_authority());

    let Some(browser_bin) = find_headless_browser_bin() else {
        return Ok((String::new(), true));
    };

    let w = viewport_width.clamp(320, 2560);
    let h = viewport_height.clamp(240, 2000);
    let tmp_dir = std::env::temp_dir();
    let seq = ATOMIC_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let out_path = tmp_dir.join(format!(
        "arima-snap-{}-{seq}.png",
        std::process::id()
    ));

    let argv = vec![
        "--headless=new".to_owned(),
        "--disable-gpu".to_owned(),
        "--no-sandbox".to_owned(),
        "--hide-scrollbars".to_owned(),
        "--disable-dev-shm-usage".to_owned(),
        format!("--window-size={w},{h}"),
        format!("--screenshot={}", out_path.display()),
        safe_url,
    ];

    let run = tokio::time::timeout(
        Duration::from_secs(8),
        Command::new(&browser_bin).args(&argv).output(),
    )
    .await;

    let result = match run {
        Ok(Ok(output)) if output.status.success() => match fs::read(&out_path) {
            Ok(bytes)
                if bytes.len() >= PNG_MAGIC.len()
                    && &bytes[..8] == PNG_MAGIC
                    && bytes.len() <= MAX_PNG_BYTES =>
            {
                let b64 = BASE64_STD.encode(bytes);
                (format!("data:image/png;base64,{b64}"), false)
            }
            _ => (String::new(), true),
        },
        _ => (String::new(), true),
    };

    let _ = fs::remove_file(&out_path);
    Ok(result)
}

fn extract_safe_relative_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('/') && !trimmed.starts_with("//") {
        return trimmed.to_owned();
    }
    if let Ok(u) = Url::parse(trimmed) {
        let mut p = u.path().to_owned();
        if let Some(q) = u.query() {
            p.push('?');
            p.push_str(q);
        }
        if p.starts_with('/') && !p.starts_with("//") {
            return p;
        }
    }
    "/".into()
}

fn find_headless_browser_bin() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("ARIMA_CHROMIUM_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in ["chromium", "chromium-browser", "google-chrome", "chrome"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Validates PNG data URL, writes `annotated.png` + `context.json` atomically to
/// `<data_root>/feedback/<slug>/<id>/`, atomically syncs into `<project_root>/.arima/feedback/<id>/`
/// with strict symlink-escape verification, persists [`VisualFeedback`] in SQLite, routes to
/// Board Task or Agent Chat + `agent_outbox`, and broadcasts `WsServerEvent::FeedbackCreated`.
pub fn create_and_route_feedback(
    state: &AppState,
    project_id: &str,
    author_user_id: &str,
    input: SubmitFeedbackInput,
) -> Result<VisualFeedback, String> {
    let Some((slug, root_path)) =
        lookup_project_meta(state, project_id).map_err(|e| e.to_string())?
    else {
        return Err(format!("project '{project_id}' not found"));
    };
    validate_safe_id(&slug)?;

    let png_bytes = decode_and_validate_png_data_url(input.image_data_url.as_deref())?;
    let id = format!("fb-{}", uuid::Uuid::new_v4().simple());
    validate_safe_id(&id)?;

    let workspace_rel_dir = format!(".arima/feedback/{id}");
    let image_api_path = format!("/api/projects/{project_id}/feedback/{id}/image");
    let now_ms = Utc::now().timestamp_millis();
    let now_iso = Utc::now().to_rfc3339();

    let mut route = input.route.clone();

    // Pre-assign task_id or message_id so `context.json` and SQLite stay consistent.
    let created_task_id = match &mut route {
        FeedbackRoute::CreateTask { task_id, .. } => {
            let tid = task_id
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("T-FB-{}", &id[3..11]));
            *task_id = Some(tid.clone());
            Some(tid)
        }
        FeedbackRoute::SendToChat { .. } => None,
    };
    let created_msg_id = match &mut route {
        FeedbackRoute::SendToChat { message_id, .. } => {
            let mid = message_id
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("msg-fb-{}", &id[3..11]));
            *message_id = Some(mid.clone());
            Some(mid)
        }
        FeedbackRoute::CreateTask { .. } => None,
    };

    let fb = VisualFeedback {
        id: id.clone(),
        project_id: project_id.to_owned(),
        author_user_id: author_user_id.to_owned(),
        target_id: input.target_id,
        source_kind: input.source_kind,
        page_url: input.page_url,
        viewport_width: input.viewport_width.clamp(1, 8192),
        viewport_height: input.viewport_height.clamp(1, 8192),
        note: input.note,
        selection: input.selection,
        console_errors: input.console_errors,
        image_path: image_api_path,
        workspace_rel_dir: workspace_rel_dir.clone(),
        route: route.clone(),
        created_at: now_iso,
    };

    let context_bytes = serde_json::to_vec_pretty(&fb)
        .map_err(|e| format!("failed to serialize feedback context: {e}"))?;

    // 1. Atomic write to `<data_root>/feedback/<slug>/<id>/` when `data_root` is configured.
    if let Some(ref data_root) = state.inner.config.data_root {
        let store_dir = data_root.join("feedback").join(&slug).join(&id);
        fs::create_dir_all(&store_dir)
            .map_err(|e| format!("failed creating feedback dir: {e}"))?;
        write_file_atomic(&store_dir.join("annotated.png"), &png_bytes, 0o600)?;
        write_file_atomic(&store_dir.join("context.json"), &context_bytes, 0o600)?;
    }

    // 2. Atomic sync into `<project_root>/.arima/feedback/<id>/` with symlink-escape check.
    let project_root = Path::new(&root_path);
    if project_root.exists() && project_root.is_dir() {
        sync_feedback_to_workspace(project_root, &id, &png_bytes, &context_bytes)?;
    }

    // 3. Persist `VisualFeedback` in SQLite.
    state
        .inner
        .feedback
        .insert(&fb)
        .map_err(|e| e.to_string())?;

    // 4. Route to Board Task or Agent Chat + `agent_outbox`.
    match &fb.route {
        FeedbackRoute::CreateTask {
            board_id,
            assign_to_agent_id,
            ..
        } => {
            let tid = created_task_id.unwrap_or_else(|| format!("T-FB-{}", &id[3..11]));
            let bid = board_id
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("B1");
            let title = if fb.note.trim().is_empty() {
                format!("Visual feedback on {}", fb.page_url)
            } else {
                fb.note.trim().chars().take(120).collect()
            };
            let data_json = json!({
                "feedbackId": fb.id,
                "workspaceRelDir": fb.workspace_rel_dir,
                "imagePath": fb.image_path,
                "pageUrl": fb.page_url,
                "selection": fb.selection,
                "consoleErrors": fb.console_errors,
            })
            .to_string();

            state
                .inner
                .db
                .transaction(|conn| {
                    conn.execute(
                        "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                         VALUES (?1, ?2, 'Main Board', 'active', ?3, ?3)",
                        rusqlite::params![bid, project_id, now_ms],
                    )?;
                    conn.execute(
                        "INSERT INTO tasks
                            (id, project_id, board_id, goal_id, stage_id, status, title, owner_id, data_json, created_at, updated_at)
                         VALUES (?1, ?2, ?3, NULL, 'build', 'todo', ?4, ?5, ?6, ?7, ?7)",
                        rusqlite::params![
                            tid,
                            project_id,
                            bid,
                            title,
                            assign_to_agent_id,
                            data_json,
                            now_ms
                        ],
                    )?;
                    conn.execute(
                        "INSERT INTO task_events (project_id, task_id, status, stage_id, owner_id, at)
                         VALUES (?1, ?2, 'todo', 'build', ?3, ?4)",
                        rusqlite::params![project_id, tid, assign_to_agent_id, now_ms],
                    )?;
                    Ok::<_, DbError>(())
                })
                .map_err(|e| e.to_string())?;
        }
        FeedbackRoute::SendToChat { to_agent_id, .. } => {
            let mid = created_msg_id.unwrap_or_else(|| format!("msg-fb-{}", &id[3..11]));
            let body = format!(
                "Visual feedback on {}: {} (files synced to {})",
                fb.page_url, fb.note, fb.workspace_rel_dir
            );
            state
                .inner
                .db
                .transaction(|conn| {
                    conn.execute(
                        "INSERT INTO messages (id, project_id, from_id, to_id, body, feedback_id, created_at)
                         VALUES (?1, ?2, 'you', ?3, ?4, ?5, ?6)",
                        rusqlite::params![mid, project_id, to_agent_id, body, fb.id, now_ms],
                    )?;
                    Ok::<_, DbError>(())
                })
                .map_err(|e| e.to_string())?;

            let outbox_payload = serde_json::to_string(&fb).unwrap_or_else(|_| "{}".into());
            state
                .inner
                .supervisor
                .enqueue_outbox(
                    project_id,
                    to_agent_id,
                    OutboxMessageKind::VisualFeedback,
                    &outbox_payload,
                )
                .map_err(|e| e.to_string())?;
            crate::delivery::kick(state, project_id, to_agent_id);
        }
    }

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::FeedbackCreated {
            feedback: fb.clone(),
        });

    Ok(fb)
}

/// Loads the stored PNG image bytes for `(project_id, feedback_id)` safely from disk.
pub fn load_feedback_image_bytes(
    state: &AppState,
    project_id: &str,
    feedback_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    validate_safe_id(feedback_id)?;
    let Some(fb) = state
        .inner
        .feedback
        .get(project_id, feedback_id)
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let Some((slug, root_path)) =
        lookup_project_meta(state, project_id).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    validate_safe_id(&slug)?;

    if let Some(ref data_root) = state.inner.config.data_root {
        let candidate = data_root
            .join("feedback")
            .join(&slug)
            .join(&fb.id)
            .join("annotated.png");
        if let Ok(meta) = fs::symlink_metadata(&candidate) {
            if !meta.file_type().is_symlink() && meta.is_file() {
                let bytes = fs::read(&candidate)
                    .map_err(|e| format!("failed reading feedback image: {e}"))?;
                return Ok(Some(bytes));
            }
        }
    }

    let ws_candidate = Path::new(&root_path)
        .join(".arima")
        .join("feedback")
        .join(&fb.id)
        .join("annotated.png");
    if let Ok(meta) = fs::symlink_metadata(&ws_candidate) {
        if !meta.file_type().is_symlink() && meta.is_file() {
            let canon_root = fs::canonicalize(&root_path)
                .map_err(|e| format!("canonicalize project root: {e}"))?;
            let canon_file = fs::canonicalize(&ws_candidate)
                .map_err(|e| format!("canonicalize feedback file: {e}"))?;
            if canon_file.starts_with(&canon_root) {
                let bytes = fs::read(&canon_file)
                    .map_err(|e| format!("failed reading workspace feedback image: {e}"))?;
                return Ok(Some(bytes));
            }
        }
    }

    Ok(None)
}

/// Atomically syncs `annotated.png` and `context.json` into `<project_root>/.arima/feedback/<id>/`
/// while strictly rejecting any symlink in the destination hierarchy that could escape `project_root`.
pub fn sync_feedback_to_workspace(
    project_root: &Path,
    feedback_id: &str,
    png_bytes: &[u8],
    context_json: &[u8],
) -> Result<PathBuf, String> {
    validate_safe_id(feedback_id)?;
    let canon_root = fs::canonicalize(project_root)
        .map_err(|e| format!("cannot canonicalize project root: {e}"))?;

    let mut cursor = project_root.to_path_buf();
    for segment in [".arima", "feedback", feedback_id] {
        cursor.push(segment);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!(
                        "refusing workspace sync: symlink detected at '{}'",
                        cursor.display()
                    ));
                }
                if !meta.is_dir() {
                    return Err(format!(
                        "refusing workspace sync: '{}' is not a directory",
                        cursor.display()
                    ));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&cursor)
                    .map_err(|e| format!("failed creating '{}': {e}", cursor.display()))?;
            }
            Err(err) => return Err(format!("metadata check failed: {err}")),
        }
    }

    let canon_dest = fs::canonicalize(&cursor)
        .map_err(|e| format!("cannot canonicalize workspace feedback dir: {e}"))?;
    if !canon_dest.starts_with(&canon_root) {
        return Err("refusing workspace sync: destination escapes project root".into());
    }

    let png_dest = canon_dest.join("annotated.png");
    let ctx_dest = canon_dest.join("context.json");
    for file_path in [&png_dest, &ctx_dest] {
        if let Ok(meta) = fs::symlink_metadata(file_path) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "refusing workspace sync: symlink detected at '{}'",
                    file_path.display()
                ));
            }
        }
    }

    write_file_atomic(&png_dest, png_bytes, 0o644)?;
    write_file_atomic(&ctx_dest, context_json, 0o644)?;
    Ok(canon_dest)
}

fn write_file_atomic(dest: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let seq = ATOMIC_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("artifact");
    let tmp_path = dest.with_file_name(format!(".{name}.tmp-{pid}-{seq}"));

    {
        #[cfg(unix)]
        let mut f = {
            use std::os::unix::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(mode)
                .open(&tmp_path)
                .map_err(|e| format!("open temp file: {e}"))?
        };
        #[cfg(not(unix))]
        let mut f = {
            let _ = mode;
            fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp_path)
                .map_err(|e| format!("open temp file: {e}"))?
        };

        f.write_all(bytes)
            .map_err(|e| format!("write temp file: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("sync temp file: {e}"))?;
    }

    fs::rename(&tmp_path, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("atomic rename failed: {e}")
    })
}

/// Converts a raw JSON WS argument into [`SubmitFeedbackInput`].
pub fn parse_ws_feedback_input(val: &Value) -> Result<SubmitFeedbackInput, String> {
    serde_json::from_value::<SubmitFeedbackInput>(val.clone())
        .map_err(|e| format!("invalid visual feedback payload: {e}"))
}
