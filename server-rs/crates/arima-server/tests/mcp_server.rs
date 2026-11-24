// SPDX-License-Identifier: AGPL-3.0-or-later

//! HQ's own tool server: protocol shape, bearer-only auth, token persistence across a restart, and role prompts that
//! name only tools the server runs.

use arima_auth::{SessionMeta, VaultKey, SESSION_COOKIE_NAME};
use arima_core::{DecisionPayload, ServerRole};
use arima_db::Db;
use arima_server::mcp::{unknown_tool_names, McpRegistry, MCP_PROTOCOL_VERSION, TOOLS};
use arima_server::{router_with_state, AppState, ServerConfig};
use axum::body::Body;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, COOKIE, HOST, ORIGIN};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

fn state_with(db: Db) -> (AppState, String) {
    let state = AppState::new(db, VaultKey::ephemeral(), ServerConfig::default());
    state.ensure_default_project("Core", "core", "/tmp/core").unwrap();
    let (pid, _, _, _) = state.default_project().unwrap();
    (state, pid)
}

async fn post(app: &Router, path: &str, headers: &[(&str, &str)], body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder().method(Method::POST).uri(path).header(HOST, "127.0.0.1:7420").header(CONTENT_TYPE, "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = app.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn rpc(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
}

#[tokio::test]
async fn protocol_shape_and_bearer_only_auth() {
    let (state, pid) = state_with(Db::open_in_memory().unwrap());
    let app = router_with_state(state.clone());
    let path = format!("/api/projects/{pid}/mcp");
    let auth = format!("Bearer {}", state.inner.mcp.issue_agent_token(&pid, "lead"));
    let h = [(AUTHORIZATION.as_str(), auth.as_str())];

    let (st, init) = post(&app, &path, &h, rpc("initialize", json!({ "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(init["result"]["protocolVersion"], MCP_PROTOCOL_VERSION);
    assert!(init["result"]["capabilities"]["tools"].is_object());

    let (st, body) = post(&app, &path, &h, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!((st, body), (StatusCode::ACCEPTED, Value::Null), "a notification gets 202 and no body");

    let (_, list) = post(&app, &path, &h, rpc("tools/list", json!({}))).await;
    let listed: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(listed, TOOLS.iter().map(|t| t.name).collect::<Vec<_>>());
    for tool in list["result"]["tools"].as_array().unwrap() {
        let schema = &tool["inputSchema"];
        assert_eq!(schema["type"], "object", "{} has an object inputSchema", tool["name"]);
        let props = schema["properties"].as_object().unwrap_or_else(|| panic!("{} lists its properties", tool["name"]));
        for req in schema["required"].as_array().into_iter().flatten() {
            assert!(props.contains_key(req.as_str().unwrap()), "{} requires a property it doesn't describe: {req}", tool["name"]);
        }
    }

    let (_, call) = post(&app, &path, &h, rpc("tools/call", json!({ "name": "create_board", "arguments": { "title": "Launch" } }))).await;
    let board = call["result"]["structuredContent"]["boardId"].as_str().unwrap().to_owned();
    let text: Value = serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["boardId"], board.as_str(), "text content mirrors structuredContent");
    let (_, spec) = post(&app, &path, &h, rpc("tools/call", json!({ "name": "write_spec", "arguments": { "boardId": board, "specMarkdown": "S1. Ship it" } }))).await;
    assert_eq!(spec["result"]["structuredContent"]["specVersion"], 1);

    let (_, unknown) = post(&app, &path, &h, rpc("tools/call", json!({ "name": "submit_plan", "arguments": {} }))).await;
    assert_eq!(unknown["error"]["code"], -32602);
    let (_, bad_method) = post(&app, &path, &h, rpc("ask_user", json!({}))).await;
    assert_eq!(bad_method["error"]["code"], -32601, "tool names are not JSON-RPC methods");

    let (st, _) = post(&app, &path, &[h[0], ("mcp-protocol-version", "1999-01-01")], rpc("ping", json!({}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = post(&app, &path, &[h[0], (ORIGIN.as_str(), "https://evil.example")], rpc("ping", json!({}))).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _) = post(&app, "/api/projects/someone-else/mcp", &h, rpc("ping", json!({}))).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "a token works only on its own project");

    let owner = state.inner.auth.create_user("OwnerMcp".into(), "OwnerPass!2026".into(), ServerRole::Owner).await.unwrap();
    let meta = SessionMeta { client_ip: "127.0.0.1".into(), origin: Some("http://127.0.0.1:7420".into()), label: "t".into(), remote: false };
    let session = state.inner.auth.login_with_passkey(&owner.user.id, meta).unwrap().raw_token;
    let cookie = format!("{SESSION_COOKIE_NAME}={session}");
    let (st, _) = post(&app, &path, &[(COOKIE.as_str(), cookie.as_str()), (ORIGIN.as_str(), "http://127.0.0.1:7420")], rpc("tools/list", json!({}))).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "a browser session can't act as an agent");
}

#[tokio::test]
async fn memory_and_message_tools_work_on_the_agents_project() {
    let (state, pid) = state_with(Db::open_in_memory().unwrap());
    let app = router_with_state(state.clone());
    let path = format!("/api/projects/{pid}/mcp");
    let auth = format!("Bearer {}", state.inner.mcp.issue_agent_token(&pid, "dev"));
    let call = |name: &str, args: Value| rpc("tools/call", json!({ "name": name, "arguments": args }));
    let h = [(AUTHORIZATION.as_str(), auth.as_str())];

    let (_, saved) = post(&app, &path, &h, call("remember", json!({ "type": "deadend", "text": "Retrying the payment webhook without idempotency keys double-charges", "about": ["src/pay.ts"], "taskId": "T-7" }))).await;
    let memory = &saved["result"]["structuredContent"]["memory"];
    assert_eq!((memory["memType"].as_str(), memory["certified"].as_bool()), (Some("DeadEnd"), Some(false)));

    let (_, found) = post(&app, &path, &h, call("recall", json!({ "query": "webhook idempotency" }))).await;
    assert_eq!(found["result"]["structuredContent"]["memories"][0]["id"], memory["id"]);
    let (_, by_task) = post(&app, &path, &h, call("related", json!({ "taskId": "T-7" }))).await;
    assert_eq!(by_task["result"]["structuredContent"]["memories"][0]["id"], memory["id"], "taskId is kept in about");
    let (_, none) = post(&app, &path, &h, call("related", json!({}))).await;
    assert_eq!(none["error"]["code"], -32602);

    let (_, sent) = post(&app, &path, &h, call("send_message", json!({ "to": "you", "text": "Plan for the week is ready." }))).await;
    assert_eq!(sent["result"]["structuredContent"]["ok"], true);
    let from: String = state.inner.db.read(|c| c.query_row("SELECT from_id FROM messages WHERE to_id = 'you'", [], |r| r.get(0)).map_err(arima_db::DbError::from)).unwrap();
    assert_eq!(from, "dev");
}

#[test]
fn tokens_survive_restart_and_are_revoked() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("arima.db");
    let (state, pid) = state_with(Db::open(&path).unwrap());
    let token = state.inner.mcp.issue_agent_token(&pid, "dev");
    let stale = state.inner.mcp.issue_agent_token(&pid, "lead");
    let fresh = state.inner.mcp.issue_agent_token(&pid, "lead");
    drop(state);

    let reopened = McpRegistry::new(Db::open(&path).unwrap());
    assert_eq!(reopened.verify_bearer_token(&token), Some((pid.clone(), "dev".into())));
    assert_eq!(reopened.verify_bearer_token(&stale), None, "reissuing replaces the old token");
    assert_eq!(reopened.verify_bearer_token(&fresh), Some((pid.clone(), "lead".into())));
    let stored: String = Db::open(&path).unwrap().read(|c| c.query_row("SELECT token_hash FROM mcp_tokens WHERE agent_id = 'dev'", [], |r| r.get(0)).map_err(arima_db::DbError::from)).unwrap();
    assert!(!stored.contains(&token) && stored.len() == 64, "only a SHA-256 digest is stored");

    reopened.revoke_agent_token(&pid, "dev");
    assert_eq!(reopened.verify_bearer_token(&token), None);
}

/// Snake-case words in role prompts and ritual prompts are tool names; each must be one HQ's tool server runs.
#[test]
fn role_prompts_name_only_dispatched_tools() {
    fn prompts<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a str>) {
        match v {
            Value::Object(m) => m.iter().for_each(|(k, v)| prompts(v, k, out)),
            Value::Array(a) => a.iter().for_each(|v| prompts(v, key, out)),
            Value::String(s) if key == "roleMd" || key == "prompt" => out.push(s),
            _ => {}
        }
    }
    assert_eq!(unknown_tool_names("then submit_plan, and `list_tasks` or snake_"), ["submit_plan"]);

    let data: Value = serde_json::from_str(include_str!("../assets/team-data.json")).unwrap();
    let mut texts = Vec::new();
    prompts(&data, "", &mut texts);
    assert!(texts.len() > 20, "found the role prompts");
    let unknown: Vec<&str> = texts.iter().flat_map(|t| unknown_tool_names(t)).collect();
    assert!(unknown.is_empty(), "role prompts name tools HQ doesn't run: {unknown:?}");
}

/// `ask_user` with `ui` files a form decision; a bad form names its path; the answer reaches the agent's outbox.
#[tokio::test]
async fn ask_user_with_a_form_files_it_and_delivers_the_answer() {
    let (state, pid) = state_with(Db::open_in_memory().unwrap());
    let app = router_with_state(state.clone());
    let path = format!("/api/projects/{pid}/mcp");
    let auth = format!("Bearer {}", state.inner.mcp.issue_agent_token(&pid, "lead"));
    let h = [(AUTHORIZATION.as_str(), auth.as_str())];
    let ask = |args: Value| rpc("tools/call", json!({ "name": "ask_user", "arguments": args }));
    let ui = json!({
        "components": [
            { "id": "root", "component": "Column", "children": ["name", "go"] },
            { "id": "name", "component": "TextField", "label": "Name", "value": { "@path": "/name" } },
            { "id": "go", "component": "ButtonRow", "buttons": [{ "label": "Send", "variant": "primary", "action": { "event": { "name": "send" } } }] }
        ],
        "data": { "name": "" }
    });

    let mut bad = ui.clone();
    bad["components"][1]["options"] = json!([]);
    let (_, rejected) = post(&app, &path, &h, ask(json!({ "title": "Name it", "ui": bad }))).await;
    assert_eq!(rejected["error"]["code"], -32602);
    assert_eq!(rejected["error"]["message"], "invalid ui:\n/ui/components/1/options: unknown property for TextField");
    let (_, both) = post(&app, &path, &h, ask(json!({ "title": "Name it", "ui": ui, "questions": [{ "prompt": "?" }] }))).await;
    assert_eq!(both["error"]["message"], "send `questions` or `ui`, not both");
    assert!(state.inner.decisions.list_by_project(&pid, None).unwrap().is_empty(), "a rejected form stores nothing");

    let (_, filed) = post(&app, &path, &h, ask(json!({ "title": "Name it", "ui": ui }))).await;
    let id = filed["result"]["structuredContent"]["decisionId"].as_str().unwrap().to_owned();
    let stored = state.inner.decisions.get(&id).unwrap().unwrap();
    let DecisionPayload::Form(form) = &stored.payload else { panic!("a form decision: {:?}", stored.payload) };
    assert_eq!((Value::Array(form.form.components.clone()), form.answer.clone()), (ui["components"].clone(), None));
    assert!(!stored.owner_only);

    let answer = json!({ "action": "send", "componentId": "go", "context": {}, "data": { "name": "Ada" } });
    arima_server::ws::exec_answer_decision(&state, &pid, &[json!(id), json!({ "status": "resolved", "formAnswer": answer })], ServerRole::Operator).unwrap();
    let out = state.inner.supervisor.poll_next_outbox(&pid, "lead", 0, 0).unwrap().expect("the answer is queued for the agent");
    let sent: Value = serde_json::from_str(&out.payload_json).unwrap();
    assert_eq!((sent["payload"]["kind"].as_str(), &sent["payload"]["answer"]), (Some("form"), &answer));

    let big = json!({ "action": "send", "componentId": "go", "context": {}, "data": { "x": "y".repeat(40_000) } });
    let err = arima_server::ws::exec_answer_decision(&state, &pid, &[json!(id), json!({ "formAnswer": big })], ServerRole::Owner).unwrap_err();
    assert_eq!(err, "form answer is larger than 32 KiB");
}
