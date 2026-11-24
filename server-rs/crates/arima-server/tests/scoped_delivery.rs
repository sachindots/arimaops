// SPDX-License-Identifier: AGPL-3.0-or-later

//! Project-scoped delivery: a change in one project must not reach sockets showing another, and viewers get no terminal bytes.

use std::net::SocketAddr;
use std::time::Duration;

use arima_auth::VaultKey;
use arima_db::Db;
use arima_server::{router_with_state, AppState, ServerConfig};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMsg;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn spawn() -> (SocketAddr, AppState, TempDir) {
    let dir = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = ServerConfig {
        port: addr.port(),
        preview_port: addr.port() + 1,
        bootstrap_token: "scoped-boot-token".into(),
        local_origins: vec![format!("http://127.0.0.1:{}", addr.port())],
        allowed_origins: vec![],
        preview_origin: None,
        trust_proxy: false,
        same_origin: false,
        data_root: Some(dir.path().to_path_buf()),
        allow_private_connections: false,
    };
    let state = AppState::new(Db::open(&dir.path().join("arima.db")).unwrap(), VaultKey::from_bytes([9u8; 32]), cfg);
    state.ensure_default_project("Alpha", "alpha", "/tmp/alpha").unwrap();
    let app = router_with_state(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, state, dir)
}

async fn post(addr: SocketAddr, path: &str, cookie: Option<&str>, body: Value) -> (u16, Option<String>) {
    let payload = body.to_string();
    let origin = format!("http://127.0.0.1:{}", addr.port());
    let mut req = format!("POST {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", payload.len());
    if let Some(c) = cookie {
        req.push_str(&format!("Cookie: hq_sid={c}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(&payload);
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let code = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let cookie = text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("set-cookie").then(|| v.trim().split(';').next()?.strip_prefix("hq_sid=").map(str::to_owned))?
    });
    (code, cookie)
}

async fn connect(addr: SocketAddr, cookie: &str, project: &str) -> (Ws, Value) {
    let mut req = format!("ws://{addr}/ws?project={project}").into_client_request().unwrap();
    req.headers_mut().insert("Cookie", format!("hq_sid={cookie}").parse().unwrap());
    req.headers_mut().insert("Origin", format!("http://127.0.0.1:{}", addr.port()).parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    let first: Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(first["type"], "snapshot");
    (ws, first)
}

/// Every text frame that arrives within `wait`.
async fn drain(ws: &mut Ws, wait: Duration) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(Some(Ok(frame))) = tokio::time::timeout(wait, ws.next()).await {
        if let WsMsg::Text(t) = frame {
            out.push(serde_json::from_str(&t).unwrap());
        }
    }
    out
}

#[tokio::test]
async fn snapshots_and_terminal_bytes_stay_in_their_project_and_skip_viewers() {
    let (addr, state, _dir) = spawn().await;
    let (_, owner) = post(addr, "/api/login", None, json!({ "token": "scoped-boot-token" })).await;
    let owner = owner.unwrap();
    let (st, _) = post(addr, "/api/projects", Some(&owner), json!({ "name": "Beta", "slug": "beta" })).await;
    assert_eq!(st, 200);
    for (name, pw, role) in [("Owner2", "owner-password-1234", "owner"), ("Viewer2", "viewer-password-123", "viewer")] {
        assert_eq!(post(addr, "/api/users", Some(&owner), json!({ "name": name, "password": pw, "role": role })).await.0, 200);
    }
    let viewer = post(addr, "/api/auth/login", None, json!({ "name": "Viewer2", "password": "viewer-password-123" })).await.1.unwrap();

    let alpha = state.default_project().unwrap().0;
    let (mut on_alpha, _) = connect(addr, &owner, &alpha).await;
    let (mut on_beta, _) = connect(addr, &owner, "proj-beta").await;
    let (mut viewer_on_alpha, _) = connect(addr, &viewer, &alpha).await;

    // A team created in Alpha reaches Alpha's sockets only.
    arima_server::team::complete_welcome(&state, &alpha, &[json!({ "projectName": "Alpha", "templateId": "dev", "reviewTool": "human", "reviewEnabled": false })]).unwrap();
    let alpha_frames = drain(&mut on_alpha, Duration::from_millis(400)).await;
    assert!(alpha_frames.iter().any(|f| f["type"] == "snapshot" && f["snapshot"]["config"]["project"]["id"] == alpha.as_str()));
    let beta_frames = drain(&mut on_beta, Duration::from_millis(400)).await;
    assert!(beta_frames.iter().all(|f| f["type"] != "snapshot"), "Beta's socket must not receive Alpha's snapshot: {beta_frames:?}");

    // Live terminal bytes: operators of the project get them, viewers and other projects do not.
    state.inner.ws_hub.broadcast_project_streams(&alpha, &json!({ "type": "terminal.output", "projectId": alpha, "agentId": "cipher", "data": "hi" }).to_string());
    assert!(drain(&mut on_alpha, Duration::from_millis(300)).await.iter().any(|f| f["type"] == "terminal.output"));
    assert!(drain(&mut viewer_on_alpha, Duration::from_millis(300)).await.iter().all(|f| f["type"] != "terminal.output"), "viewers get no terminal bytes");
    assert!(drain(&mut on_beta, Duration::from_millis(300)).await.iter().all(|f| f["type"] != "terminal.output"));
    let _ = on_alpha.close(None).await;
}

#[tokio::test]
async fn chat_messages_are_stored_shown_and_wait_for_a_stopped_agent() {
    let (addr, state, _dir) = spawn().await;
    let owner = post(addr, "/api/login", None, json!({ "token": "scoped-boot-token" })).await.1.unwrap();
    let project = state.default_project().unwrap().0;
    arima_server::team::complete_welcome(&state, &project, &[json!({ "projectName": "Alpha", "templateId": "dev", "reviewTool": "human", "reviewEnabled": false })]).unwrap();
    let (mut ws, first) = connect(addr, &owner, &project).await;
    assert_eq!(first["snapshot"]["messages"], json!([]));

    arima_server::delivery::send_from_owner(&state, &project, "lead", "  ship the login page  ").await.unwrap();
    let frames = drain(&mut ws, Duration::from_millis(300)).await;
    let event = frames.iter().find(|f| f["type"] == "message").expect("a message event reaches the project's sockets");
    assert_eq!(event["message"]["toId"], "cipher", "\"lead\" resolves to the lead's agent id");
    assert_eq!(event["message"]["text"], "ship the login page");
    assert_eq!(event["message"]["delivered"], "queued", "the agent is stopped, so the message waits");
    assert_eq!(state.inner.supervisor.poll_next_outbox(&project, "cipher", 0, 0).unwrap().map(|m| m.kind.as_str()), Some("text"));

    let (_ws2, again) = connect(addr, &owner, &project).await;
    assert_eq!(again["snapshot"]["messages"][0]["text"], "ship the login page", "history survives a reconnect");
    assert!(arima_server::delivery::send_from_owner(&state, &project, "nobody", "hi").await.is_err());
    assert!(arima_server::delivery::send_from_owner(&state, &project, "lead", "   ").await.is_err());
    assert_eq!(arima_server::delivery::deliver_pending(&state, &project, "cipher").await, 0, "nothing is typed into a stopped agent");
}
