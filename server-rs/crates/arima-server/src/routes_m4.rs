// SPDX-License-Identifier: AGPL-3.0-or-later

//! Milestone 4 (`v2.0-beta`) HTTP route handlers:
//! - Security Engagements: Scope <-> Egress Policy sync, CVSS 4.0 Findings CRUD, 6-format exports
//! - SQLite FTS5 Team Memory: search, extract, certify, promote, delete, settings
//! - Upgraded Voice Adapters: status, vaulted OpenAI/Gemini TTS & STT
//! - Encrypted Vault Secrets & Full AES-256-GCM Backup / Verify / Restore

use arima_auth::{record_audit, redact_json_value, AuditWrite, VerifiedSession};
use arima_core::{ServerRole, VoiceProvider};
use arima_db::{
    BackupManifest, CreateFindingInput, MemoryExtractionConfig, MemoryRecord, MemorySettings,
    MemoryStatusFilter, ProjectScope, UpdateFindingInput, DEFAULT_UNCERTIFIED_DECAY_DAYS,
};
use axum::extract::{Path, Query, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::backups::{
    create_backup_now, list_stored_backups, read_stored_backup, restore_backup_bytes,
    verify_backup_bytes,
};
use crate::memory::{extract_and_queue_memories, ExtractMemoryRequest};
use crate::routes::{
    effective_role_for_project, extract_ctx, require_session, require_step_up_if_remote, ApiError,
    ReqContext,
};
use crate::security::export_findings_report;
use crate::state::{AppState, PeerIp};
use crate::voice::{
    synthesize_speech, transcribe_audio, voice_status, VoiceError, VoiceSttRequest, VoiceTtsRequest,
};

fn actor_identity(session: &VerifiedSession) -> (Option<&str>, &str) {
    (
        session.user.as_ref().map(|u| u.id.as_str()),
        session
            .user
            .as_ref()
            .map_or("bootstrap", |u| u.name.as_str()),
    )
}

#[allow(clippy::too_many_arguments)]
fn audit_action(
    state: &AppState,
    session: &VerifiedSession,
    role: ServerRole,
    project_id: Option<&str>,
    action: &str,
    target: Option<&str>,
    summary: String,
    remote: bool,
    allowed: bool,
) {
    let (uid, name) = actor_identity(session);
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: uid,
            actor_name: name,
            actor_role: Some(role),
            project_id,
            action,
            target,
            summary,
            remote,
            allowed,
        },
    );
}

fn require_server_owner(
    state: &AppState,
    session: &VerifiedSession,
    ctx: &ReqContext,
    action: &str,
    target: Option<&str>,
) -> Result<(), ApiError> {
    if !matches!(session.role, ServerRole::Owner) {
        audit_action(
            state,
            session,
            session.role,
            None,
            action,
            target,
            "denied: owner role required".into(),
            ctx.remote,
            false,
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Owner role is required for this action.",
        ));
    }
    Ok(())
}

fn require_project_owner(
    state: &AppState,
    session: &VerifiedSession,
    ctx: &ReqContext,
    project_id: &str,
    action: &str,
    target: Option<&str>,
) -> Result<ServerRole, ApiError> {
    let eff = effective_role_for_project(state, session, project_id);
    if !matches!(eff, ServerRole::Owner) {
        audit_action(
            state,
            session,
            eff,
            Some(project_id),
            action,
            target,
            "denied: owner role required".into(),
            ctx.remote,
            false,
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Owner role is required for this action.",
        ));
    }
    Ok(eff)
}

fn require_project_operator(
    state: &AppState,
    session: &VerifiedSession,
    ctx: &ReqContext,
    project_id: &str,
    action: &str,
    target: Option<&str>,
) -> Result<ServerRole, ApiError> {
    let eff = effective_role_for_project(state, session, project_id);
    if matches!(eff, ServerRole::Viewer) {
        audit_action(
            state,
            session,
            eff,
            Some(project_id),
            action,
            target,
            "denied: viewer role is strictly read-only".into(),
            ctx.remote,
            false,
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Viewer role is strictly read-only.",
        ));
    }
    Ok(eff)
}

