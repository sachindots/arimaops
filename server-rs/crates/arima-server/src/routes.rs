// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::IpAddr;

use arima_auth::{
    build_clear_cookie, build_session_cookie, effective_role, extract_client_ip, list_audit,
    origin_supports_passkeys, parse_cookie, record_audit, redact_json_value, AuditWrite, AuthError,
    PublicKeyCredential, RegisterPublicKeyCredential, SessionMeta, UpdateUserInput,
    VerifiedSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECS,
};
use arima_core::{MeetingKind, MeetingMinutes, MeetingUrgency, ServerRole, VoiceProvider};
use arima_db::{forget_project, is_owner_only_gate, DbError};
use axum::body::{Bytes, Body};
use axum::extract::{Path, Query, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, COOKIE, HOST, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use chrono::Utc;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::github::verify_github_signature;
use crate::mcp::{handle_mcp_rpc, McpCaller, McpJsonRpcRequest, MCP_PROTOCOL_VERSION};
use crate::meetings::{
    add_turn_and_refresh_minutes, commit_minutes_and_broadcast, handle_meeting_action,
    start_or_request_meeting, StartMeetingInput,
};
use crate::preview::{
    capture_live_viewport_snapshot, create_and_route_feedback, discover_project_targets,
    issue_preview_token, load_feedback_image_bytes, lookup_project_meta,
    preview_origin_for_request, SubmitFeedbackInput,
};
use crate::state::{AppState, PeerIp};
use crate::ws::{exec_answer_decision, ws_handler};

#[derive(RustEmbed)]
#[folder = "$ARIMA_DIST_DIR"]
struct EmbeddedAssets;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self {
            status,
            message: msg.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<AuthError> for ApiError {
    fn from(err: AuthError) -> Self {
        match err {
            AuthError::Validation(msg) | AuthError::Passkey(msg) => {
                Self::new(StatusCode::BAD_REQUEST, msg)
            }
            AuthError::InvalidCredentials
            | AuthError::Unauthorized(_)
            | AuthError::MalformedCookie => Self::new(StatusCode::UNAUTHORIZED, err.to_string()),
            AuthError::AccountDisabled | AuthError::Forbidden(_) => {
                Self::new(StatusCode::FORBIDDEN, err.to_string())
            }
            AuthError::Throttled { .. } => Self::new(StatusCode::TOO_MANY_REQUESTS, err.to_string()),
            AuthError::NotFound(msg) => Self::new(StatusCode::NOT_FOUND, msg),
            other => Self::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        }
    }
}

impl From<DbError> for ApiError {
    fn from(err: DbError) -> Self {
        match err {
            DbError::InvalidInput(msg) => Self::new(StatusCode::BAD_REQUEST, msg),
            other => Self::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        }
    }
}

pub fn router_with_state(state: AppState) -> Router {
    let preview = state.preview_origin();
    let preview_port = state.inner.config.preview_port;
    let preview_localhost = format!("http://localhost:{preview_port}");
    let mut frame_sources = if preview == preview_localhost {
        preview.clone()
    } else {
        format!("{preview} {preview_localhost}")
    };
    if let Some(domain) = state.preview_domain() {
        frame_sources.push_str(&format!(" https://*.{domain}"));
    }
    let csp = format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; \
         frame-src 'self' {frame_sources}; object-src 'none'; base-uri 'none'; form-action 'self'; \
         frame-ancestors 'none'"
    );

    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/me", get(auth_me))
        .route("/api/login", post(token_login))
        .route("/api/auth/login", post(password_login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/password", post(change_password))
        .route("/api/auth/totp/verify", post(verify_totp))
        .route("/api/auth/devices", get(list_devices))
        .route("/api/auth/devices/{id}", delete(revoke_device))
        .route("/api/auth/passkeys", get(list_passkeys))
        .route("/api/auth/passkeys/{id}", delete(delete_passkey))
        .route(
            "/api/auth/passkeys/register/start",
            post(passkey_register_start),
        )
        .route(
            "/api/auth/passkeys/register/finish",
            post(passkey_register_finish),
        )
        .route("/api/auth/passkeys/login/start", post(passkey_login_start))
        .route(
            "/api/auth/passkeys/login/finish",
            post(passkey_login_finish),
        )
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", patch(update_user).delete(delete_user))
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/{id}", delete(delete_project))
        .route("/api/projects/{id}/roles", get(list_project_roles))
        .route(
            "/api/projects/{id}/roles/{user_id}",
            put(set_project_role).delete(remove_project_role),
        )
        .route("/api/projects/{id}/usage", get(project_usage))
        .route(
            "/api/projects/{id}/tasks/{task_id}/history",
            get(task_history),
        )
        .route("/api/projects/{id}/decisions", get(list_project_decisions))
        .route(
            "/api/projects/{id}/decisions/{decision_id}/resolve",
            post(resolve_project_decision),
        )
        .route(
            "/api/projects/{id}/decisions/{decision_id}/pack-file",
            get(get_pack_review_file),
        )
        .route(
            "/api/projects/{id}/meetings",
            get(list_project_meetings).post(create_project_meeting),
        )
        .route(
            "/api/projects/{id}/meetings/{meeting_id}/join",
            post(join_project_meeting),
        )
        .route(
            "/api/projects/{id}/meetings/{meeting_id}/turns",
            post(add_project_meeting_turn),
        )
        .route(
            "/api/projects/{id}/meetings/{meeting_id}/commit",
            post(commit_project_meeting_minutes),
        )
        .route(
            "/api/projects/{id}/gates",
            get(list_project_gates).post(record_project_gate),
        )
        .route(
            "/api/projects/{id}/preview/targets",
            get(list_preview_targets),
        )
        .route("/api/projects/{id}/preview/token", post(create_preview_token))
        .route(
            "/api/projects/{id}/preview/snapshot",
            post(create_preview_snapshot),
        )
        .route(
            "/api/projects/{id}/feedback",
            get(list_project_feedback).post(submit_project_feedback),
        )
        .route(
            "/api/projects/{id}/feedback/{feedback_id}/image",
            get(get_feedback_image),
        )
        .route(
            "/api/projects/{id}/scope",
            get(crate::routes_m4::get_project_scope).put(crate::routes_m4::put_project_scope),
        )
        .route(
            "/api/projects/{id}/findings",
            get(crate::routes_m4::list_project_findings)
                .post(crate::routes_m4::create_project_finding),
        )
        .route(
            "/api/projects/{id}/findings/export",
            get(crate::routes_m4::export_project_findings),
        )
        .route(
            "/api/projects/{id}/findings/{finding_id}",
            patch(crate::routes_m4::patch_project_finding),
        )
        .route(
            "/api/projects/{id}/memory",
            get(crate::routes_m4::list_project_memory),
        )
        .route(
            "/api/projects/{id}/memory/extract",
            post(crate::routes_m4::extract_project_memory),
        )
        .route(
            "/api/projects/{id}/memory/settings",
            put(crate::routes_m4::update_project_memory_settings),
        )
        .route(
            "/api/projects/{id}/memory/{memory_id}/certify",
            post(crate::routes_m4::certify_project_memory),
        )
        .route(
            "/api/projects/{id}/memory/{memory_id}/promote",
            post(crate::routes_m4::promote_project_memory),
        )
        .route(
            "/api/projects/{id}/memory/{memory_id}",
            delete(crate::routes_m4::delete_project_memory),
        )
        .route(
            "/api/voice/status",
            get(crate::routes_m4::get_voice_status).put(crate::routes_m4::put_voice_status),
        )
        .route("/api/voice/tts", post(crate::routes_m4::post_voice_tts))
        .route("/api/voice/stt", post(crate::routes_m4::post_voice_stt))
        .route(
            "/api/vault/secrets",
            get(crate::routes_m4::list_vault_secrets).post(crate::routes_m4::upsert_vault_secret),
        )
        .route(
            "/api/backups",
            get(crate::routes_m4::list_backups_route).post(crate::routes_m4::create_backup_route),
        )
        .route(
            "/api/backups/verify",
            post(crate::routes_m4::verify_backup_route),
        )
        .route(
            "/api/backups/restore",
            post(crate::routes_m4::restore_backup_route),
        )
        .route(
            "/api/backups/{id}/download",
            get(crate::routes_m4::download_backup_route),
        )
        .route(
            "/api/projects/{id}/factory/metrics",
            get(crate::routes_m5::get_factory_metrics),
        )
        .route(
            "/api/projects/{id}/factory/score",
            post(crate::routes_m5::post_factory_score),
        )
        .route(
            "/api/projects/{id}/factory/proposals/run",
            post(crate::routes_m5::post_factory_proposals_run),
        )
        .route(
            "/api/projects/{id}/factory/proposals/{proposal_id}/decide",
            post(crate::routes_m5::post_factory_proposal_decide),
        )
        .route(
            "/api/projects/{id}/factory/benchmark",
            post(crate::routes_m5::post_factory_benchmark),
        )
        .route(
            "/api/connections",
            get(crate::routes_m5::list_connections).post(crate::routes_m5::upsert_connection),
        )
        .route(
            "/api/connections/{id}",
            delete(crate::routes_m5::delete_connection),
        )
        .route(
            "/api/license",
            get(crate::routes_m5::get_license_route).post(crate::routes_m5::post_license_route),
        )
        .route("/mcp", post(mcp_root_endpoint))
        .route("/api/projects/{id}/mcp", post(mcp_project_endpoint))
        .route("/api/projects/{id}/mcp-codemode/declarations", get(crate::codemode::declarations_route))
        .route(
            "/api/projects/{id}/mcp/{server}",
            post(crate::mcp_forward::forward).get(crate::mcp_forward::forward).delete(crate::mcp_forward::forward).layer(axum::extract::DefaultBodyLimit::max(crate::mcp_forward::MAX_REQUEST_BYTES)),
        )
        .route("/api/webhooks/github", post(github_webhook_root))
        .route("/api/github/webhook", post(github_webhook_root))
        .route(
            "/api/projects/{id}/github/webhook",
            post(github_webhook_project),
        )
        .route("/api/audit", get(get_audit))
        .route("/ws", get(ws_handler))
        .fallback(get(static_or_404))
        .with_state(state)
        .layer(middleware::from_fn(move |req: Request<Body>, next: Next| {
            let csp = csp.clone();
            async move {
                let mut res = next.run(req).await;
                let h = res.headers_mut();
                if let Ok(v) = HeaderValue::from_str(&csp) {
                    h.insert("content-security-policy", v);
                }
                h.insert(
                    "x-content-type-options",
                    HeaderValue::from_static("nosniff"),
                );
                h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
                res
            }
        }))
}

pub(crate) struct ReqContext {
    pub(crate) peer_ip: IpAddr,
    pub(crate) client_ip: String,
    pub(crate) origin: Option<String>,
    pub(crate) host: Option<String>,
    pub(crate) remote: bool,
    pub(crate) secure_cookie: bool,
    pub(crate) label: String,
    pub(crate) raw_token: Option<String>,
}

pub(crate) fn extract_ctx(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: IpAddr,
    method: &Method,
) -> Result<ReqContext, ApiError> {
    let origin = headers
        .get(ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let host = headers
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    if matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) && !state.is_allowed_origin(origin.as_deref(), host.as_deref())
    {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Origin not allowed."));
    }

    let xff = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok());
    let client_ip = extract_client_ip(peer_ip, xff, state.inner.config.trust_proxy);
    let remote = !state.is_local_origin(origin.as_deref(), peer_ip, host.as_deref());
    let proto_https = state.inner.config.trust_proxy
        && headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|p| p.eq_ignore_ascii_case("https"));
    let origin_https = origin
        .as_deref()
        .is_some_and(|o| o.starts_with("https://"));
    let public_https = state
        .public_origin()
        .is_some_and(|po| po.starts_with("https://"));
    let secure_cookie = proto_https || origin_https || (public_https && remote);

    let label = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(|ua| ua.chars().take(80).collect())
        .unwrap_or_else(|| "Browser".into());

    let cookie_hdr = headers
        .get(COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let raw_token = parse_cookie(cookie_hdr, SESSION_COOKIE_NAME)?;

    Ok(ReqContext {
        peer_ip,
        client_ip,
        origin,
        host,
        remote,
        secure_cookie,
        label,
        raw_token,
    })
}

pub(crate) fn require_session(
    state: &AppState,
    ctx: &ReqContext,
    touch: bool,
) -> Result<VerifiedSession, ApiError> {
    let Some(ref raw) = ctx.raw_token else {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Sign in."));
    };
    state
        .inner
        .auth
        .verify_session(raw, touch)?
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Sign in."))
}

pub(crate) fn require_step_up_if_remote(
    session: &VerifiedSession,
    ctx: &ReqContext,
) -> Result<(), ApiError> {
    if ctx.remote {
        let now_ms = Utc::now().timestamp_millis();
        let elevated = session.elevated_until_ms.is_some_and(|u| u > now_ms);
        if !elevated {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Authenticator step-up required for remote sensitive actions.",
            ));
        }
    }
    Ok(())
}

