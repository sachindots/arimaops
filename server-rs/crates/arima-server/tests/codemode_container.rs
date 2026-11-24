// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tools as code end to end: a throwaway HQ (this process, a free port, an in-memory database), a local upstream
//! tool server, and the codemode server running in a container from the agent image. Skips itself without Docker or
//! the image (built from docker/agent.v2.Dockerfile):
//!   ARIMA_CODEMODE_IMAGE=<tag> cargo test -p arima-server --test codemode_container -- --nocapture

use std::sync::{Arc, Mutex};

use arima_auth::VaultKey;
use arima_db::Db;
use arima_server::integrations as int;
use arima_server::{codemode, router_with_state, team, AppState, ServerConfig};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Router;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A minimal MCP server over plain JSON. It records each request's Authorization header; `block_me` blocks it in HQ.
async fn upstream(state: AppState, pid: String) -> (String, Arc<Mutex<Vec<String>>>) {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    let tools = json!([
        { "name": "search", "description": "Searches the docs.", "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] } },
        { "name": "block_me", "description": "Test hook.", "inputSchema": { "type": "object", "properties": {} } }
    ]);
    let app = Router::new().route(
        "/mcp",
        axum::routing::post(move |headers: HeaderMap, body: String| {
            let (log, tools, state, pid) = (log.clone(), tools.clone(), state.clone(), pid.clone());
            async move {
                log.lock().unwrap().push(headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned());
                let req: Value = serde_json::from_str(&body).unwrap();
                let result = match req["method"].as_str().unwrap_or("") {
                    "initialize" => json!({ "protocolVersion": req["params"]["protocolVersion"], "capabilities": { "tools": {} }, "serverInfo": { "name": "docs", "version": "1" } }),
                    "tools/list" => json!({ "tools": tools }),
                    "tools/call" if req["params"]["name"] == "block_me" => {
                        int::update_tool_servers(&state, &pid, |servers| {
                            servers.iter_mut().find(|s| s.name == "web-docs").unwrap().blocked = Some("its tool list changed".into());
                            Ok(())
                        })
                        .unwrap();
                        json!({ "content": [{ "type": "text", "text": "blocked" }] })
                    }
                    "tools/call" => json!({ "content": [{ "type": "text", "text": format!("page for {}", req["params"]["arguments"]["q"].as_str().unwrap_or("")) }] }),
                    _ => return axum::http::StatusCode::ACCEPTED.into_response(),
                };
                axum::Json(json!({ "jsonrpc": "2.0", "id": req["id"], "result": result })).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

/// Removes the container however the test ends: killing `docker run` leaves the container running.
struct Container(String);

impl Drop for Container {
    fn drop(&mut self) {
        let _ = std::process::Command::new("docker").args(["rm", "-f", &self.0]).output();
    }
}

fn audit(state: &AppState, action: &str) -> Vec<(String, String, bool)> {
    state
        .inner
        .db
        .read(|c| {
            let mut st = c.prepare("SELECT actor_name, summary, allowed FROM audit_log WHERE action = ?1 ORDER BY rowid").map_err(arima_db::DbError::from)?;
            let rows = st.query_map([action], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(arima_db::DbError::from)?.collect::<Result<Vec<_>, _>>().map_err(arima_db::DbError::from)?;
            Ok::<_, arima_db::DbError>(rows)
        })
        .unwrap()
}

async fn rpc(hq: &str, path: &str, token: &str, body: Value) -> Value {
    let resp = reqwest::Client::new().post(format!("{hq}{path}")).bearer_auth(token).header("accept", "application/json, text/event-stream").json(&body).send().await.unwrap();
    assert!(resp.status().is_success(), "{path}: {}", resp.status());
    resp.json().await.unwrap()
}

fn docker(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("docker").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Docker and the agent image: ARIMA_CODEMODE_IMAGE=<image> cargo test --test codemode_container -- --ignored"]
async fn codemode_in_the_agent_container_calls_through_hq_with_its_keys_audit_and_switch() {
    let image = std::env::var("ARIMA_CODEMODE_IMAGE").expect("ARIMA_CODEMODE_IMAGE names the agent image to run");
    assert!(docker(&["image", "inspect", &image]).is_some(), "no Docker, or no image {image}");
    let state = AppState::new(Db::open_in_memory().unwrap(), VaultKey::from_bytes([9u8; 32]), ServerConfig { allow_private_connections: true, ..ServerConfig::default() });
    state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
    let pid = state.default_project().unwrap().0;
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    let agent = team::load(&state, &pid).unwrap().team[0]["id"].as_str().unwrap().to_owned();
    let (url, seen) = upstream(state.clone(), pid.clone()).await;
    int::add_mcp(&state, &pid, &[json!({ "name": "web-docs", "url": url, "apiKey": "docs-key-1" })]).unwrap();
    int::set_agent_mcp(&state, &pid, &[json!(agent), json!(["web-docs"])]).unwrap();
    int::refresh_mcp(&state, &pid, &[]).await.unwrap();
    codemode::set_switch(&state, &pid, &[json!(true)]).unwrap();
    let token = state.inner.mcp.issue_agent_token(&pid, &agent);

    // The container shares the host network (this host's firewall drops bridge traffic to host ports) and, like HQ's
    // agents, runs as an unprivileged user that owns nothing in the image.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 7420);
    let app = router_with_state(state.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let hq = format!("http://127.0.0.1:{port}");

    // Direct calls first, for the audit rows codemode's calls must match.
    rpc(&hq, &format!("/api/projects/{pid}/mcp"), &token, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "list_tasks", "arguments": {} } })).await;
    rpc(&hq, &format!("/api/projects/{pid}/mcp/web-docs"), &token, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "search", "arguments": { "q": "x", "token": "hidden" } } })).await;

    let driver = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/codemode-driver.mjs");
    let name = format!("arima-codemode-e2e-{port}");
    let _cleanup = Container(name.clone());
    let mut child = tokio::process::Command::new("docker")
        .args(["run", "--rm", "-i", "--name", &name, "--network", "host", "--user", "4321:4321", "-e", "ARIMA_MCP_TOKEN", "-v"])
        .arg(format!("{driver}:/test/driver.mjs:ro"))
        .args([&image, "node", "/test/driver.mjs", &format!("http://127.0.0.1:{port}/api/projects/{pid}")])
        .env("ARIMA_MCP_TOKEN", &token)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let out: Value = serde_json::from_str(&lines.next_line().await.unwrap().expect("the driver's results")).unwrap();
    println!("{}", serde_json::to_string_pretty(&out).unwrap());

    let tools = out["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1, "one tool: {tools:?}");
    let desc = tools[0]["description"].as_str().unwrap();
    assert!(desc.contains("declare namespace codemode.web_docs") && desc.contains("function list_tasks(") && desc.contains("Limits per run: 30 s, 128 MB"), "{desc}");

    let chain = &out["chain"];
    assert_eq!(chain["result"]["page"], "page for x", "{chain}");
    assert_eq!(chain["logs"], json!(["tasks is a list: true"]), "{chain}");
    assert!(out["found"]["result"].as_array().unwrap().contains(&json!("codemode.web_docs.search")), "{}", out["found"]);
    assert!(out["loop"]["error"].as_str().unwrap().contains("at most 30 s"), "{}", out["loop"]);
    assert!((30_000..34_000).contains(&out["loop"]["ms"].as_u64().unwrap()), "killed at the 30 s deadline: {}", out["loop"]);
    assert_eq!(out["after"]["result"], "ok");
    assert!(out["after"]["ms"].as_u64().unwrap() < 2000, "the next run starts at once: {}", out["after"]);
    assert!(out["blocked"]["result"].as_str().unwrap().starts_with("The tool server \"web-docs\" is blocked until the owner approves"), "HQ refuses a blocked server, in its own words: {}", out["blocked"]);

    assert!(out["heap"]["error"].as_str().unwrap().contains("more than 128 MB"), "{}", out["heap"]);
    for (what, err) in [("fetch", "fetch is not defined"), ("write", "require is not defined"), ("spawn", "require is not defined")] {
        assert!(out["sandbox"]["result"][what].as_str().unwrap().contains(err), "{what} fails in a run: {}", out["sandbox"]);
    }
    assert_eq!(out["child"]["env"], "{}", "the run's process has no environment, so no token");
    for what in ["write", "spawn"] {
        assert!(out["child"][what].as_str().unwrap().contains("ERR_ACCESS_DENIED"), "{what} is denied to the run's process: {}", out["child"]);
    }

    // The vault key reached the upstream but appears nowhere in the container: not in its config, any file, or any
    // process's environment (the CLI's, the codemode server's, a run's).
    let env = docker(&["inspect", "--format", "{{json .Config.Env}}", &name]).expect("the container is running");
    assert!(env.contains("ARIMA_MCP_TOKEN") && !env.contains("docs-key-1"), "{env}");
    let scan = "grep -rlsI docs-key-1 / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev; grep -ls docs-key-1 /proc/[0-9]*/environ; echo scanned";
    let found = docker(&["exec", "-u", "0", &name, "sh", "-c", scan]).expect("the scan runs");
    assert_eq!(found.trim(), "scanned", "the key is in the container: {found}");

    let upstream_auth = seen.lock().unwrap().clone();
    assert!(!upstream_auth.is_empty() && upstream_auth.iter().all(|a| a == "Bearer docs-key-1"), "every upstream request carried the vault key, never the agent token: {upstream_auth:?}");

    let (hq_rows, docs_rows) = (audit(&state, "mcp.list_tasks"), audit(&state, "mcp.web-docs.search"));
    assert_eq!(hq_rows.len(), 2, "{hq_rows:?}");
    assert_eq!(hq_rows[0], hq_rows[1], "codemode's HQ call is audited like the direct one");
    assert_eq!(docs_rows.len(), 3, "{docs_rows:?}");
    assert_eq!(docs_rows[0], docs_rows[1], "codemode's forwarded call is audited like the direct one, key redacted the same");
    assert!(docs_rows[0].2 && !docs_rows[0].1.contains("hidden") && docs_rows[0].0 == agent, "{docs_rows:?}");
    assert!(!docs_rows[2].2, "the blocked call is audited as refused: {docs_rows:?}");

    codemode::set_switch(&state, &pid, &[json!(false)]).unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"go\n").await.unwrap();
    let off: Value = serde_json::from_str(&lines.next_line().await.unwrap().expect("the driver's last call")).unwrap();
    assert!(off["off"]["error"].as_str().unwrap().contains("Tools as code is off"), "a runner started before the switch went off is refused: {off}");
    assert!(child.wait().await.unwrap().success());
}
