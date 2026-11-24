// SPDX-License-Identifier: AGPL-3.0-or-later

//! The declarations endpoint the in-container `codemode` runner reads: refused while the project's switch is off,
//! and otherwise HQ's own tools plus each checked, unblocked server ticked on the caller's seat.

use arima_auth::VaultKey;
use arima_db::Db;
use arima_server::integrations as int;
use arima_server::{codemode, router_with_state, team, AppState, ServerConfig};
use axum::body::Body;
use axum::http::header::{AUTHORIZATION, HOST};
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

async fn upstream() -> String {
    let tools = json!([{ "name": "read-page", "description": "Reads one page.", "inputSchema": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } }]);
    let app = Router::new().route("/mcp", axum::routing::post(move || async move { axum::Json(json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": tools } })) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

async fn get(app: &Router, pid: &str, token: &str) -> (StatusCode, Value) {
    let req = Request::builder().uri(format!("/api/projects/{pid}/mcp-codemode/declarations")).header(HOST, "127.0.0.1:7420").header(AUTHORIZATION, format!("Bearer {token}")).body(Body::empty()).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 22).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn declarations_follow_the_switch_the_seat_and_the_last_check() {
    let state = AppState::new(Db::open_in_memory().unwrap(), VaultKey::from_bytes([9u8; 32]), ServerConfig { allow_private_connections: true, ..ServerConfig::default() });
    state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
    let pid = state.default_project().unwrap().0;
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    let ids: Vec<String> = team::load(&state, &pid).unwrap().team.iter().map(|a| a["id"].as_str().unwrap().to_owned()).collect();
    let url = upstream().await;
    int::add_mcp(&state, &pid, &[json!({ "name": "web-docs", "url": url })]).unwrap();
    int::add_mcp(&state, &pid, &[json!({ "name": "other", "url": url })]).unwrap();
    int::set_agent_mcp(&state, &pid, &[json!(ids[0]), json!(["web-docs"])]).unwrap();
    let app = router_with_state(state.clone());
    let token = state.inner.mcp.issue_agent_token(&pid, &ids[0]);

    let (st, body) = get(&app, &pid, &token).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "off by default: {body}");
    assert!(body.to_string().contains("Tools as code is off"), "{body}");

    codemode::set_switch(&state, &pid, &[json!(true)]).unwrap();
    let (st, body) = get(&app, &pid, &token).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["namespaces"].as_object().unwrap().keys().collect::<Vec<_>>(), ["arima"], "a ticked server never checked has no declarations yet");

    int::refresh_mcp(&state, &pid, &[]).await.unwrap();
    let (_, body) = get(&app, &pid, &token).await;
    assert_eq!(body["namespaces"]["web_docs"], json!({ "server": "web-docs", "tools": { "read_page": "read-page" } }));
    assert!(body["namespaces"].get("other").is_none(), "a server not ticked on this seat isn't declared");
    assert!(body["description"].as_str().unwrap().contains("declare namespace codemode.web_docs {\n  /** Reads one page. */\n  function read_page(args: { url: string }): Promise<any>;"), "{}", body["description"]);

    let (_, other_seat) = get(&app, &pid, &state.inner.mcp.issue_agent_token(&pid, &ids[1])).await;
    assert!(other_seat["namespaces"].get("web_docs").is_none(), "another seat gets only its own servers");

    int::update_tool_servers(&state, &pid, |servers| {
        servers.iter_mut().find(|s| s.name == "web-docs").unwrap().blocked = Some("its tool list changed".into());
        Ok(())
    })
    .unwrap();
    let (_, body) = get(&app, &pid, &token).await;
    assert!(body["namespaces"].get("web_docs").is_none(), "a blocked server isn't declared");

    let (st, _) = get(&app, &pid, "mcp_not-a-token").await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    codemode::set_switch(&state, &pid, &[json!(false)]).unwrap();
    let (st, _) = get(&app, &pid, &token).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "turning the switch off stops a running runner at its next call");
}