fn passkeys_available_for(state: &AppState, ctx: &ReqContext) -> bool {
    if let Some(ref orig) = ctx.origin {
        return origin_supports_passkeys(orig);
    }
    if let Some(ref host) = ctx.host {
        let scheme = if ctx.secure_cookie { "https" } else { "http" };
        if origin_supports_passkeys(&format!("{scheme}://{host}")) {
            return true;
        }
    }
    if let Some(ref pub_origin) = state.public_origin() {
        return origin_supports_passkeys(pub_origin);
    }
    false
}

fn effective_origin_for_passkey(state: &AppState, ctx: &ReqContext) -> Result<String, ApiError> {
    if let Some(ref orig) = ctx.origin {
        if origin_supports_passkeys(orig) {
            return Ok(orig.clone());
        }
    }
    if let Some(ref host) = ctx.host {
        let scheme = if ctx.secure_cookie { "https" } else { "http" };
        let candidate = format!("{scheme}://{host}");
        if origin_supports_passkeys(&candidate) {
            return Ok(candidate);
        }
    }
    if let Some(ref pub_origin) = state.public_origin() {
        if origin_supports_passkeys(pub_origin) {
            return Ok(pub_origin.clone());
        }
    }
    Err(ApiError::new(
        StatusCode::BAD_REQUEST,
        "Passkeys require localhost or an HTTPS domain.",
    ))
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "rust"
    }))
}

