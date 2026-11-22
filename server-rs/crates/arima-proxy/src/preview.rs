// SPDX-License-Identifier: AGPL-3.0-or-later

//! Origin-isolated Live Preview Reverse Proxy (`:7421` / subdomain mode).
//!
//! Security invariants:
//! - Signs short-lived HMAC-SHA256 preview exchange tokens with a domain-separated key.
//! - Exchanges `/__arima_preview/exchange?token=...&next=...` into an `HttpOnly; SameSite=Lax; Path=/`
//!   cookie named `arima_preview_sid`, strictly isolated from HQ's `hq_sid`.
//! - NEVER accepts `hq_sid` for authentication and ALWAYS strips `hq_sid` before forwarding to
//!   upstream dev servers.
//! - Strips `X-Frame-Options` and CSP `frame-ancestors` from upstream responses and injects a
//!   strict `frame-ancestors` policy + origin-locked `ArimaBridge` on `text/html` documents.
//! - Forwards both HTTP requests and WebSocket/HMR upgrades cleanly.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{Message as AxumWsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Query, Request, State};
use axum::http::header::{
    CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, LOCATION, SEC_WEBSOCKET_PROTOCOL, SET_COOKIE,
    UPGRADE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TungMsg;

use crate::bridge::{inject_bridge_html, normalize_strict_origin};
use crate::discovery::{PreviewRegistry, RegisteredUpstream};

/// Errors produced during preview token/cookie verification or reverse proxying.
#[derive(Debug, Error)]
pub enum PreviewError {
    #[error("bad preview request: {0}")]
    BadRequest(String),
    #[error("forbidden preview access: {0}")]
    Forbidden(String),
}

type HmacSha256 = Hmac<Sha256>;

/// Preview-only session cookie name (strictly separate from HQ's `hq_sid`).
pub const PREVIEW_COOKIE_NAME: &str = "arima_preview_sid";
const HQ_COOKIE_NAME: &str = "hq_sid";
const DEFAULT_TOKEN_TTL_SECS: i64 = 1800;

/// Claims signed into preview exchange tokens and `arima_preview_sid` cookies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewClaims {
    pub project_id: String,
    pub target_id: String,
    pub hq_origin: String,
    pub exp: i64,
    pub nonce: String,
}

/// HMAC-SHA256 signer for short-lived preview tokens and isolated `arima_preview_sid` cookies.
#[derive(Debug, Clone)]
pub struct PreviewTokenSigner {
    token_key: [u8; 32],
    cookie_key: [u8; 32],
}

impl PreviewTokenSigner {
    /// Derives domain-separated preview token & cookie HMAC keys from a 32-byte master secret.
    #[must_use]
    pub fn from_master_bytes(master: &[u8]) -> Self {
        let mut m1 = HmacSha256::new_from_slice(master).expect("hmac key");
        m1.update(b"arima-preview-exchange-token-v2");
        let k1 = m1.finalize().into_bytes();

        let mut m2 = HmacSha256::new_from_slice(master).expect("hmac key");
        m2.update(b"arima-preview-session-cookie-v2");
        let k2 = m2.finalize().into_bytes();

        let mut token_key = [0u8; 32];
        let mut cookie_key = [0u8; 32];
        token_key.copy_from_slice(&k1);
        cookie_key.copy_from_slice(&k2);
        Self {
            token_key,
            cookie_key,
        }
    }

    /// Generates an ephemeral random preview signer (used in tests or ephemeral sessions).
    #[must_use]
    pub fn ephemeral() -> Self {
        let seed = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        Self::from_master_bytes(seed.as_bytes())
    }

    /// Signs a short-lived preview exchange token for `(project_id, target_id, hq_origin)`.
    ///
    /// Returns `(token, expires_at_rfc3339)`.
    #[must_use]
    pub fn sign_token(
        &self,
        project_id: &str,
        target_id: &str,
        hq_origin: &str,
        ttl_secs: Option<i64>,
    ) -> (String, String) {
        let now = Utc::now().timestamp();
        let ttl = ttl_secs.unwrap_or(DEFAULT_TOKEN_TTL_SECS).clamp(10, 86_400);
        let exp = now + ttl;
        let strict_origin = normalize_strict_origin(hq_origin)
            .unwrap_or_else(|| "http://127.0.0.1:7420".to_owned());

        let claims = PreviewClaims {
            project_id: project_id.to_owned(),
            target_id: target_id.to_owned(),
            hq_origin: strict_origin,
            exp,
            nonce: uuid::Uuid::new_v4().simple().to_string(),
        };
        let tok = sign_claims(&self.token_key, &claims);
        let expires_at = DateTime::from_timestamp(exp, 0)
            .unwrap_or_else(Utc::now)
            .to_rfc3339();
        (tok, expires_at)
    }