fn serialize_memory_item(state: &AppState, m: &MemoryRecord) -> Value {
    let conflict_text = m.conflict_id.as_deref().and_then(|cid| {
        state
            .inner
            .memory
            .get(&m.project_id, cid)
            .ok()
            .flatten()
            .map(|c| c.text)
    });
    let status = if m.certified { "certified" } else { "pending" };
    json!({
        "id": m.id,
        "projectId": m.project_id,
        "memType": m.mem_type,
        "type": m.mem_type,
        "text": m.text,
        "about": m.about,
        "certified": m.certified,
        "status": status,
        "conflictId": m.conflict_id,
        "conflictText": conflict_text,
        "promoted": m.promoted,
        "promotedToLesson": m.promoted,
        "supersededBy": m.superseded_by,
        "daysUntilDecay": m.days_until_decay,
        "decayDaysLeft": m.days_until_decay,
        "createdAt": m.created_at,
        "lastUsedAt": m.last_used_at,
        "certifiedAt": if m.certified { Some(&m.last_used_at) } else { None },
    })
}

fn serialize_backup_manifest(m: &BackupManifest) -> Value {
    json!({
        "valid": m.valid,
        "ok": m.valid && m.integrity_ok,
        "integrityOk": m.integrity_ok,
        "integrityDetail": m.integrity_detail,
        "integrityCheck": m.integrity_detail,
        "formatVersion": m.format_version,
        "createdAt": m.created_at,
        "dbBytes": m.db_bytes,
        "projectsCount": m.projects_count,
        "usersCount": m.users_count,
        "memoriesCount": m.memories_count,
        "findingsCount": m.findings_count,
        "vaultSecretsCount": m.vault_secrets_count,
        "evidenceFiles": m.evidence_files,
        "feedbackFiles": m.feedback_files,
        "projects": m.projects_count,
        "users": m.users_count,
        "memories": m.memories_count,
        "findings": m.findings_count,
        "counts": {
            "projects": m.projects_count,
            "users": m.users_count,
            "memories": m.memories_count,
            "findings": m.findings_count,
            "vaultSecrets": m.vault_secrets_count,
            "evidenceFiles": m.evidence_files,
            "feedbackFiles": m.feedback_files,
        },
        "includes": m.includes,
    })
}

fn require_session_or_bearer(
    state: &AppState,
    ctx: &ReqContext,
    headers: &HeaderMap,
) -> Result<VerifiedSession, ApiError> {
    if ctx.raw_token.is_some() {
        return require_session(state, ctx, false);
    }
    if let Some(auth_hdr) = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(tok) = auth_hdr.strip_prefix("Bearer ").map(str::trim) {
            if !tok.is_empty() {
                if let Some(verified) = state.inner.auth.verify_session(tok, false)? {
                    return Ok(verified);
                }
            }
        }
    }
    Err(ApiError::new(StatusCode::UNAUTHORIZED, "Sign in."))
}

// ---------------------------------------------------------------------------
// M4.1 — Security Engagements: Scope, CVSS 4.0 Findings, 6-Format Exports
// ---------------------------------------------------------------------------

pub(crate) async fn get_project_scope(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let scope = state.inner.findings.get_scope(&project_id)?;
    Ok(Json(json!({
        "inScope": scope.in_scope,
        "outOfScope": scope.out_of_scope,
        "notes": scope.notes
    })))
}

pub(crate) async fn put_project_scope(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<ProjectScope>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::PUT)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_owner(
        &state,
        &session,
        &ctx,
        &project_id,
        "security.scope.update",
        Some(&project_id),
    )?;
    require_step_up_if_remote(&session, &ctx)?;

    let saved = state.inner.findings.set_scope(&project_id, &body)?;
    let blocked_imds = state.sync_project_scope_to_proxy(&project_id, &saved);

    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "security.scope.update",
        Some(&project_id),
        format!(
            "inScope={} outOfScope={} blockedImds={}",
            saved.in_scope.len(),
            saved.out_of_scope.len(),
            blocked_imds.len()
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "inScope": saved.in_scope,
        "outOfScope": saved.out_of_scope,
        "notes": saved.notes,
        "scope": saved,
        "blockedImdsTargets": blocked_imds
    })))
}