async fn auth_me(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Response, ApiError> {
    let ctx = match extract_ctx(&state, &headers, peer_ip, &Method::GET) {
        Ok(c) => c,
        Err(err) => {
            // Malformed cookie must return clean 401 rather than crashing.
            let people = state.inner.auth.users_count().unwrap_or(0);
            return Ok((
                err.status,
                Json(json!({ "error": err.message, "people": people, "passkeysAvailable": false })),
            )
                .into_response());
        }
    };
    let people = state.inner.auth.users_count()?;
    let passkeys_available = passkeys_available_for(&state, &ctx);

    if let Some(ref raw) = ctx.raw_token {
        if let Some(verified) = state.inner.auth.verify_session(raw, false)? {
            return Ok(Json(json!({
                "role": verified.role,
                "user": verified.user.as_ref().map(|u| json!({ "id": u.id, "name": u.name })),
                "people": people,
                "passkeysAvailable": passkeys_available
            }))
            .into_response());
        }
    }

    Ok((
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "error": "Sign in.",
            "people": people,
            "passkeysAvailable": passkeys_available
        })),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
struct TokenLoginBody {
    token: String,
}

async fn token_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<TokenLoginBody>,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let is_local = !ctx.remote && ctx.peer_ip.is_loopback();
    let (raw_token, device_id) = state.inner.auth.exchange_bootstrap_token(
        &body.token,
        &state.inner.config.bootstrap_token,
        is_local,
        ctx.origin.clone(),
        ctx.label.clone(),
    )?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: None,
            actor_name: "bootstrap",
            actor_role: Some(ServerRole::Owner),
            project_id: None,
            action: "auth.token_login",
            target: Some(&device_id),
            summary: "bootstrap token exchanged for device session".into(),
            remote: ctx.remote,
            allowed: true,
        },
    );

    let cookie = build_session_cookie(&raw_token, ctx.secure_cookie, SESSION_MAX_AGE_SECS);
    Ok((
        [(SET_COOKIE, cookie)],
        Json(json!({ "role": "owner" })),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
struct PasswordLoginBody {
    name: String,
    password: String,
}

async fn password_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<PasswordLoginBody>,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let attempted_name = body.name.trim().to_owned();
    let res = state
        .inner
        .auth
        .login_with_password(
            body.name,
            body.password,
            SessionMeta {
                client_ip: ctx.client_ip.clone(),
                origin: ctx.origin.clone(),
                label: ctx.label.clone(),
                remote: ctx.remote,
            },
        )
        .await;

    match res {
        Ok(login) => {
            let u = login.user.as_ref();
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: u.map(|x| x.id.as_str()),
                    actor_name: u.map_or(&attempted_name, |x| x.name.as_str()),
                    actor_role: u.map(|x| x.role),
                    project_id: None,
                    action: "auth.login",
                    target: Some(&login.session.id),
                    summary: "signed in with password".into(),
                    remote: ctx.remote,
                    allowed: true,
                },
            );
            let cookie =
                build_session_cookie(&login.raw_token, ctx.secure_cookie, SESSION_MAX_AGE_SECS);
            Ok((
                [(SET_COOKIE, cookie)],
                Json(json!({ "role": u.map(|x| x.role), "user": login.user })),
            )
                .into_response())
        }
        Err(err) => {
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: None,
                    actor_name: if attempted_name.is_empty() {
                        "unknown"
                    } else {
                        &attempted_name
                    },
                    actor_role: None,
                    project_id: None,
                    action: "auth.login",
                    target: Some(&ctx.client_ip),
                    summary: format!("password login failed: {err}"),
                    remote: ctx.remote,
                    allowed: false,
                },
            );
            Err(err.into())
        }
    }
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    if let Some(ref raw) = ctx.raw_token {
        if let Some(verified) = state.inner.auth.verify_session(raw, false)? {
            state.inner.auth.logout_token(raw)?;
            state
                .inner
                .ws_hub
                .close_device_sessions(std::slice::from_ref(&verified.device_id));
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: verified.user.as_ref().map(|u| u.id.as_str()),
                    actor_name: verified
                        .user
                        .as_ref()
                        .map_or("bootstrap", |u| u.name.as_str()),
                    actor_role: Some(verified.role),
                    project_id: None,
                    action: "auth.logout",
                    target: Some(&verified.device_id),
                    summary: "signed out".into(),
                    remote: ctx.remote,
                    allowed: true,
                },
            );
        }
    }
    let clear = build_clear_cookie(ctx.secure_cookie);
    Ok(([(SET_COOKIE, clear)], Json(json!({ "ok": true }))).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordBody {
    current_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<ChangePasswordBody>,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let user = session
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "User account required."))?;

    let (new_raw_token, revoked_others) = state
        .inner
        .auth
        .change_password(
            &user.id,
            &session.device_id,
            body.current_password,
            body.new_password,
            SessionMeta {
                client_ip: ctx.client_ip.clone(),
                origin: ctx.origin.clone(),
                label: ctx.label.clone(),
                remote: ctx.remote,
            },
        )
        .await?;

    state.inner.ws_hub.close_device_sessions(&revoked_others);
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: Some(&user.id),
            actor_name: &user.name,
            actor_role: Some(user.role),
            project_id: None,
            action: "auth.password",
            target: Some(&user.id),
            summary: format!("changed own password (revoked {} other sessions)", revoked_others.len()),
            remote: ctx.remote,
            allowed: true,
        },
    );

    let cookie = build_session_cookie(&new_raw_token, ctx.secure_cookie, SESSION_MAX_AGE_SECS);
    Ok(([(SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

#[derive(Debug, Deserialize)]
struct VerifyTotpBody {
    code: String,
}

async fn verify_totp(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<VerifyTotpBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let until = state.inner.auth.verify_totp_step_up(&session, &body.code)?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: None,
            action: "auth.totp.verify",
            target: Some(&session.device_id),
            summary: "elevated session via TOTP".into(),
            remote: ctx.remote,
            allowed: true,
        },
    );
    Ok(Json(json!({ "ok": true, "elevatedUntil": until })))
}

async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, false)?;
    let Some(ref user) = session.user else {
        return Ok(Json(json!({ "devices": [] })));
    };
    let devices = state
        .inner
        .auth
        .list_devices(&user.id, &session.device_id)?;
    Ok(Json(json!({ "devices": devices })))
}

