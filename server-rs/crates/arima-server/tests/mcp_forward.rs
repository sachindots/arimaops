// SPDX-License-Identifier: AGPL-3.0-or-later

//! A project's tool servers reached through HQ: HQ attaches the vault key upstream, refuses servers not ticked on the
//! caller's seat and tokens from elsewhere, keeps the private-network guard, and passes replies through as sent.

use std::sync::{Arc, Mutex};

use arima_auth::VaultKey;
use arima_db::Db;
use arima_server::integrations as int;
use arima_server::{router_with_state, team, AppState, ServerConfig};
use axum::body::Body;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, HOST};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::response::IntoResponse;
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// An upstream tool server that records each request's Authorization and session headers. `tools/call` answers
/// as an event stream, anything else as JSON, `fail` with 503.
async fn upstream() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let log = seen.clone();
    let app = Router::new().route(
        "/mcp",
        axum::routing::post(move |headers: HeaderMap, body: String| {
            let log = log.clone();
            async move {
                let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
                log.lock().unwrap().push((h("authorization"), h("mcp-session-id")));
                let req: Value = serde_json::from_str(&body).unwrap();
                match req["method"].as_str().unwrap() {
                    "fail" => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                    "tools/call" => ([("content-type", "text/event-stream"), ("mcp-session-id", "sess-up")], "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]}}\n\n").into_response(),
                    _ => ([("mcp-session-id", "sess-up")], axum::Json(json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } }))).into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

async fn call(app: &Router, path: &str, token: &str, body: Value) -> (StatusCode, HeaderMap, String) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(HOST, "127.0.0.1:7420")
        .header(CONTENT_TYPE, "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", "sess-agent")
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (resp.status(), resp.headers().clone());
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, headers, String::from_utf8_lossy(&bytes).into_owned())
}

fn rpc(method: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": { "name": "search", "arguments": { "q": "x", "token": "hidden" } } })
}

fn check(state: &AppState, pid: &str, name: &str) -> Option<arima_core::ToolServerCheck> {
    int::tool_servers(state, pid).into_iter().find(|s| s.name == name).and_then(|s| s.check)
}

#[tokio::test]
async fn forwarding_attaches_the_key_and_refuses_what_the_agent_was_not_given() {
    let state = AppState::new(Db::open_in_memory().unwrap(), VaultKey::from_bytes([9u8; 32]), ServerConfig { allow_private_connections: true, ..ServerConfig::default() });
    state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
    let pid = state.default_project().unwrap().0;
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    let ids: Vec<String> = team::load(&state, &pid).unwrap().team.iter().map(|a| a["id"].as_str().unwrap().to_owned()).collect();
    let (url, seen) = upstream().await;
    int::add_mcp(&state, &pid, &[json!({ "name": "docs", "url": url, "apiKey": "docs-key-1" })]).unwrap();
    int::add_mcp(&state, &pid, &[json!({ "name": "other", "url": url })]).unwrap();
    int::set_agent_mcp(&state, &pid, &[json!(ids[0]), json!(["docs"])]).unwrap();
    let app = router_with_state(state.clone());
    let token = state.inner.mcp.issue_agent_token(&pid, &ids[0]);
    let docs = format!("/api/projects/{pid}/mcp/docs");

    let (st, headers, body) = call(&app, &docs, &token, rpc("tools/list")).await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["result"]["tools"], json!([]));
    assert_eq!(headers["mcp-session-id"], "sess-up", "the upstream session id comes back to the agent");
    assert_eq!(seen.lock().unwrap().last().unwrap(), &("Bearer docs-key-1".to_owned(), "sess-agent".to_owned()), "HQ sends the vault key, not the agent's token, and the agent's session id");

    let (st, headers, body) = call(&app, &docs, &token, rpc("tools/call")).await;
    assert_eq!((st, headers[CONTENT_TYPE].to_str().unwrap()), (StatusCode::OK, "text/event-stream"));
    assert_eq!(body, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]}}\n\n", "the event stream passes through unchanged");
    let audited: (String, String, bool) = state
        .inner
        .db
        .read(|c| c.query_row("SELECT actor_name, summary, allowed FROM audit_log WHERE action = 'mcp.docs.search'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(arima_db::DbError::from))
        .unwrap();
    assert_eq!((audited.0.as_str(), audited.2), (ids[0].as_str(), true));
    assert!(audited.1.contains("\"q\":\"x\"") && !audited.1.contains("hidden"), "arguments are audited, redacted: {}", audited.1);

    let calls = seen.lock().unwrap().len();
    let (st, _, _) = call(&app, &format!("/api/projects/{pid}/mcp/other"), &token, rpc("tools/list")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "a server not ticked on this seat is refused");
    let (st, _, _) = call(&app, &docs, &state.inner.mcp.issue_agent_token(&pid, &ids[1]), rpc("tools/list")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "another agent's token doesn't carry this seat's servers");
    state
        .inner
        .db
        .transaction(|c| c.execute("INSERT INTO projects (id, slug, name, root_path, created_at, updated_at) VALUES ('proj-elsewhere', 'elsewhere', 'Elsewhere', '/w/e', 1, 1)", []).map_err(arima_db::DbError::from))
        .unwrap();
    let (st, _, _) = call(&app, &docs, &state.inner.mcp.issue_agent_token("proj-elsewhere", &ids[0]), rpc("tools/list")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "a token from another project is refused");
    let (st, _, _) = call(&app, &docs, "mcp_not-a-token", rpc("tools/list")).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(seen.lock().unwrap().len(), calls, "nothing refused reached the upstream");

    let (st, _, _) = call(&app, &docs, &token, rpc("fail")).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE, "the agent sees the upstream's error");
    let failed = check(&state, &pid, "docs").unwrap();
    assert!(!failed.ok && failed.error.as_deref().unwrap().contains("503"), "{failed:?}");
    call(&app, &docs, &token, rpc("tools/list")).await;
    assert!(check(&state, &pid, "docs").unwrap().ok, "a working call clears the failure");

    int::update_tool_servers(&state, &pid, |servers| {
        servers[0].blocked = Some("its tool list changed".into());
        Ok(())
    })
    .unwrap();
    let calls = seen.lock().unwrap().len();
    let (st, _, body) = call(&app, &docs, &token, rpc("tools/list")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "a blocked server isn't forwarded, even to an agent started before the block");
    assert!(body.contains("Inbox"), "{body}");
    assert_eq!(seen.lock().unwrap().len(), calls);
    int::update_tool_servers(&state, &pid, |servers| {
        servers[0].blocked = None;
        Ok(())
    })
    .unwrap();

    // A server whose address is a cloud metadata address, which the guard refuses with or without the opt-in.
    let mut servers = int::tool_servers(&state, &pid);
    servers[1].transport = arima_core::ToolServerTransport::Http { url: "http://169.254.169.254/mcp".into() };
    state
        .inner
        .db
        .transaction(|c| c.execute("UPDATE server_settings SET value_json = ?1 WHERE key = ?2", rusqlite::params![json!(servers).to_string(), format!("mcpServers:{pid}")]).map_err(arima_db::DbError::from))
        .unwrap();
    int::set_agent_mcp(&state, &pid, &[json!(ids[0]), json!(["docs", "other"])]).unwrap();
    let (st, _, body) = call(&app, &format!("/api/projects/{pid}/mcp/other"), &token, rpc("tools/list")).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY);
    assert!(body.contains("private network"), "{body}");
    assert!(!check(&state, &pid, "other").unwrap().ok, "the refusal shows in the server's status");
}