pub(crate) async fn list_project_findings(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let findings = state.inner.findings.list_findings(&project_id)?;
    Ok(Json(json!({ "findings": findings })))
}

pub(crate) async fn create_project_finding(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(mut body): Json<CreateFindingInput>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_operator(
        &state,
        &session,
        &ctx,
        &project_id,
        "security.findings.create",
        Some(&project_id),
    )?;

    if body.reporter_id.is_none() {
        let (_, name) = actor_identity(&session);
        body.reporter_id = Some(name.to_owned());
    }
    let finding = state.inner.findings.create_finding(&project_id, body)?;

    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "security.findings.create",
        Some(&finding.id),
        format!(
            "created finding {} severity={} score={:.1}",
            finding.id, finding.severity, finding.cvss_score
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "finding": finding })))
}

pub(crate) async fn patch_project_finding(
    State(state): State<AppState>,
    Path((project_id, finding_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<UpdateFindingInput>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::PATCH)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_operator(
        &state,
        &session,
        &ctx,
        &project_id,
        "security.findings.update",
        Some(&finding_id),
    )?;

    let finding = state
        .inner
        .findings
        .update_finding(&project_id, &finding_id, body)?;

    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "security.findings.update",
        Some(&finding.id),
        format!(
            "updated finding {} status={} severity={} score={:.1}",
            finding.id, finding.status, finding.severity, finding.cvss_score
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "finding": finding })))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExportFindingsQuery {
    format: Option<String>,
}

pub(crate) async fn export_project_findings(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<ExportFindingsQuery>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session_or_bearer(&state, &ctx, &headers)?;

    let (proj_id, proj_slug, proj_name): (String, String, String) = state
        .inner
        .db
        .read(|conn| {
            use rusqlite::OptionalExtension;
            conn.query_row(
                "SELECT id, slug, name FROM projects WHERE id = ?1",
                [&project_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(arima_db::DbError::from)
        })?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Project not found."))?;
    let scope = state.inner.findings.get_scope(&proj_id)?;
    let findings = state.inner.findings.list_findings(&proj_id)?;
    let fmt = q.format.as_deref().unwrap_or("markdown");

    let report = export_findings_report(
        fmt,
        &proj_id,
        &proj_name,
        &proj_slug,
        &scope,
        &findings,
    )
    .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;

    Ok((
        [
            (CONTENT_TYPE, report.content_type.to_owned()),
            (CONTENT_DISPOSITION, report.content_disposition),
            (CACHE_CONTROL, "no-store".to_owned()),
        ],
        report.body,
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// M4.2 — SQLite FTS5 Team Memory & Upgraded Voice Adapters
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryQuery {
    q: Option<String>,
    status: Option<String>,
}

pub(crate) async fn list_project_memory(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<MemoryQuery>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;

    // Prune decayed uncertified memories (>30 days) transparently on read.
    let _ = state
        .inner
        .memory
        .prune_decayed_uncertified(Some(&project_id), DEFAULT_UNCERTIFIED_DECAY_DAYS);

    let filter = MemoryStatusFilter::parse(query.status.as_deref());
    let memories_raw = state
        .inner
        .memory
        .search(&project_id, query.q.as_deref(), filter)?;
    let memories: Vec<Value> = memories_raw
        .iter()
        .map(|m| serialize_memory_item(&state, m))
        .collect();
    let settings = state.inner.memory.get_settings(&project_id)?;
    let lessons = state.inner.memory.list_promoted_lessons(&project_id)?;
    let backups: Vec<String> = list_stored_backups(&state)
        .unwrap_or_default()
        .into_iter()
        .map(|b| b.filename)
        .collect();

    Ok(Json(json!({
        "memories": memories,
        "lessons": lessons,
        "extraction": settings.extraction,
        "keepOut": settings.keep_out,
        "backups": backups
    })))
}

pub(crate) async fn extract_project_memory(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    body: Option<Json<ExtractMemoryRequest>>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_operator(
        &state,
        &session,
        &ctx,
        &project_id,
        "memory.extract",
        Some(&project_id),
    )?;

    let req = body.map(|Json(b)| b).unwrap_or_default();
    let (memories_raw, decision, mode) =
        extract_and_queue_memories(&state, &project_id, req).await?;
    let memories: Vec<Value> = memories_raw
        .iter()
        .map(|m| serialize_memory_item(&state, m))
        .collect();

    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "memory.extract",
        Some(&project_id),
        format!("extracted {} candidate memories via {mode}", memories.len()),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "mode": mode,
        "extractedCount": memories.len(),
        "message": format!("Extracted {} candidate memories ({mode}).", memories.len()),
        "memories": memories,
        "decision": decision
    })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertifyMemoryBody {
    supersede_conflict: Option<bool>,
}

pub(crate) async fn certify_project_memory(
    State(state): State<AppState>,
    Path((project_id, memory_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    body: Option<Json<CertifyMemoryBody>>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_owner(
        &state,
        &session,
        &ctx,
        &project_id,
        "memory.certify",
        Some(&memory_id),
    )?;

    let supersede = body
        .and_then(|Json(b)| b.supersede_conflict)
        .unwrap_or(true);
    let memory = state
        .inner
        .memory
        .certify(&project_id, &memory_id, supersede)?;

    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "memory.certify",
        Some(&memory_id),
        format!("certified memory {memory_id} supersedeConflict={supersede}"),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "memory": serialize_memory_item(&state, &memory)
    })))
}

pub(crate) async fn promote_project_memory(
    State(state): State<AppState>,
    Path((project_id, memory_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_owner(
        &state,
        &session,
        &ctx,
        &project_id,
        "memory.promote",
        Some(&memory_id),
    )?;

    let (memory, lesson) = state
        .inner
        .memory
        .promote_to_lesson(&project_id, &memory_id)?;

    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "memory.promote",
        Some(&memory_id),
        format!("promoted memory {memory_id} -> lesson {}", lesson.id),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "memory": serialize_memory_item(&state, &memory),
        "lesson": lesson
    })))
}