async fn revoke_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::DELETE)?;
    let session = require_session(&state, &ctx, true)?;
    require_step_up_if_remote(&session, &ctx)?;
    let user = session
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "User account required."))?;
    let removed = state.inner.auth.revoke_device(&user.id, &device_id)?;
    if !removed {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Device session not found."));
    }
    state
        .inner
        .ws_hub
        .close_device_sessions(std::slice::from_ref(&device_id));
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: Some(&user.id),
            actor_name: &user.name,
            actor_role: Some(user.role),
            project_id: None,
            action: "auth.device.revoke",
            target: Some(&device_id),
            summary: "revoked device session".into(),
            remote: ctx.remote,
            allowed: true,
        },
    );
    Ok(Json(json!({ "ok": true })))
}

async fn list_passkeys(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, false)?;
    let Some(ref user) = session.user else {
        return Ok(Json(json!({ "passkeys": [] })));
    };
    let passkeys = state.inner.auth.passkeys().list_passkeys(&user.id)?;
    Ok(Json(json!({ "passkeys": passkeys })))
}

async fn delete_passkey(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::DELETE)?;
    let session = require_session(&state, &ctx, true)?;
    require_step_up_if_remote(&session, &ctx)?;
    let user = session
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "User account required."))?;
    let deleted = state
        .inner
        .auth
        .passkeys()
        .delete_passkey(&user.id, &id)?;
    if !deleted {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Passkey not found."));
    }
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: Some(&user.id),
            actor_name: &user.name,
            actor_role: Some(user.role),
            project_id: None,
            action: "auth.passkey.delete",
            target: Some(&id),
            summary: "removed passkey".into(),
            remote: ctx.remote,
            allowed: true,
        },
    );
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct PasskeyRegStartBody {
    label: Option<String>,
}

async fn passkey_register_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<PasskeyRegStartBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    require_step_up_if_remote(&session, &ctx)?;
    let user = session
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Create your owner user account first."))?;
    let origin = effective_origin_for_passkey(&state, &ctx)?;
    let res = state.inner.auth.passkeys().start_registration(
        &user.id,
        &user.name,
        &origin,
        body.label.unwrap_or_else(|| "Passkey".into()),
    )?;
    Ok(Json(json!({
        "challengeId": res.challenge_id,
        "options": res.options
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyRegFinishBody {
    challenge_id: String,
    credential: RegisterPublicKeyCredential,
}

async fn passkey_register_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<PasskeyRegFinishBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let user = session
        .user
        .as_ref()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "User account required."))?;
    let info = state.inner.auth.passkeys().finish_registration(
        &user.id,
        &body.challenge_id,
        body.credential,
    )?;
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: Some(&user.id),
            actor_name: &user.name,
            actor_role: Some(user.role),
            project_id: None,
            action: "auth.passkey.register",
            target: Some(&info.id),
            summary: format!("registered passkey {}", info.label),
            remote: ctx.remote,
            allowed: true,
        },
    );
    Ok(Json(json!({ "passkey": info })))
}

#[derive(Debug, Deserialize)]
struct PasskeyLoginStartBody {
    name: Option<String>,
}

async fn passkey_login_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<PasskeyLoginStartBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let origin = effective_origin_for_passkey(&state, &ctx)?;
    let user_id = if let Some(name) = body.name.filter(|s| !s.trim().is_empty()) {
        state
            .inner
            .auth
            .find_user_by_name(&name)?
            .map(|u| u.id)
    } else {
        None
    };
    let res = state
        .inner
        .auth
        .passkeys()
        .start_authentication(user_id.as_deref(), &origin)?;
    Ok(Json(json!({
        "challengeId": res.challenge_id,
        "options": res.options
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyLoginFinishBody {
    challenge_id: String,
    credential: PublicKeyCredential,
}

async fn passkey_login_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<PasskeyLoginFinishBody>,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let user_id = state
        .inner
        .auth
        .passkeys()
        .finish_authentication(&body.challenge_id, body.credential)?;
    let login = state.inner.auth.login_with_passkey(
        &user_id,
        SessionMeta {
            client_ip: ctx.client_ip.clone(),
            origin: ctx.origin.clone(),
            label: ctx.label.clone(),
            remote: ctx.remote,
        },
    )?;
    let u = login.user.as_ref();
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: u.map(|x| x.id.as_str()),
            actor_name: u.map_or("unknown", |x| x.name.as_str()),
            actor_role: u.map(|x| x.role),
            project_id: None,
            action: "auth.passkey.login",
            target: Some(&login.session.id),
            summary: "signed in with passkey".into(),
            remote: ctx.remote,
            allowed: true,
        },
    );
    let cookie = build_session_cookie(&login.raw_token, ctx.secure_cookie, SESSION_MAX_AGE_SECS);
    Ok((
        [(SET_COOKIE, cookie)],
        Json(json!({ "role": u.map(|x| x.role), "user": login.user })),
    )
        .into_response())
}

async fn list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, false)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner manages users."));
    }
    let users = state.inner.auth.list_users()?;
    Ok(Json(json!({ "users": users })))
}

#[derive(Debug, Deserialize)]
struct CreateUserBody {
    name: String,
    password: String,
    role: Option<ServerRole>,
}