    /// Verifies a preview exchange token in constant time against `now_secs`.
    pub fn verify_token(
        &self,
        token: &str,
        now_secs: Option<i64>,
    ) -> Result<PreviewClaims, PreviewError> {
        verify_claims(
            &self.token_key,
            token,
            now_secs.unwrap_or_else(|| Utc::now().timestamp()),
        )
    }

    /// Signs an `arima_preview_sid` cookie value (distinct key from exchange tokens).
    #[must_use]
    pub fn sign_cookie(&self, claims: &PreviewClaims) -> String {
        sign_claims(&self.cookie_key, claims)
    }

    /// Verifies an `arima_preview_sid` cookie value in constant time.
    pub fn verify_cookie(
        &self,
        cookie_val: &str,
        now_secs: Option<i64>,
    ) -> Result<PreviewClaims, PreviewError> {
        verify_claims(
            &self.cookie_key,
            cookie_val,
            now_secs.unwrap_or_else(|| Utc::now().timestamp()),
        )
    }
}

fn sign_claims(key: &[u8; 32], claims: &PreviewClaims) -> String {
    let payload_json = serde_json::to_vec(claims).unwrap_or_default();
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json);
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(payload_b64.as_bytes());
    let sig_hex = hex::encode(mac.finalize().into_bytes());
    format!("{payload_b64}.{sig_hex}")
}

fn verify_claims(key: &[u8; 32], raw: &str, now_secs: i64) -> Result<PreviewClaims, PreviewError> {
    let Some((payload_b64, sig_hex)) = raw.trim().split_once('.') else {
        return Err(PreviewError::BadRequest("malformed preview token".into()));
    };
    let provided_sig = hex::decode(sig_hex)
        .map_err(|_| PreviewError::BadRequest("invalid preview token signature hex".into()))?;
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(payload_b64.as_bytes());
    let expected_sig = mac.finalize().into_bytes();
    if provided_sig.len() != expected_sig.len()
        || !bool::from(provided_sig.ct_eq(expected_sig.as_slice()))
    {
        return Err(PreviewError::Forbidden(
            "invalid preview token signature".into(),
        ));
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| PreviewError::BadRequest("invalid preview token encoding".into()))?;
    let claims: PreviewClaims = serde_json::from_slice(&payload_bytes)
        .map_err(|_| PreviewError::BadRequest("invalid preview token payload".into()))?;

    if claims.exp <= now_secs {
        return Err(PreviewError::Forbidden("preview token expired".into()));
    }
    if normalize_strict_origin(&claims.hq_origin).is_none() {
        return Err(PreviewError::Forbidden(
            "invalid hq_origin in preview token".into(),
        ));
    }
    Ok(claims)
}

/// Configuration for the origin-isolated Preview Proxy server.
#[derive(Debug, Clone)]
pub struct PreviewProxyConfig {
    pub default_hq_origin: String,
    pub secure_cookies: bool,
    pub trust_proxy: bool,
}

impl Default for PreviewProxyConfig {
    fn default() -> Self {
        Self {
            default_hq_origin: "http://127.0.0.1:7420".into(),
            secure_cookies: false,
            trust_proxy: false,
        }
    }
}

#[derive(Clone)]
struct PreviewState {
    registry: PreviewRegistry,
    signer: PreviewTokenSigner,
    http: reqwest::Client,
    config: PreviewProxyConfig,
}

