// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::SocketAddr;

use arima_auth::{AuthService, VaultKey};
use arima_core::WsClientMessage;
use arima_db::Db;
use arima_server::{router_with_state, AppState, ServerConfig};
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use tower::ServiceExt;

async fn spawn_test_server() -> (SocketAddr, AppState, TempDir) {
    let dir = TempDir::new().unwrap();
    let db = Db::open(&dir.path().join("arima.db")).unwrap();
    let vault = VaultKey::from_bytes([42u8; 32]);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let cfg = ServerConfig {
        port: addr.port(),
        preview_port: addr.port() + 1,
        bootstrap_token: "boot-token-123".into(),
        local_origins: vec![
            format!("http://127.0.0.1:{}", addr.port()),
            format!("http://localhost:{}", addr.port()),
        ],
        allowed_origins: vec![],
        preview_origin: Some(format!("http://127.0.0.1:{}", addr.port() + 1)),
        trust_proxy: false,
        same_origin: false,
        data_root: Some(dir.path().to_path_buf()),
    };
    let state = AppState::new(db, vault, cfg);
    state
        .ensure_default_project("Alpha", "alpha", "/tmp/alpha")
        .unwrap();

    let app = router_with_state(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, state, dir)
}

async fn http_json(
    addr: SocketAddr,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    origin: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, HeaderPair, Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    if let Some(c) = cookie {
        req.push_str(&format!("Cookie: hq_sid={c}\r\n"));
    }
    if let Some(o) = origin {
        req.push_str(&format!("Origin: {o}\r\n"));
    }
    if !payload.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    req.push_str("\r\n");
    req.push_str(&payload);
    stream.write_all(req.as_bytes()).await.unwrap();

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw);
    let (head, body_str) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.lines();
    let status_line = lines.next().unwrap();
    let code: u16 = status_line.split_whitespace().nth(1).unwrap().parse().unwrap();
    let mut set_cookie = None;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            if k.eq_ignore_ascii_case("set-cookie") {
                if let Some(kv) = v.trim().split(';').next() {
                    if let Some(tok) = kv.strip_prefix("hq_sid=") {
                        set_cookie = Some(tok.to_owned());
                    }
                }
            }
        }
    }
    let json_val = serde_json::from_str(body_str).unwrap_or(Value::Null);
    (
        StatusCode::from_u16(code).unwrap(),
        HeaderPair { set_cookie },
        json_val,
    )
}

struct HeaderPair {
    set_cookie: Option<String>,
}