async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<CreateUserBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner adds users."));
    }
    let people = state.inner.auth.users_count()?;
    if people > 0 {
        require_step_up_if_remote(&session, &ctx)?;
    }
    if let Err(limit_msg) = state.inner.license.ensure_seat_available() {
        let _ = record_audit(
            &state.inner.db,
            AuditWrite {
                actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
                actor_name: session
                    .user
                    .as_ref()
                    .map_or("bootstrap", |u| u.name.as_str()),
                actor_role: Some(session.role),
                project_id: None,
                action: "users.create",
                target: Some(&body.name),
                summary: format!("denied by license seat cap: {limit_msg}"),
                remote: ctx.remote,
                allowed: false,
            },
        );
        return Err(ApiError::new(StatusCode::FORBIDDEN, limit_msg));
    }

    let created = state
        .inner
        .auth
        .create_user(body.name, body.password, body.role.unwrap_or(ServerRole::Operator))
        .await?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: None,
            action: "users.create",
            target: Some(&created.user.id),
            summary: format!("created user {} ({})", created.user.name, created.user.role.as_str()),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({
        "user": created.user,
        "otpauth": created.otpauth,
        "qrSvg": created.qr_svg
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateUserBody {
    role: Option<ServerRole>,
    password: Option<String>,
    #[serde(default)]
    reset_totp: bool,
    disabled: Option<bool>,
}

async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<UpdateUserBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::PATCH)?;
    let session = require_session(&state, &ctx, true)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner edits users."));
    }
    require_step_up_if_remote(&session, &ctx)?;

    let out = state
        .inner
        .auth
        .update_user(
            &id,
            UpdateUserInput {
                role: body.role,
                password: body.password,
                reset_totp: body.reset_totp,
                disabled: body.disabled,
            },
        )
        .await?;

    state
        .inner
        .ws_hub
        .close_device_sessions(&out.revoked_device_ids);

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: None,
            action: "users.update",
            target: Some(&id),
            summary: format!(
                "updated user {} (revoked {} sessions)",
                out.user.name,
                out.revoked_device_ids.len()
            ),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({
        "user": out.user,
        "otpauth": out.otpauth,
        "qrSvg": out.qr_svg
    })))
}

async fn delete_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::DELETE)?;
    let session = require_session(&state, &ctx, true)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner deletes users."));
    }
    require_step_up_if_remote(&session, &ctx)?;

    let revoked = state.inner.auth.delete_user(&id)?;
    state.inner.ws_hub.close_device_sessions(&revoked);

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: None,
            action: "users.delete",
            target: Some(&id),
            summary: format!("deleted user (revoked {} sessions)", revoked.len()),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({ "ok": true })))
}

async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let rows = state.inner.db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, slug, name, root_path, paused, archived, updated_at FROM projects ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::team::ProjectRow {
                id: r.get(0)?,
                slug: r.get(1)?,
                name: r.get(2)?,
                path: r.get(3)?,
                paused: r.get::<_, i64>(4)? != 0,
                archived: r.get::<_, i64>(5)? != 0,
                updated_at_ms: r.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    })?;
    let projects: Vec<Value> = rows.iter().map(|row| crate::team::project_info(&state, row)).collect();
    Ok(Json(json!({ "projects": projects })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectBody {
    name: String,
    slug: String,
    root_path: Option<String>,
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<CreateProjectBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    if !matches!(session.role, ServerRole::Owner | ServerRole::Operator) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Viewers cannot create projects."));
    }
    require_step_up_if_remote(&session, &ctx)?;

    let clean_slug = body.slug.trim().to_owned();
    let valid_slug = !clean_slug.is_empty()
        && clean_slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid_slug {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Slug must contain only [A-Za-z0-9_-].",
        ));
    }
    let id = format!("proj-{clean_slug}");
    let now_ms = Utc::now().timestamp_millis();
    let root_path = body.root_path.unwrap_or_else(|| ".".into());

    state.inner.db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            rusqlite::params![id, clean_slug, body.name.trim(), root_path, now_ms],
        )?;
        Ok::<_, DbError>(())
    })?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: Some(&id),
            action: "projects.create",
            target: Some(&id),
            summary: format!("created project {} ({clean_slug})", body.name.trim()),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({
        "project": {
            "id": id,
            "slug": clean_slug,
            "name": body.name.trim(),
            "path": root_path
        }
    })))
}

async fn delete_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::DELETE)?;
    let session = require_session(&state, &ctx, true)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner deletes projects."));
    }
    require_step_up_if_remote(&session, &ctx)?;

    let slug: Option<String> = state.inner.db.read(|conn| {
        use rusqlite::OptionalExtension;
        conn.query_row(
            "SELECT slug FROM projects WHERE id = ?1",
            [&project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(DbError::from)
    })?;
    let Some(slug) = slug else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Project not found."));
    };

    state.inner.runtime.stop_project(&state, &project_id).await;
    let summary = forget_project(
        &state.inner.db,
        &project_id,
        &slug,
        state.inner.config.data_root.as_deref(),
    )?;
    state.inner.preview_registry.remove_project(&project_id);

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: Some(&project_id),
            action: "projects.delete",
            target: Some(&project_id),
            summary: format!(
                "purged project {slug} (rows={}, dirs={})",
                summary.projects_deleted, summary.dirs_removed
            ),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({
        "ok": true,
        "deleted": summary.projects_deleted,
        "dirsRemoved": summary.dirs_removed
    })))
}

async fn list_project_roles(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, false)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner reads project roles."));
    }
    let roles = state.inner.auth.list_project_roles(&project_id)?;
    Ok(Json(json!({ "roles": roles })))
}

#[derive(Debug, Deserialize)]
struct SetProjectRoleBody {
    role: ServerRole,
}

async fn set_project_role(
    State(state): State<AppState>,
    Path((project_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<SetProjectRoleBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::PUT)?;
    let session = require_session(&state, &ctx, true)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner sets project roles."));
    }
    require_step_up_if_remote(&session, &ctx)?;

    let binding = state
        .inner
        .auth
        .set_project_role(&project_id, &user_id, body.role)?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: Some(&project_id),
            action: "projects.roles.set",
            target: Some(&user_id),
            summary: format!("set project role={} for user {user_id}", body.role.as_str()),
            remote: ctx.remote,
            allowed: true,
        },
    );
    Ok(Json(json!({ "role": binding })))
}

async fn remove_project_role(
    State(state): State<AppState>,
    Path((project_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::DELETE)?;
    let session = require_session(&state, &ctx, true)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner removes project roles."));
    }
    require_step_up_if_remote(&session, &ctx)?;

    let removed = state
        .inner
        .auth
        .remove_project_role(&project_id, &user_id)?;
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(session.role),
            project_id: Some(&project_id),
            action: "projects.roles.remove",
            target: Some(&user_id),
            summary: format!("removed project role for user {user_id}"),
            remote: ctx.remote,
            allowed: true,
        },
    );
    Ok(Json(json!({ "ok": removed })))
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    limit: Option<usize>,
}

async fn get_audit(
    State(state): State<AppState>,
    Query(q): Query<AuditQuery>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let session = require_session(&state, &ctx, false)?;
    if !matches!(session.role, ServerRole::Owner) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner views the audit log."));
    }
    let entries = list_audit(&state.inner.db, q.limit.unwrap_or(100))?;
    Ok(Json(json!({ "entries": entries })))
}

#[derive(Deserialize)]
struct UsageQuery {
    days: Option<u32>,
}

pub(crate) fn effective_role_for_project(
    state: &AppState,
    session: &VerifiedSession,
    project_id: &str,
) -> ServerRole {
    let proj_role = session
        .user
        .as_ref()
        .and_then(|u| state.inner.auth.get_project_role(project_id, &u.id).ok().flatten());
    effective_role(session.role, proj_role)
}