/// Handle to a running Preview Proxy background task.
pub struct PreviewProxyHandle {
    pub addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl PreviewProxyHandle {
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for PreviewProxyHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Origin-isolated HTTP + WebSocket/HMR reverse proxy for live app previews.
pub struct PreviewProxy;

impl PreviewProxy {
    /// Builds the Axum [`Router`] for the isolated preview proxy (usable directly in tests or served over TCP).
    pub fn router(
        registry: PreviewRegistry,
        signer: PreviewTokenSigner,
        config: PreviewProxyConfig,
    ) -> Router {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("preview proxy reqwest client");
        let state = Arc::new(PreviewState {
            registry,
            signer,
            http,
            config,
        });

        Router::new()
            .route("/__arima_preview/health", get(preview_health))
            .route("/__arima_preview/exchange", get(preview_exchange))
            .fallback(proxy_request_handler)
            .with_state(state)
    }

    /// Binds and spawns the isolated Preview Proxy server on `bind_addr`.
    pub async fn bind(
        bind_addr: SocketAddr,
        registry: PreviewRegistry,
        signer: PreviewTokenSigner,
        config: PreviewProxyConfig,
    ) -> std::io::Result<PreviewProxyHandle> {
        let listener = TcpListener::bind(bind_addr).await?;
        let addr = listener.local_addr()?;
        let router = Self::router(registry, signer, config);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(PreviewProxyHandle {
            addr,
            shutdown_tx: Some(shutdown_tx),
        })
    }
}

#[derive(Debug, Deserialize)]
struct HealthQuery {
    domain: Option<String>,
}

/// Health endpoint & Caddy On-Demand TLS `ask` validator.
///
/// - Without `?domain=...`: returns `200 OK` liveness probe.
/// - With `?domain=<host>` (Caddy `on_demand_tls.ask`): allows ONLY registered `preview-<slug>.<domain>`
///   subdomains so random unowned subdomains cannot trigger Let's Encrypt certificate exhaustion.
async fn preview_health(
    State(state): State<Arc<PreviewState>>,
    Query(q): Query<HealthQuery>,
) -> Response {
    if let Some(domain) = q.domain.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let allowed_slug = PreviewRegistry::parse_subdomain_slug(domain)
            .filter(|slug| state.registry.find_by_project_slug(slug).is_some());
        return match allowed_slug {
            Some(slug) => (
                StatusCode::OK,
                Json(json!({ "ok": true, "proxy": "preview", "allowed": true, "slug": slug })),
            )
                .into_response(),
            None => (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "allowed": false, "error": "Unknown preview subdomain" })),
            )
                .into_response(),
        };
    }

    (StatusCode::OK, Json(json!({ "ok": true, "proxy": "preview" }))).into_response()
}

#[derive(Debug, Deserialize)]
struct ExchangeQuery {
    token: String,
    next: Option<String>,
}

fn sanitize_next_path(next: Option<&str>) -> String {
    let raw = next.unwrap_or("/").trim();
    if raw.starts_with('/') && !raw.starts_with("//") && !raw.contains('\r') && !raw.contains('\n') {
        raw.to_owned()
    } else {
        "/".to_owned()
    }
}

async fn preview_exchange(
    State(state): State<Arc<PreviewState>>,
    Query(q): Query<ExchangeQuery>,
    headers: HeaderMap,
) -> Response {
    let claims = match state.signer.verify_token(&q.token, None) {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Invalid or expired preview token." })),
            )
                .into_response();
        }
    };

    let cookie_val = state.signer.sign_cookie(&claims);
    let remaining_ttl = (claims.exp - Utc::now().timestamp()).clamp(10, 86_400);
    let proto_https = state.config.trust_proxy
        && headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|p| p.eq_ignore_ascii_case("https"));
    let hq_https = claims.hq_origin.starts_with("https://");
    let secure_attr = if state.config.secure_cookies || proto_https || hq_https {
        "; Secure"
    } else {
        ""
    };
    let set_cookie = format!(
        "{PREVIEW_COOKIE_NAME}={cookie_val}; HttpOnly; SameSite=Lax; Path=/; Max-Age={remaining_ttl}{secure_attr}"
    );
    let next_path = sanitize_next_path(q.next.as_deref());

    let mut resp = (StatusCode::FOUND, Body::empty()).into_response();
    if let Ok(loc) = HeaderValue::from_str(&next_path) {
        resp.headers_mut().insert(LOCATION, loc);
    }
    if let Ok(ck) = HeaderValue::from_str(&set_cookie) {
        resp.headers_mut().insert(SET_COOKIE, ck);
    }
    resp.headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    resp
}

fn extract_named_cookie(cookie_header: &str, name: &str) -> Option<String> {
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_owned());
            }
        }
    }
    None
}

/// Strips both `hq_sid` and `arima_preview_sid` from any Cookie header before forwarding upstream.
#[must_use]
pub fn strip_arima_cookies(cookie_header: &str) -> Option<String> {
    let kept: Vec<&str> = cookie_header
        .split(';')
        .map(str::trim)
        .filter(|part| {
            let Some((k, _)) = part.split_once('=') else {
                return false;
            };
            let key = k.trim();
            !key.eq_ignore_ascii_case(HQ_COOKIE_NAME)
                && !key.eq_ignore_ascii_case(PREVIEW_COOKIE_NAME)
        })
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("; "))
    }
}