pub(crate) async fn delete_project_memory(
    State(state): State<AppState>,
    Path((project_id, memory_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::DELETE)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_owner(
        &state,
        &session,
        &ctx,
        &project_id,
        "memory.delete",
        Some(&memory_id),
    )?;

    let deleted = state.inner.memory.delete(&project_id, &memory_id)?;
    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "memory.delete",
        Some(&memory_id),
        format!("deleted memory {memory_id} existed={deleted}"),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "ok": true, "deleted": deleted })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateMemorySettingsBody {
    extraction: Option<MemoryExtractionConfig>,
    enabled: Option<bool>,
    account: Option<String>,
    keep_out: Option<Vec<String>>,
    add_keep_out: Option<String>,
}

pub(crate) async fn update_project_memory_settings(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<UpdateMemorySettingsBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::PUT)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_project_owner(
        &state,
        &session,
        &ctx,
        &project_id,
        "memory.settings.update",
        Some(&project_id),
    )?;

    let mut current: MemorySettings = state.inner.memory.get_settings(&project_id)?;
    if let Some(ext) = body.extraction {
        current.extraction = ext;
    }
    if let Some(enabled) = body.enabled {
        current.extraction.enabled = enabled;
    }
    if let Some(account) = body.account {
        current.extraction.account = account;
    }
    if let Some(ko) = body.keep_out {
        current.keep_out = ko;
    }
    if let Some(add) = body.add_keep_out.map(|s| s.trim().to_owned()) {
        if add.len() >= 2 {
            current.keep_out.push(add);
        }
    }

    let saved = state.inner.memory.set_settings(&project_id, &current)?;
    audit_action(
        &state,
        &session,
        eff,
        Some(&project_id),
        "memory.settings.update",
        Some(&project_id),
        format!(
            "extraction.enabled={} keepOutCount={}",
            saved.extraction.enabled,
            saved.keep_out.len()
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "extraction": saved.extraction,
        "keepOut": saved.keep_out
    })))
}

// ---------------------------------------------------------------------------
// Voice Adapters & Encrypted Vault Secrets
// ---------------------------------------------------------------------------

pub(crate) async fn get_voice_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let status = voice_status(&state);
    Ok(Json(serde_json::to_value(status).unwrap_or_else(|_| json!({}))))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateVoiceStatusBody {
    active_provider: VoiceProvider,
}