async fn project_usage(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<UsageQuery>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let days = q.days.unwrap_or(1).clamp(1, 90);
    let report = state
        .inner
        .usage
        .aggregate_project_usage(&project_id, days, None)?;
    Ok(Json(json!({
        "days": report.days,
        "agents": report.agents
    })))
}

async fn task_history(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let gates = state.inner.gates.list_for_task(&project_id, &task_id)?;
    let events: Vec<Value> = state.inner.db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, status, stage_id, owner_id, at
             FROM task_events
             WHERE project_id = ?1 AND task_id = ?2
             ORDER BY at ASC, id ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![project_id, task_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "status": r.get::<_, String>(1)?,
                "stageId": r.get::<_, Option<String>>(2)?,
                "ownerId": r.get::<_, Option<String>>(3)?,
                "at": r.get::<_, i64>(4)?,
            }))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok::<_, DbError>(out)
    })?;
    Ok(Json(json!({ "events": events, "gates": gates })))
}

#[derive(Debug, Deserialize)]
struct PackFileQuery {
    path: String,
}

async fn get_pack_review_file(
    State(state): State<AppState>,
    Path((project_id, decision_id)): Path<(String, String)>,
    Query(query): Query<PackFileQuery>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let (before, after) = crate::packs::read_review_file(&state, &project_id, &decision_id, &query.path).map_err(|msg| {
        let status = if msg.contains("not found") || msg.contains("not part") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        ApiError::new(status, msg)
    })?;
    Ok(Json(json!({ "path": query.path, "before": before, "after": after })))
}

async fn list_project_decisions(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let decisions = state.inner.decisions.list_by_project(&project_id, None)?;
    Ok(Json(json!({ "decisions": decisions })))
}

async fn resolve_project_decision(
    State(state): State<AppState>,
    Path((project_id, decision_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff_role = effective_role_for_project(&state, &session, &project_id);
    let actor_uid = session.user.as_ref().map(|u| u.id.as_str());
    let actor_name = session
        .user
        .as_ref()
        .map_or("bootstrap", |u| u.name.as_str());

    if matches!(eff_role, ServerRole::Viewer) {
        let _ = record_audit(
            &state.inner.db,
            AuditWrite {
                actor_user_id: actor_uid,
                actor_name,
                actor_role: Some(eff_role),
                project_id: Some(&project_id),
                action: "decisions.resolve",
                target: Some(&decision_id),
                summary: "denied: viewer role is strictly read-only".into(),
                remote: ctx.remote,
                allowed: false,
            },
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "viewer role is strictly read-only",
        ));
    }

    let existing = state
        .inner
        .decisions
        .get(&decision_id)?
        .filter(|d| d.project_id == project_id)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Decision not found."))?;
    if existing.owner_only && !matches!(eff_role, ServerRole::Owner) {
        let _ = record_audit(
            &state.inner.db,
            AuditWrite {
                actor_user_id: actor_uid,
                actor_name,
                actor_role: Some(eff_role),
                project_id: Some(&project_id),
                action: "decisions.resolve",
                target: Some(&decision_id),
                summary: "denied: owner_only decision requires owner role".into(),
                remote: ctx.remote,
                allowed: false,
            },
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "this approval or decision is restricted to the owner",
        ));
    }

    exec_answer_decision(&state, &project_id, &[json!(decision_id), body.clone()], eff_role)
        .map_err(|e| ApiError::new(StatusCode::FORBIDDEN, e))?;

    let updated = state.inner.decisions.get(&decision_id)?;
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: actor_uid,
            actor_name,
            actor_role: Some(eff_role),
            project_id: Some(&project_id),
            action: "decisions.resolve",
            target: Some(&decision_id),
            summary: format!("resolved decision args={}", redact_json_value(&body)),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({ "ok": true, "decision": updated })))
}

async fn list_project_meetings(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let meetings = state.inner.meetings.list_sessions(&project_id)?;
    let turns = state.inner.meetings.list_turns_by_project(&project_id)?;
    Ok(Json(json!({ "meetings": meetings, "meetingTurns": turns })))
}

async fn create_project_meeting(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff_role = effective_role_for_project(&state, &session, &project_id);
    if matches!(eff_role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "viewer role is strictly read-only",
        ));
    }
    let actor_name = session
        .user
        .as_ref()
        .map_or("bootstrap", |u| u.name.as_str());
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Team Standup")
        .to_owned();
    let kind = match body
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("standup")
    {
        "discussion" => MeetingKind::Discussion,
        "kickoff" => MeetingKind::Kickoff,
        "review" => MeetingKind::Review,
        _ => MeetingKind::Standup,
    };
    let urgency = match body
        .get("urgency")
        .and_then(Value::as_str)
        .unwrap_or("normal")
    {
        "low" => MeetingUrgency::Low,
        "high" => MeetingUrgency::High,
        _ => MeetingUrgency::Normal,
    };
    let participants: Vec<String> = body
        .get("participantIds")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| vec!["lead".into(), "coder".into(), "verifier".into()]);
    let agenda: Vec<String> = body
        .get("agenda")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    let (meeting, turn, _) = start_or_request_meeting(
        &state,
        StartMeetingInput {
            project_id: project_id.clone(),
            kind,
            title,
            urgency,
            moderator_id: "lead".into(),
            participant_ids: participants,
            requested_by: actor_name.to_owned(),
            agenda_titles: agenda,
            voice_enabled: body
                .get("voiceEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            voice_provider: VoiceProvider::BrowserWebSpeech,
        },
        true,
    )
    .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;

    Ok(Json(json!({ "meeting": meeting, "openingTurn": turn })))
}

async fn join_project_meeting(
    State(state): State<AppState>,
    Path((project_id, meeting_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff_role = effective_role_for_project(&state, &session, &project_id);
    if matches!(eff_role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "viewer role is strictly read-only",
        ));
    }
    let action = body.get("action").and_then(Value::as_str);
    let voice = body.get("voiceEnabled").and_then(Value::as_bool);
    let meeting = handle_meeting_action(&state, &meeting_id, action, voice, eff_role)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({ "meeting": meeting })))
}