async fn connect_ws(
    addr: SocketAddr,
    cookie: &str,
    origin: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut req = format!("ws://{addr}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Cookie", format!("hq_sid={cookie}").parse().unwrap());
    req.headers_mut().insert("Origin", origin.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    // Drain initial snapshot frame.
    let first = ws.next().await.unwrap().unwrap();
    assert!(matches!(first, WsMsg::Text(_)));
    ws
}

#[tokio::test]
async fn malformed_cookie_does_not_crash_and_security_headers_present() {
    let (addr, _state, _dir) = spawn_test_server().await;
    let origin = format!("http://127.0.0.1:{}", addr.port());

    // Malformed cookie on HTTP endpoint and WS upgrade must return 401 safely.
    let (status, _, _) =
        http_json(addr, "GET", "/api/auth/me", Some("%E0%A4%A"), Some(&origin), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let mut ws_req = format!("ws://{addr}/ws").into_client_request().unwrap();
    ws_req
        .headers_mut()
        .insert("Cookie", "hq_sid=%E0%A4%A".parse().unwrap());
    ws_req
        .headers_mut()
        .insert("Origin", origin.parse().unwrap());
    let err = tokio_tungstenite::connect_async(ws_req).await.unwrap_err();
    assert!(err.to_string().contains("401"));

    // Verify health & security headers using oneshot on router.
    let app = arima_server::build_router();
    let res = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(res.headers().get("referrer-policy").unwrap(), "no-referrer");
    let csp = res
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(csp.contains("frame-ancestors 'none'"));
    assert!(csp.contains("frame-src 'self' http://127.0.0.1:7421"));

    // Server still healthy after malformed cookie attempts.
    let (health_status, _, health_body) = http_json(addr, "GET", "/api/health", None, None, None).await;
    assert_eq!(health_status, StatusCode::OK);
    assert_eq!(health_body["ok"], true);
}

#[tokio::test]
async fn full_rbac_reset_revocation_device_revoke_throttle_and_audit() {
    let (addr, state, dir) = spawn_test_server().await;
    let origin = format!("http://127.0.0.1:{}", addr.port());

    // 1. Exchange bootstrap token locally and create first Owner user (returns otpauth + qrSvg).
    let (s, hdr, _) = http_json(
        addr,
        "POST",
        "/api/login",
        None,
        Some(&origin),
        Some(json!({ "token": "boot-token-123" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let boot_cookie = hdr.set_cookie.unwrap();

    let (s, _, owner_res) = http_json(
        addr,
        "POST",
        "/api/users",
        Some(&boot_cookie),
        Some(&origin),
        Some(json!({ "name": "Sachin", "password": "owner-secret-pw-1", "role": "owner" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(owner_res["otpauth"].as_str().unwrap().starts_with("otpauth://totp/"));
    assert!(owner_res["qrSvg"].as_str().unwrap().contains("<svg"));

    // Sign in as owner via password.
    let (s, hdr, _) = http_json(
        addr,
        "POST",
        "/api/auth/login",
        None,
        Some(&origin),
        Some(json!({ "name": "Sachin", "password": "owner-secret-pw-1" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let owner_cookie = hdr.set_cookie.unwrap();

    // Create an Operator and a Viewer.
    let (s, _, op_res) = http_json(
        addr,
        "POST",
        "/api/users",
        Some(&owner_cookie),
        Some(&origin),
        Some(json!({ "name": "OpUser", "password": "operator-secret-pw", "role": "operator" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let op_id = op_res["user"]["id"].as_str().unwrap().to_owned();

    let (s, _, _vw_res) = http_json(
        addr,
        "POST",
        "/api/users",
        Some(&owner_cookie),
        Some(&origin),
        Some(json!({ "name": "ViewUser", "password": "viewer-secret-pw-1", "role": "viewer" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    // Login as Viewer and Operator.
    let (_, hdr, _) = http_json(
        addr,
        "POST",
        "/api/auth/login",
        None,
        Some(&origin),
        Some(json!({ "name": "ViewUser", "password": "viewer-secret-pw-1" })),
    )
    .await;
    let viewer_cookie = hdr.set_cookie.unwrap();

    let (_, hdr, _) = http_json(
        addr,
        "POST",
        "/api/auth/login",
        None,
        Some(&origin),
        Some(json!({ "name": "OpUser", "password": "operator-secret-pw" })),
    )
    .await;
    let op_cookie = hdr.set_cookie.unwrap();

    // 2. Viewer WS RBAC: sendMessage, askTeam, startAgent must return CommandAck { ok: false }.
    let mut viewer_ws = connect_ws(addr, &viewer_cookie, &origin).await;
    for (idx, cmd) in ["sendMessage", "askTeam", "startAgent"].iter().enumerate() {
        let msg = WsClientMessage {
            id: format!("v-{idx}"),
            cmd: (*cmd).into(),
            args: vec![json!("lead"), json!("ignore rules")],
        };
        viewer_ws
            .send(WsMsg::Text(serde_json::to_string(&msg).unwrap().into()))
            .await
            .unwrap();
        let reply = viewer_ws.next().await.unwrap().unwrap();
        let v: Value = serde_json::from_str(reply.to_text().unwrap()).unwrap();
        assert_eq!(v["type"], "command-ack");
        assert_eq!(v["ok"], false, "viewer must be blocked for {cmd}");
    }

    // 3. Operator WS RBAC: blocked on Local env vars and owner-only recordGate.
    let mut op_ws = connect_ws(addr, &op_cookie, &origin).await;
    for (idx, (cmd, args)) in [
        ("setEnvVar", vec![Value::Null, json!("NODE_OPTIONS"), json!("--eval")]),
        ("recordGate", vec![json!("T01"), json!("merge"), json!("passed")]),
    ]
    .iter()
    .enumerate()
    {
        let msg = WsClientMessage {
            id: format!("o-{idx}"),
            cmd: (*cmd).into(),
            args: args.clone(),
        };
        op_ws
            .send(WsMsg::Text(serde_json::to_string(&msg).unwrap().into()))
            .await
            .unwrap();
        let reply = op_ws.next().await.unwrap().unwrap();
        let v: Value = serde_json::from_str(reply.to_text().unwrap()).unwrap();
        assert_eq!(v["type"], "command-ack");
        assert_eq!(v["ok"], false, "operator must be blocked for {cmd}");
    }

    // Per-project RBAC narrowing: downgrade OpUser to Viewer on proj-alpha -> ping allowed, createBoard denied.
    let (s, _, _) = http_json(
        addr,
        "PUT",
        &format!("/api/projects/proj-alpha/roles/{op_id}"),
        Some(&owner_cookie),
        Some(&origin),
        Some(json!({ "role": "viewer" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let msg = WsClientMessage {
        id: "o-narrow".into(),
        cmd: "createBoard".into(),
        args: vec![json!("Phase 9")],
    };
    op_ws
        .send(WsMsg::Text(serde_json::to_string(&msg).unwrap().into()))
        .await
        .unwrap();
    let reply = op_ws.next().await.unwrap().unwrap();
    let v: Value = serde_json::from_str(reply.to_text().unwrap()).unwrap();
    assert_eq!(v["ok"], false);

    // 4. Admin password reset on OpUser immediately revokes session and closes op_ws with 4001.
    let (s, _, _) = http_json(
        addr,
        "PATCH",
        &format!("/api/users/{op_id}"),
        Some(&owner_cookie),
        Some(&origin),
        Some(json!({ "password": "operator-reset-pw-2", "resetTotp": true })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let closed = op_ws.next().await.unwrap().unwrap();
    match closed {
        WsMsg::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4001),
        other => panic!("expected Close(4001), got {other:?}"),
    }
    let (me_after, _, _) = http_json(addr, "GET", "/api/auth/me", Some(&op_cookie), Some(&origin), None).await;
    assert_eq!(me_after, StatusCode::UNAUTHORIZED);

    // 5. Viewer revokes own device session via DELETE /api/auth/devices/{id} -> viewer_ws closes 4001.
    let (s, _, devs) = http_json(
        addr,
        "GET",
        "/api/auth/devices",
        Some(&viewer_cookie),
        Some(&origin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let viewer_dev_id = devs["devices"][0]["id"].as_str().unwrap().to_owned();
    let (s, _, _) = http_json(
        addr,
        "DELETE",
        &format!("/api/auth/devices/{viewer_dev_id}"),
        Some(&viewer_cookie),
        Some(&origin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v_closed = viewer_ws.next().await.unwrap().unwrap();
    match v_closed {
        WsMsg::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4001),
        other => panic!("expected Close(4001) on device revoke, got {other:?}"),
    }

    // 6. Foreign Origin rejected on mutating requests.
    let (s, _, _) = http_json(
        addr,
        "POST",
        "/api/projects",
        Some(&owner_cookie),
        Some("https://evil.example"),
        Some(json!({ "name": "Evil", "slug": "evil" })),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // 7. Create + delete project audited, and audit log NEVER leaks passwords.
    let (s, _, _) = http_json(
        addr,
        "POST",
        "/api/projects",
        Some(&owner_cookie),
        Some(&origin),
        Some(json!({ "name": "Beta", "slug": "beta" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = http_json(
        addr,
        "DELETE",
        "/api/projects/proj-beta",
        Some(&owner_cookie),
        Some(&origin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let (s, _, audit_res) = http_json(
        addr,
        "GET",
        "/api/audit?limit=100",
        Some(&owner_cookie),
        Some(&origin),
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let audit_str = audit_res.to_string();
    assert!(audit_str.contains("projects.create"));
    assert!(audit_str.contains("projects.delete"));
    assert!(audit_str.contains("auth.login"));
    assert!(audit_str.contains("ws.sendMessage"));
    assert!(!audit_str.contains("owner-secret-pw-1"));
    assert!(!audit_str.contains("operator-reset-pw-2"));

    // 8. Persistent throttling on the DB file survives new AuthService instance.
    for _ in 0..5 {
        let (st, _, _) = http_json(
            addr,
            "POST",
            "/api/auth/login",
            None,
            Some(&origin),
            Some(json!({ "name": "Sachin", "password": "bad-guess-password" })),
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }
    let (locked_st, _, _) = http_json(
        addr,
        "POST",
        "/api/auth/login",
        None,
        Some(&origin),
        Some(json!({ "name": "Sachin", "password": "owner-secret-pw-1" })),
    )
    .await;
    assert_eq!(locked_st, StatusCode::TOO_MANY_REQUESTS);

    drop(state);
    let reopened = Db::open(&dir.path().join("arima.db")).unwrap();
    let auth2 = AuthService::new(reopened, VaultKey::from_bytes([42u8; 32]));
    let still_locked = auth2
        .login_with_password(
            "Sachin".into(),
            "owner-secret-pw-1".into(),
            arima_auth::SessionMeta {
                client_ip: "127.0.0.1".into(),
                origin: Some(origin),
                label: "Test".into(),
                remote: false,
            },
        )
        .await;
    assert!(still_locked.is_err());

    let _ = header::SET_COOKIE;
}

#[tokio::test]
async fn start_up_token_in_a_url_never_signs_in_only_the_login_exchange_does() {
    let (addr, _state, _dir) = spawn_test_server().await;
    let origin = format!("http://127.0.0.1:{}", addr.port());

    let (status, _, _) = http_json(addr, "GET", "/api/auth/me?token=boot-token-123", None, Some(&origin), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the start-up token in a query string is ignored");

    let mut ws_req = format!("ws://{addr}/ws?token=boot-token-123").into_client_request().unwrap();
    ws_req.headers_mut().insert("Origin", origin.parse().unwrap());
    let err = tokio_tungstenite::connect_async(ws_req).await.unwrap_err();
    assert!(err.to_string().contains("401"), "a WebSocket URL token is ignored: {err}");

    let (status, cookie, _) = http_json(addr, "POST", "/api/login", None, Some(&origin), Some(json!({ "token": "boot-token-123" }))).await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.set_cookie.expect("login sets the device cookie");
    let (status, _, me) = http_json(addr, "GET", "/api/auth/me", Some(&cookie), Some(&origin), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["role"], "owner");
    let _ws = connect_ws(addr, &cookie, &origin).await;
}
