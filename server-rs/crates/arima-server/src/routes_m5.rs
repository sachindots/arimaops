// SPDX-License-Identifier: AGPL-3.0-or-later

//! Milestone 5 (`v2.0-GA`) HTTP route handlers:
//! - Factory Metrics, Native LLM Scorers, Nightly Improvement Proposals & Replay Benchmarks
//! - Vaulted Tool Connections (`GET/POST/DELETE /api/connections`) without ever echoing secrets
//! - `ee/` Ed25519 Licensing (`GET/POST /api/license`)

use arima_auth::{record_audit, AuditWrite, VerifiedSession};
use arima_core::{DecisionPayload, DecisionStatus, ServerRole, VisualDecision};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::factory::{
    run_nightly_proposals, run_replay_benchmark, score_project_task, RunBenchmarkRequest,
    ScoreTaskRequest,
};
use crate::routes::{
    effective_role_for_project, extract_ctx, require_session, require_step_up_if_remote, ApiError,
    ReqContext,
};
use crate::state::{AppState, PeerIp};

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
fn audit_m5(
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

fn require_owner_m5(
    state: &AppState,
    session: &VerifiedSession,
    ctx: &ReqContext,
    project_id: Option<&str>,
    action: &str,
    target: Option<&str>,
) -> Result<ServerRole, ApiError> {
    let eff = match project_id {
        Some(pid) => effective_role_for_project(state, session, pid),
        None => session.role,
    };
    if !matches!(eff, ServerRole::Owner) {
        audit_m5(
            state,
            session,
            eff,
            project_id,
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

fn require_operator_m5(
    state: &AppState,
    session: &VerifiedSession,
    ctx: &ReqContext,
    project_id: &str,
    action: &str,
    target: Option<&str>,
) -> Result<ServerRole, ApiError> {
    let eff = effective_role_for_project(state, session, project_id);
    if matches!(eff, ServerRole::Viewer) {
        audit_m5(
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

// ---------------------------------------------------------------------------
// Factory Metrics, Scorers, Nightly Improvement Proposals & Replay Benchmarks
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct FactoryMetricsQuery {
    days: Option<u32>,
}

pub(crate) async fn get_factory_metrics(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<FactoryMetricsQuery>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let days = q.days.unwrap_or(14).clamp(1, 90);
    let report = state.inner.factory.metrics_report(&project_id, days)?;
    Ok(Json(serde_json::to_value(report).unwrap_or_else(|_| json!({}))))
}

pub(crate) async fn post_factory_score(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<ScoreTaskRequest>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_operator_m5(
        &state,
        &session,
        &ctx,
        &project_id,
        "factory.score",
        Some(&body.task_id),
    )?;

    let score = score_project_task(&state, &project_id, body).await?;
    audit_m5(
        &state,
        &session,
        eff,
        Some(&project_id),
        "factory.score",
        Some(&score.task_id),
        format!(
            "scored task {} via {} score={:.2} pass={}",
            score.task_id, score.scorer, score.score, score.pass
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "score": score })))
}

pub(crate) async fn post_factory_proposals_run(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_operator_m5(
        &state,
        &session,
        &ctx,
        &project_id,
        "factory.proposals.run",
        Some(&project_id),
    )?;

    let created = run_nightly_proposals(&state, &project_id)?;
    let all = state.inner.factory.list_proposals(&project_id)?;
    audit_m5(
        &state,
        &session,
        eff,
        Some(&project_id),
        "factory.proposals.run",
        Some(&project_id),
        format!("generated {} nightly improvement proposal(s)", created.len()),
        ctx.remote,
        true,
    );

    Ok(Json(json!({
        "ok": true,
        "created": created,
        "proposals": all
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecideProposalBody {
    decision: String,
    note: Option<String>,
}

pub(crate) async fn post_factory_proposal_decide(
    State(state): State<AppState>,
    Path((project_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<DecideProposalBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_owner_m5(
        &state,
        &session,
        &ctx,
        Some(&project_id),
        "factory.proposals.decide",
        Some(&proposal_id),
    )?;

    let proposal = state.inner.factory.decide_proposal(
        &project_id,
        &proposal_id,
        &body.decision,
        body.note.as_deref(),
    )?;
    audit_m5(
        &state,
        &session,
        eff,
        Some(&project_id),
        "factory.proposals.decide",
        Some(&proposal.id),
        format!("decided proposal {} -> {}", proposal.id, proposal.status),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "proposal": proposal })))
}

pub(crate) async fn post_factory_benchmark(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    body: Option<Json<RunBenchmarkRequest>>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_operator_m5(
        &state,
        &session,
        &ctx,
        &project_id,
        "factory.benchmark.run",
        Some(&project_id),
    )?;

    let req = body.map(|Json(b)| b).unwrap_or_default();
    let benchmark = run_replay_benchmark(&state, &project_id, req)?;
    audit_m5(
        &state,
        &session,
        eff,
        Some(&project_id),
        "factory.benchmark.run",
        Some(&benchmark.id),
        format!(
            "benchmark '{}' passRate={:.2} avgScore={:.2} cases={}",
            benchmark.name,
            benchmark.pass_rate,
            benchmark.avg_score,
            benchmark.cases.len()
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "benchmark": benchmark })))
}

// ---------------------------------------------------------------------------
// Vaulted Tool Connections (`GET/POST/DELETE /api/connections`)
// ---------------------------------------------------------------------------

pub(crate) async fn list_connections(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;

    let connections = state.inner.connections.list()?;
    let pending_sends: Vec<VisualDecision> = state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM projects WHERE archived = 0")?;
            let pids: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .filter_map(std::result::Result::ok)
                .collect();
            Ok::<_, arima_db::DbError>(pids)
        })
        .unwrap_or_default()
        .into_iter()
        .flat_map(|pid| {
            state
                .inner
                .decisions
                .list_by_project(&pid, Some(DecisionStatus::Open))
                .unwrap_or_default()
        })
        .filter(|d| matches!(d.payload, DecisionPayload::SendProposal { .. }))
        .collect();

    Ok(Json(json!({
        "connections": connections,
        "pendingSends": pending_sends
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertConnectionBody {
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    label: String,
    endpoint: String,
    secret: Option<String>,
}

pub(crate) async fn upsert_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<UpsertConnectionBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_owner_m5(
        &state,
        &session,
        &ctx,
        None,
        "connections.upsert",
        Some(&body.id),
    )?;
    require_step_up_if_remote(&session, &ctx)?;

    let clean_id = body.id.trim();
    let encrypted_secret = match body.secret.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let aad = format!("tool-connection:{clean_id}");
            let enc = state
                .inner
                .auth
                .vault()
                .encrypt(aad.as_bytes(), raw.as_bytes())?;
            Some(enc)
        }
        None => None,
    };

    crate::integrations::check_endpoint(&body.endpoint).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    let connection = state.inner.connections.upsert(
        clean_id,
        &body.kind,
        &body.label,
        &body.endpoint,
        encrypted_secret.as_deref(),
    )?;

    audit_m5(
        &state,
        &session,
        eff,
        None,
        "connections.upsert",
        Some(&connection.id),
        format!(
            "saved tool connection {} kind={} endpoint={} hasSecret={}",
            connection.id, connection.kind, connection.endpoint, connection.has_secret
        ),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "ok": true, "connection": connection })))
}

pub(crate) async fn delete_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::DELETE)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_owner_m5(
        &state,
        &session,
        &ctx,
        None,
        "connections.delete",
        Some(&id),
    )?;
    require_step_up_if_remote(&session, &ctx)?;

    let deleted = state.inner.connections.delete(&id)?;
    audit_m5(
        &state,
        &session,
        eff,
        None,
        "connections.delete",
        Some(&id),
        format!("deleted tool connection {id} existed={deleted}"),
        ctx.remote,
        true,
    );

    Ok(Json(json!({ "ok": true, "deleted": deleted })))
}

// ---------------------------------------------------------------------------
// `ee/` Ed25519 Licensing (`GET/POST /api/license`)
// ---------------------------------------------------------------------------

pub(crate) async fn get_license_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let license = state.inner.license.current_status();
    Ok(Json(serde_json::to_value(license).unwrap_or_else(|_| json!({}))))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivateLicenseBody {
    license_key: String,
}

pub(crate) async fn post_license_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<ActivateLicenseBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff = require_owner_m5(&state, &session, &ctx, None, "license.activate", None)?;
    require_step_up_if_remote(&session, &ctx)?;

    match state.inner.license.activate(&body.license_key) {
        Ok(license) => {
            audit_m5(
                &state,
                &session,
                eff,
                None,
                "license.activate",
                license.licensee.as_deref(),
                format!(
                    "activated license tier={} maxSeats={} expiresAt={:?}",
                    license.tier, license.max_seats, license.expires_at
                ),
                ctx.remote,
                true,
            );
            Ok(Json(json!({ "ok": true, "license": license })))
        }
        Err(reason) => {
            audit_m5(
                &state,
                &session,
                eff,
                None,
                "license.activate",
                None,
                format!("rejected license key: {reason}"),
                ctx.remote,
                false,
            );
            Err(ApiError::new(StatusCode::BAD_REQUEST, reason))
        }
    }
}