pub(crate) async fn put_voice_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<UpdateVoiceStatusBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::PUT)?;
    let session = require_session(&state, &ctx, true)?;
    if matches!(session.role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Viewer role is strictly read-only.",
        ));
    }
    state.set_active_voice_provider(body.active_provider);
    let status = voice_status(&state);
    Ok(Json(serde_json::to_value(status).unwrap_or_else(|_| json!({}))))
}

pub(crate) async fn post_voice_tts(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<VoiceTtsRequest>,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    if matches!(session.role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Viewer role cannot invoke speech synthesis.",
        ));
    }

    match synthesize_speech(&state, body).await {
        Ok(resp) => Ok(Json(resp).into_response()),
        Err(VoiceError::BadRequest(msg)) => Err(ApiError::new(StatusCode::BAD_REQUEST, msg)),
        Err(VoiceError::NotConfigured { provider, message }) => Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": message,
                "provider": provider,
                "fallback": "browser-web-speech"
            })),
        )
            .into_response()),
        Err(VoiceError::Upstream(msg)) => Err(ApiError::new(StatusCode::BAD_GATEWAY, msg)),
    }
}

pub(crate) async fn post_voice_stt(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<VoiceSttRequest>,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    if matches!(session.role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Viewer role cannot invoke speech transcription.",
        ));
    }

    match transcribe_audio(&state, body).await {
        Ok(resp) => Ok(Json(resp).into_response()),
        Err(VoiceError::BadRequest(msg)) => Err(ApiError::new(StatusCode::BAD_REQUEST, msg)),
        Err(VoiceError::NotConfigured { provider, message }) => Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": message,
                "provider": provider,
                "fallback": "browser-web-speech"
            })),
        )
            .into_response()),
        Err(VoiceError::Upstream(msg)) => Err(ApiError::new(StatusCode::BAD_GATEWAY, msg)),
    }
}

pub(crate) async fn list_vault_secrets(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, false)?;
    require_server_owner(&state, &session, &ctx, "vault.secrets.list", None)?;
    let secrets = state.inner.vault_secrets.list_meta()?;
    Ok(Json(json!({ "secrets": secrets })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertVaultSecretBody {
    id: Option<String>,
    scope: Option<String>,
    provider: String,
    label: Option<String>,
    secret: String,
}

pub(crate) async fn upsert_vault_secret(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<UpsertVaultSecretBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    require_server_owner(
        &state,
        &session,
        &ctx,
        "vault.secrets.upsert",
        Some(&body.provider),
    )?;
    require_step_up_if_remote(&session, &ctx)?;

    let scope = body.scope.as_deref().unwrap_or("global");
    let label = body
        .label
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&body.provider);
    let meta = state.store_vault_secret(
        body.id.as_deref(),
        scope,
        &body.provider,
        label,
        &body.secret,
    )?;

    audit_action(
        &state,
        &session,
        session.role,
        None,
        "vault.secrets.upsert",
        Some(&meta.id),
        format!("stored encrypted secret provider={} scope={}", meta.provider, meta.scope),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "ok": true, "secret": meta })))
}

// ---------------------------------------------------------------------------
// M4.3 — Full Encrypted Backup & Restore (Strictly Owner-Only + Audited)
// ---------------------------------------------------------------------------

pub(crate) async fn list_backups_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, false)?;
    require_server_owner(&state, &session, &ctx, "backups.list", None)?;

    let backups = list_stored_backups(&state)?;
    Ok(Json(json!({
        "backups": backups,
        "retentionCount": state.inner.backup_retention,
        "schedule": "03:00 UTC daily"
    })))
}

pub(crate) async fn create_backup_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    require_server_owner(&state, &session, &ctx, "backups.create", None)?;
    require_step_up_if_remote(&session, &ctx)?;

    let (backup, manifest) = create_backup_now(&state, "arima-backup")?;
    audit_action(
        &state,
        &session,
        session.role,
        None,
        "backups.create",
        Some(&backup.id),
        format!(
            "created encrypted backup {} ({} bytes)",
            backup.filename, backup.size_bytes
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "backup": backup,
        "manifest": serialize_backup_manifest(&manifest)
    })))
}