async fn add_project_meeting_turn(
    State(state): State<AppState>,
    Path((project_id, meeting_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff_role = effective_role_for_project(&state, &session, &project_id);
    if matches!(eff_role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "viewer role is strictly read-only",
        ));
    }
    let speaker = body
        .get("speakerId")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            session
                .user
                .as_ref()
                .map_or("you", |u| u.name.as_str())
        });
    let text = body
        .get("bodyMarkdown")
        .or_else(|| body.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Missing bodyMarkdown."))?;
    let decision_id = body
        .get("decisionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let spoken_text = body
        .get("spokenText")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let (turn, updated_meeting) = add_turn_and_refresh_minutes(
        &state,
        &meeting_id,
        speaker,
        body.get("speakerRole").and_then(Value::as_str),
        body.get("kind").and_then(Value::as_str),
        text,
        decision_id,
        spoken_text,
    )
    .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;

    Ok(Json(json!({ "turn": turn, "meeting": updated_meeting })))
}

async fn commit_project_meeting_minutes(
    State(state): State<AppState>,
    Path((project_id, meeting_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff_role = effective_role_for_project(&state, &session, &project_id);
    if matches!(eff_role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "viewer role is strictly read-only",
        ));
    }

    let override_minutes = body
        .get("minutes")
        .cloned()
        .or_else(|| Some(body.clone()))
        .and_then(|v| serde_json::from_value::<MeetingMinutes>(v).ok());

    let (meeting, summary) = commit_minutes_and_broadcast(&state, &meeting_id, override_minutes)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(eff_role),
            project_id: Some(&project_id),
            action: "meetings.commit_minutes",
            target: Some(&meeting_id),
            summary: format!(
                "committed meeting minutes (tasks={}, memories={}, instructions={})",
                summary.tasks_created, summary.memories_certified, summary.instructions_queued
            ),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({
        "ok": true,
        "meeting": meeting,
        "summary": summary
    })))
}

async fn list_project_gates(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let gates = state.inner.gates.list_for_project(&project_id)?;
    Ok(Json(json!({ "gates": gates })))
}

async fn record_project_gate(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff_role = effective_role_for_project(&state, &session, &project_id);
    let actor_uid = session.user.as_ref().map(|u| u.id.as_str());
    let actor_name = session
        .user
        .as_ref()
        .map_or("bootstrap", |u| u.name.as_str());

    if matches!(eff_role, ServerRole::Viewer) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "viewer role is strictly read-only",
        ));
    }

    let task_id = body
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Missing taskId."))?;
    let gate_id = body
        .get("gateId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Missing gateId."))?;
    let gate_state = body
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("passed");
    let note = body.get("note").and_then(Value::as_str);
    let url = body.get("url").and_then(Value::as_str);
    let by_id = body
        .get("byId")
        .and_then(Value::as_str)
        .unwrap_or(actor_name);

    if is_owner_only_gate(gate_id, gate_state, by_id) && !matches!(eff_role, ServerRole::Owner) {
        let _ = record_audit(
            &state.inner.db,
            AuditWrite {
                actor_user_id: actor_uid,
                actor_name,
                actor_role: Some(eff_role),
                project_id: Some(&project_id),
                action: "gates.record",
                target: Some(task_id),
                summary: format!("denied owner-only gate {gate_id} ({gate_state})"),
                remote: ctx.remote,
                allowed: false,
            },
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "this gate or waiver is restricted to the owner",
        ));
    }

    let record = state.inner.gates.record_gate(
        &project_id,
        task_id,
        gate_id,
        gate_state,
        by_id,
        note,
        url,
    )?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: actor_uid,
            actor_name,
            actor_role: Some(eff_role),
            project_id: Some(&project_id),
            action: "gates.record",
            target: Some(task_id),
            summary: format!("recorded gate {gate_id}={gate_state}"),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({ "ok": true, "gateEvent": record })))
}

/// HQ's tool server takes only agent bearer tokens: a signed-in browser session can't act as an agent.
fn resolve_mcp_caller(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: IpAddr,
    path_project_id: Option<&str>,
) -> Result<McpCaller, ApiError> {
    if let Some(version) = headers.get("mcp-protocol-version") {
        if version.as_bytes() != MCP_PROTOCOL_VERSION.as_bytes() {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("Unsupported MCP protocol version; this server speaks {MCP_PROTOCOL_VERSION}.")));
        }
    }
    agent_caller(state, headers, peer_ip, path_project_id)
}

/// The agent behind an MCP bearer token, refused when the token is unknown or belongs to another project.
pub(crate) fn agent_caller(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: IpAddr,
    path_project_id: Option<&str>,
) -> Result<McpCaller, ApiError> {
    let origin = headers.get(ORIGIN).and_then(|v| v.to_str().ok());
    let host = headers.get(HOST).and_then(|v| v.to_str().ok());
    if !state.is_allowed_origin(origin, host) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Origin not allowed."));
    }
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(str::trim)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "MCP needs an agent bearer token."))?;
    let (project_id, agent_id) = state
        .inner
        .mcp
        .verify_bearer_token(bearer)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Invalid MCP agent bearer token."))?;
    if path_project_id.is_some_and(|p| p != project_id) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "This token belongs to another project."));
    }
    Ok(McpCaller { project_id, agent_id, remote: !peer_ip.is_loopback() })
}

fn mcp_reply(state: &AppState, headers: &HeaderMap, peer_ip: IpAddr, project_id: Option<&str>, req: McpJsonRpcRequest) -> Result<Response, ApiError> {
    let caller = resolve_mcp_caller(state, headers, peer_ip, project_id)?;
    Ok(match handle_mcp_rpc(state, &caller, req) {
        Some(resp) => Json(resp).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    })
}

async fn mcp_root_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(req): Json<McpJsonRpcRequest>,
) -> Result<Response, ApiError> {
    mcp_reply(&state, &headers, peer_ip, None, req)
}

async fn mcp_project_endpoint(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(req): Json<McpJsonRpcRequest>,
) -> Result<Response, ApiError> {
    mcp_reply(&state, &headers, peer_ip, Some(&project_id), req)
}

async fn github_webhook_root(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let project_id = state
        .default_project()
        .map(|(id, _, _, _)| id)
        .unwrap_or_else(|| "proj-alpha".to_owned());
    process_github_webhook(&state, &project_id, &headers, &body)
}

async fn github_webhook_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    process_github_webhook(&state, &project_id, &headers, &body)
}

fn process_github_webhook(
    state: &AppState,
    project_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Json<Value>, ApiError> {
    let sig = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secret_str = state.inner.github.webhook_secret();
    let secret = secret_str.as_bytes();
    if !verify_github_signature(secret, body, sig) {
        let _ = record_audit(
            &state.inner.db,
            AuditWrite {
                actor_user_id: None,
                actor_name: "github-webhook",
                actor_role: None,
                project_id: Some(project_id),
                action: "github.webhook",
                target: Some(project_id),
                summary: "rejected: invalid X-Hub-Signature-256".into(),
                remote: true,
                allowed: false,
            },
        );
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid GitHub webhook signature.",
        ));
    }

    let event_kind = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("pull_request");
    let delivery_id = headers
        .get("x-github-delivery")
        .and_then(|v| v.to_str().ok());

    let payload: Value = serde_json::from_slice(body)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?;

    let (sync_state, updated_pr) =
        state
            .inner
            .github
            .process_webhook_event(project_id, event_kind, delivery_id, &payload)?;

    if let Some(ref pr) = updated_pr {
        let frame = json!({
            "type": "pr.updated",
            "pr": pr
        });
        state.inner.ws_hub.broadcast_project(project_id, &frame.to_string());
    }

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: None,
            actor_name: "github-webhook",
            actor_role: None,
            project_id: Some(project_id),
            action: "github.webhook",
            target: Some(project_id),
            summary: format!("processed event={event_kind} cursor={:?}", sync_state.cursor),
            remote: true,
            allowed: true,
        },
    );

    Ok(Json(json!({
        "ok": true,
        "cursor": sync_state.cursor,
        "lastDeliveryId": sync_state.last_delivery_id,
        "pullRequest": updated_pr
    })))
}