/// Rewrites an upstream `Content-Security-Policy` header by removing any upstream
/// `frame-ancestors` directive and setting a strict `frame-ancestors 'self' <hq_origin>`.
#[must_use]
pub fn rewrite_csp_frame_ancestors(upstream_csp: Option<&str>, hq_origin: &str) -> String {
    let strict_hq = normalize_strict_origin(hq_origin)
        .unwrap_or_else(|| "http://127.0.0.1:7420".to_owned());
    let mut directives: Vec<String> = upstream_csp
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .filter(|d| !d.to_ascii_lowercase().starts_with("frame-ancestors"))
        .map(str::to_owned)
        .collect();
    directives.push(format!("frame-ancestors 'self' {strict_hq}"));
    directives.join("; ")
}

async fn proxy_request_handler(
    State(state): State<Arc<PreviewState>>,
    req: Request,
) -> Response {
    let (mut parts, body) = req.into_parts();
    let cookie_hdr = parts
        .headers
        .get(COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Strictly require `arima_preview_sid`; NEVER accept `hq_sid`.
    let Some(raw_preview_cookie) = extract_named_cookie(cookie_hdr, PREVIEW_COOKIE_NAME) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Preview session required." })),
        )
            .into_response();
    };
    let claims = match state.signer.verify_cookie(&raw_preview_cookie, None) {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Invalid or expired preview session." })),
            )
                .into_response();
        }
    };

    // Resolve upstream target: if subdomain host-header (`preview-<slug>.<host>`) is present,
    // strictly enforce that the subdomain's project matches the signed cookie's `claims.project_id`
    // so a preview cookie from project A can never be replayed on `preview-project-b.<domain>`.
    let host_hdr = parts
        .headers
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let upstream: Option<RegisteredUpstream> = if let Some(slug) =
        PreviewRegistry::parse_subdomain_slug(host_hdr)
    {
        let by_target = state.registry.get(&claims.target_id);
        let slug_matches_target = by_target
            .as_ref()
            .is_some_and(|t| t.project_slug.replace('_', "-").eq_ignore_ascii_case(&slug));
        if slug_matches_target {
            by_target
        } else {
            let by_slug = state.registry.find_by_project_slug(&slug);
            match by_slug {
                Some(up) if up.project_id == claims.project_id => Some(up),
                _ => {
                    return (
                        StatusCode::FORBIDDEN,
                        Json(json!({ "error": "Preview session does not match requested subdomain." })),
                    )
                        .into_response();
                }
            }
        }
    } else {
        state.registry.get(&claims.target_id)
    };

    let Some(target) = upstream else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Preview target is not registered or offline." })),
        )
            .into_response();
    };

    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_owned())
        .unwrap_or_else(|| "/".to_owned());

    // Handle WebSocket / Vite HMR upgrade requests.
    let is_ws_upgrade = parts
        .headers
        .get(UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|u| u.eq_ignore_ascii_case("websocket"));

    if is_ws_upgrade {
        if let Ok(ws_upgrade) = WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            let subprotocol = parts
                .headers
                .get(SEC_WEBSOCKET_PROTOCOL)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let upstream_ws_url = format!(
                "ws://{}{}",
                target.upstream_authority(),
                path_and_query
            );
            let upgrade_resp = if let Some(ref proto) = subprotocol {
                let first_proto = proto.split(',').next().unwrap_or(proto).trim().to_owned();
                ws_upgrade
                    .protocols([first_proto])
                    .on_upgrade(move |client_ws| {
                        bridge_websocket(client_ws, upstream_ws_url, subprotocol)
                    })
            } else {
                ws_upgrade.on_upgrade(move |client_ws| {
                    bridge_websocket(client_ws, upstream_ws_url, None)
                })
            };
            return upgrade_resp;
        }
    }

    let rebuilt = Request::from_parts(parts, body);
    proxy_http_request(state, rebuilt, target, claims, path_and_query).await
}