pub(crate) async fn download_backup_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, true)?;
    require_server_owner(&state, &session, &ctx, "backups.download", Some(&id))?;

    let (safe_id, bytes) = read_stored_backup(&state, &id)?;
    audit_action(
        &state,
        &session,
        session.role,
        None,
        "backups.download",
        Some(&safe_id),
        format!("downloaded encrypted backup {safe_id} ({} bytes)", bytes.len()),
        ctx.remote,
        true,
    );

    Ok((
        [
            (CONTENT_TYPE, "application/octet-stream".to_owned()),
            (
                CONTENT_DISPOSITION,
                format!("attachment; filename=\"{safe_id}\""),
            ),
            (CACHE_CONTROL, "no-store".to_owned()),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifyBackupBody {
    id: Option<String>,
    filename: Option<String>,
    archive_base64: Option<String>,
}

fn load_archive_payload(
    state: &AppState,
    id: Option<&str>,
    filename: Option<&str>,
    archive_base64: Option<&str>,
) -> Result<(String, Vec<u8>), ApiError> {
    if let Some(b64) = archive_base64.map(str::trim).filter(|s| !s.is_empty()) {
        let bytes = BASE64
            .decode(b64)
            .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "archiveBase64 must be valid base64."))?;
        return Ok(("uploaded".into(), bytes));
    }
    if let Some(id_str) = id
        .or(filename)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (safe_id, bytes) = read_stored_backup(state, id_str)?;
        return Ok((safe_id, bytes));
    }
    Err(ApiError::new(
        StatusCode::BAD_REQUEST,
        "Provide either backup 'id' or 'archiveBase64'.",
    ))
}

pub(crate) async fn verify_backup_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<VerifyBackupBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    require_server_owner(
        &state,
        &session,
        &ctx,
        "backups.verify",
        body.id.as_deref().or(body.filename.as_deref()),
    )?;

    let (target, bytes) = load_archive_payload(
        &state,
        body.id.as_deref(),
        body.filename.as_deref(),
        body.archive_base64.as_deref(),
    )?;
    let manifest = verify_backup_bytes(&state, &bytes)?;

    audit_action(
        &state,
        &session,
        session.role,
        None,
        "backups.verify",
        Some(&target),
        format!(
            "verified backup {target} integrity={} projects={} users={}",
            manifest.integrity_ok, manifest.projects_count, manifest.users_count
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "integrityCheck": manifest.integrity_detail,
        "manifest": serialize_backup_manifest(&manifest),
        "message": format!("Verified {} cleanly (integrity {}).", target, manifest.integrity_detail)
    })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreBackupBody {
    id: Option<String>,
    filename: Option<String>,
    archive_base64: Option<String>,
    #[serde(default)]
    confirm: String,
}

pub(crate) async fn restore_backup_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<RestoreBackupBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    require_server_owner(
        &state,
        &session,
        &ctx,
        "backups.restore",
        body.id.as_deref().or(body.filename.as_deref()),
    )?;
    require_step_up_if_remote(&session, &ctx)?;

    if body.confirm.trim() != "RESTORE" {
        audit_action(
            &state,
            &session,
            session.role,
            None,
            "backups.restore",
            body.id.as_deref(),
            format!(
                "rejected restore: missing confirm=RESTORE payload={}",
                redact_json_value(&json!({ "id": body.id, "confirm": body.confirm }))
            ),
            ctx.remote,
            false,
        );
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Type RESTORE in the confirm field to execute a backup restore.",
        ));
    }

    let (target, bytes) = load_archive_payload(
        &state,
        body.id.as_deref(),
        body.filename.as_deref(),
        body.archive_base64.as_deref(),
    )?;
    let outcome = restore_backup_bytes(&state, &bytes)?;
    state.sync_all_persisted_scopes_to_proxy();

    audit_action(
        &state,
        &session,
        session.role,
        None,
        "backups.restore",
        Some(&target),
        format!(
            "restored encrypted backup {target} projects={} evidence={} feedback={}",
            outcome.manifest.projects_count,
            outcome.manifest.evidence_files,
            outcome.manifest.feedback_files
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "manifest": serialize_backup_manifest(&outcome.manifest),
        "preRestoreBackup": outcome.pre_restore_backup,
        "message": format!("Restored encrypted backup {target} atomically.")
    })))
}