async fn list_preview_targets(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let slug = lookup_project_meta(&state, &project_id)?.map(|(s, _)| s);
    let (preview_origin, _) = preview_origin_for_request(
        &state,
        slug.as_deref(),
        ctx.origin.as_deref(),
        ctx.host.as_deref(),
        ctx.secure_cookie,
    );
    let targets = discover_project_targets(&state, &project_id, &preview_origin)
        .await
        .map_err(|e| ApiError::new(StatusCode::NOT_FOUND, e))?;
    Ok(Json(json!({ "targets": targets })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewTokenBody {
    target_id: String,
    next: Option<String>,
}

async fn create_preview_token(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<PreviewTokenBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, false)?;
    let slug = lookup_project_meta(&state, &project_id)?.map(|(s, _)| s);
    let (preview_origin, hq_origin) = preview_origin_for_request(
        &state,
        slug.as_deref(),
        ctx.origin.as_deref(),
        ctx.host.as_deref(),
        ctx.secure_cookie,
    );

    let tok_res = issue_preview_token(
        &state,
        &project_id,
        &body.target_id,
        body.next.as_deref(),
        &preview_origin,
        &hq_origin,
    )
    .await
    .map_err(|e| ApiError::new(StatusCode::NOT_FOUND, e))?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: session.user.as_ref().map(|u| u.id.as_str()),
            actor_name: session
                .user
                .as_ref()
                .map_or("bootstrap", |u| u.name.as_str()),
            actor_role: Some(effective_role_for_project(&state, &session, &project_id)),
            project_id: Some(&project_id),
            action: "preview.token",
            target: Some(&body.target_id),
            summary: format!("issued preview exchange token for {}", body.target_id),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({
        "token": tok_res.token,
        "previewUrl": tok_res.preview_url,
        "expiresAt": tok_res.expires_at
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewSnapshotBody {
    target_id: String,
    #[serde(default)]
    page_url: String,
    #[serde(default = "default_snap_w")]
    viewport_width: u32,
    #[serde(default = "default_snap_h")]
    viewport_height: u32,
}

fn default_snap_w() -> u32 {
    1440
}

fn default_snap_h() -> u32 {
    900
}

async fn create_preview_snapshot(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<PreviewSnapshotBody>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let _session = require_session(&state, &ctx, false)?;
    let (image_data_url, fallback) = capture_live_viewport_snapshot(
        &state,
        &project_id,
        &body.target_id,
        &body.page_url,
        body.viewport_width,
        body.viewport_height,
    )
    .await
    .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;

    Ok(Json(json!({
        "imageDataUrl": image_data_url,
        "fallback": fallback
    })))
}

async fn list_project_feedback(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let items = state.inner.feedback.list_by_project(&project_id)?;
    Ok(Json(json!({ "items": items })))
}

async fn submit_project_feedback(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    Json(body): Json<SubmitFeedbackInput>,
) -> Result<Json<Value>, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::POST)?;
    let session = require_session(&state, &ctx, true)?;
    let eff_role = effective_role_for_project(&state, &session, &project_id);
    let actor_uid = session.user.as_ref().map(|u| u.id.as_str());
    let actor_name = session
        .user
        .as_ref()
        .map_or("bootstrap", |u| u.name.as_str());

    if matches!(eff_role, ServerRole::Viewer) {
        let _ = record_audit(
            &state.inner.db,
            AuditWrite {
                actor_user_id: actor_uid,
                actor_name,
                actor_role: Some(eff_role),
                project_id: Some(&project_id),
                action: "feedback.create",
                target: Some(&project_id),
                summary: "denied: viewer role is strictly read-only".into(),
                remote: ctx.remote,
                allowed: false,
            },
        );
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "viewer role is strictly read-only",
        ));
    }

    let author_id = actor_uid.unwrap_or(actor_name);
    let fb = create_and_route_feedback(&state, &project_id, author_id, body)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;

    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: actor_uid,
            actor_name,
            actor_role: Some(eff_role),
            project_id: Some(&project_id),
            action: "feedback.create",
            target: Some(&fb.id),
            summary: format!("submitted visual feedback {} -> {}", fb.id, fb.workspace_rel_dir),
            remote: ctx.remote,
            allowed: true,
        },
    );

    Ok(Json(json!({ "feedback": fb })))
}

async fn get_feedback_image(
    State(state): State<AppState>,
    Path((project_id, feedback_id)): Path<(String, String)>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> Result<Response, ApiError> {
    let ctx = extract_ctx(&state, &headers, peer_ip, &Method::GET)?;
    let _session = require_session(&state, &ctx, false)?;
    let maybe_bytes = load_feedback_image_bytes(&state, &project_id, &feedback_id)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    let Some(bytes) = maybe_bytes else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Feedback image not found."));
    };
    Ok((
        [
            (CONTENT_TYPE, "image/png".to_owned()),
            (CACHE_CONTROL, "private, max-age=300".to_owned()),
        ],
        bytes,
    )
        .into_response())
}

async fn static_or_404(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path == "ws" {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Not found" })),
        )
            .into_response();
    }

    let candidate = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = EmbeddedAssets::get(candidate) {
        let mime = mime_guess::from_path(candidate)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        let cache = if candidate == "index.html" {
            "no-cache"
        } else {
            "public, max-age=31536000, immutable"
        };
        return (
            [(CONTENT_TYPE, mime), (CACHE_CONTROL, cache.to_owned())],
            file.data.into_owned(),
        )
            .into_response();
    }

    if let Some(index) = EmbeddedAssets::get("index.html") {
        return (
            [
                (CONTENT_TYPE, "text/html; charset=utf-8".to_owned()),
                (CACHE_CONTROL, "no-cache".to_owned()),
            ],
            index.data.into_owned(),
        )
            .into_response();
    }

    (
        [
            (CONTENT_TYPE, "text/html; charset=utf-8".to_owned()),
            (CACHE_CONTROL, "no-cache".to_owned()),
        ],
        "<!doctype html><html><head><title>ArimaOps</title></head><body><h1>ArimaOps v2</h1></body></html>",
    )
        .into_response()
}

pub fn audit_redacted_value(v: &Value) -> Value {
    redact_json_value(v)
}