async fn proxy_http_request(
    state: Arc<PreviewState>,
    req: Request,
    target: RegisteredUpstream,
    claims: PreviewClaims,
    path_and_query: String,
) -> Response {
    let upstream_url = format!("http://{}{}", target.upstream_authority(), path_and_query);
    let method = req.method().clone();
    let req_headers = req.headers().clone();

    let body_bytes = match axum::body::to_bytes(req.into_body(), 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({ "error": "Request body too large." })),
            )
                .into_response();
        }
    };

    let mut upstream_req = state.http.request(method, &upstream_url);
    for (name, value) in &req_headers {
        let lower = name.as_str();
        // Never forward hop-by-hop headers, accept-encoding (so HTML can be injected cleanly),
        // or raw Cookie header containing `hq_sid` / `arima_preview_sid`.
        if matches!(
            lower,
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "accept-encoding"
                | "keep-alive"
                | "upgrade"
        ) {
            continue;
        }
        if lower == "cookie" {
            if let Ok(raw_ck) = value.to_str() {
                if let Some(clean_ck) = strip_arima_cookies(raw_ck) {
                    upstream_req = upstream_req.header(COOKIE, clean_ck);
                }
            }
            continue;
        }
        upstream_req = upstream_req.header(name.clone(), value.clone());
    }

    if !body_bytes.is_empty() {
        upstream_req = upstream_req.body(body_bytes);
    }

    let upstream_resp = match upstream_req.send().await {
        Ok(r) => r,
        Err(err) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Upstream dev server unreachable: {err}") })),
            )
                .into_response();
        }
    };

    let status = upstream_resp.status();
    let upstream_headers = upstream_resp.headers().clone();
    let is_html = upstream_headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().starts_with("text/html"));

    let resp_bytes = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(err) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Failed reading upstream body: {err}") })),
            )
                .into_response();
        }
    };

    let hq_origin = normalize_strict_origin(&claims.hq_origin)
        .unwrap_or_else(|| state.config.default_hq_origin.clone());

    let final_bytes = if is_html {
        let html = String::from_utf8_lossy(&resp_bytes);
        inject_bridge_html(&html, &hq_origin).into_bytes()
    } else {
        resp_bytes.to_vec()
    };

    let mut out = Response::builder().status(status);
    let mut upstream_csp: Option<String> = None;

    for (name, value) in &upstream_headers {
        let lower = name.as_str();
        // Strip X-Frame-Options, hop-by-hop headers, and content-length (recomputed after injection).
        if matches!(
            lower,
            "x-frame-options"
                | "content-length"
                | "transfer-encoding"
                | "connection"
                | "content-encoding"
        ) {
            continue;
        }
        if lower == "content-security-policy" {
            if let Ok(s) = value.to_str() {
                upstream_csp = Some(s.to_owned());
            }
            continue;
        }
        out = out.header(name.clone(), value.clone());
    }

    let rewritten_csp = rewrite_csp_frame_ancestors(upstream_csp.as_deref(), &hq_origin);
    out = out
        .header(
            HeaderName::from_static("content-security-policy"),
            rewritten_csp,
        )
        .header(HeaderName::from_static("referrer-policy"), "no-referrer")
        .header(CONTENT_LENGTH, final_bytes.len().to_string());

    out.body(Body::from(final_bytes))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "proxy response error").into_response())
}

async fn bridge_websocket(
    client_ws: WebSocket,
    upstream_url: String,
    subprotocol: Option<String>,
) {
    let Ok(mut req) = upstream_url.into_client_request() else {
        return;
    };
    if let Some(proto) = subprotocol {
        if let Ok(val) = HeaderValue::from_str(&proto) {
            req.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, val);
        }
    }

    let Ok((upstream_ws, _)) = tokio_tungstenite::connect_async(req).await else {
        return;
    };

    let (mut client_sink, mut client_stream) = client_ws.split();
    let (mut up_sink, mut up_stream) = upstream_ws.split();

    let c2u = tokio::spawn(async move {
        while let Some(Ok(msg)) = client_stream.next().await {
            let mapped = match msg {
                AxumWsMsg::Text(t) => TungMsg::Text(t.to_string().into()),
                AxumWsMsg::Binary(b) => TungMsg::Binary(b),
                AxumWsMsg::Ping(p) => TungMsg::Ping(p),
                AxumWsMsg::Pong(p) => TungMsg::Pong(p),
                AxumWsMsg::Close(_) => {
                    let _ = up_sink.send(TungMsg::Close(None)).await;
                    break;
                }
            };
            if up_sink.send(mapped).await.is_err() {
                break;
            }
        }
    });

    let u2c = tokio::spawn(async move {
        while let Some(Ok(msg)) = up_stream.next().await {
            let mapped = match msg {
                TungMsg::Text(t) => AxumWsMsg::Text(t.to_string().into()),
                TungMsg::Binary(b) => AxumWsMsg::Binary(b),
                TungMsg::Ping(p) => AxumWsMsg::Ping(p),
                TungMsg::Pong(p) => AxumWsMsg::Pong(p),
                TungMsg::Close(_) => {
                    let _ = client_sink.send(AxumWsMsg::Close(None)).await;
                    break;
                }
                TungMsg::Frame(_) => continue,
            };
            if client_sink.send(mapped).await.is_err() {
                break;
            }
        }
    });

    let _ = tokio::join!(c2u, u2c);
}
