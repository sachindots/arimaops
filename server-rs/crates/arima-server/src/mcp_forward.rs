// SPDX-License-Identifier: AGPL-3.0-or-later

//! A project's tool servers, reached through HQ. An agent calls `/api/projects/{id}/mcp/{server}` with its own HQ
//! token; HQ checks the server is ticked on that agent's seat, attaches the server's key from the vault, and passes
//! the MCP request and its reply (JSON or an event stream) through unchanged. Upstream keys never enter containers.

use std::time::Duration;

use arima_auth::{record_audit, redact_json_value, AuditWrite};
use arima_core::{ServerRole, ToolServerTransport};
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::Value;

use crate::integrations::{guarded_client, mcp_secret_id, record_forward, tool_servers};
use crate::mcp::McpCaller;
use crate::routes::{agent_caller, ApiError};
use crate::state::{AppState, PeerIp};

pub const MAX_REQUEST_BYTES: usize = 1 << 20;
/// A forwarded call, a streamed reply included, ends after this long; an MCP client reopens a dropped stream.
const MAX_CALL: Duration = Duration::from_secs(300);
const LOOKUP: Duration = Duration::from_secs(10);
const PASS_UP: [&str; 5] = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const PASS_DOWN: [&str; 3] = ["content-type", "mcp-session-id", "mcp-protocol-version"];

pub async fn forward(
    State(state): State<AppState>,
    Path((project_id, server)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
    body: Bytes,
) -> Result<Response, ApiError> {
    let caller = agent_caller(&state, &headers, peer_ip, Some(&project_id))?;
    let calls = tool_calls(&body);
    let (url, key) = match target(&state, &caller, &server) {
        Ok(t) => t,
        Err(e) => {
            audit(&state, &caller, &server, &calls, false);
            return Err(e);
        }
    };
    let sent = async {
        let (url, client) = tokio::time::timeout(LOOKUP, guarded_client(&state, &url, MAX_CALL)).await.map_err(|_| format!("Couldn't find {server} in time."))??;
        let mut req = client.request(method, url).body(body);
        for name in PASS_UP {
            if let Some(v) = headers.get(name) {
                req = req.header(name, v);
            }
        }
        if let Some(key) = key {
            req = req.bearer_auth(key);
        }
        req.send().await.map_err(|e| format!("Couldn't reach {server}: {}", e.without_url()))
    }
    .await;
    let resp = match sent {
        Ok(r) => r,
        Err(e) => {
            record_forward(&state, &caller.project_id, &server, Err(e.clone()));
            audit(&state, &caller, &server, &calls, false);
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, e));
        }
    };
    let status = resp.status();
    // 404 (an expired session) and 405 (no event stream offered) are ordinary protocol answers, not a broken server.
    let broken = status.is_server_error() || matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN);
    record_forward(&state, &caller.project_id, &server, if broken { Err(format!("{server} answered {status}.")) } else { Ok(()) });
    audit(&state, &caller, &server, &calls, status.is_success());
    let mut out = Response::builder().status(status);
    for name in PASS_DOWN {
        if let Some(v) = resp.headers().get(name) {
            out = out.header(name, v);
        }
    }
    out.body(Body::from_stream(resp.bytes_stream())).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// The server's URL and key, when the server is registered in this project and ticked on the caller's seat.
fn target(state: &AppState, caller: &McpCaller, server: &str) -> Result<(String, Option<String>), ApiError> {
    let ticked = crate::team::load(state, &caller.project_id).is_some_and(|m| {
        m.team.iter().any(|a| a["id"] == caller.agent_id.as_str() && a["mcp"].as_array().is_some_and(|names| names.iter().any(|n| n == server)))
    });
    let entry = tool_servers(state, &caller.project_id).into_iter().find(|s| s.name == server).filter(|_| ticked);
    let Some(entry) = entry else {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("This agent isn't given the tool server \"{server}\".")));
    };
    if let Some(why) = &entry.blocked {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("The tool server \"{server}\" is blocked until the owner approves it in the Inbox: {why}")));
    }
    let key = if entry.has_key {
        let key = crate::runtime::vault_secret(state, &mcp_secret_id(&caller.project_id, server)).ok().flatten();
        Some(key.ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, format!("HQ couldn't read the key for \"{server}\".")))?)
    } else {
        None
    };
    let ToolServerTransport::Http { url } = entry.transport;
    Ok((url, key))
}

/// The `tools/call` requests in a JSON-RPC message or batch, as `(tool, arguments)`.
fn tool_calls(body: &[u8]) -> Vec<(String, Value)> {
    let msgs = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Array(batch)) => batch,
        Ok(one) => vec![one],
        Err(_) => Vec::new(),
    };
    msgs.into_iter().filter(|m| m["method"] == "tools/call").map(|m| (m["params"]["name"].as_str().unwrap_or("").chars().take(80).collect(), m["params"]["arguments"].clone())).collect()
}

fn audit(state: &AppState, caller: &McpCaller, server: &str, calls: &[(String, Value)], allowed: bool) {
    for (tool, args) in calls {
        let _ = record_audit(
            &state.inner.db,
            AuditWrite {
                actor_user_id: None,
                actor_name: &caller.agent_id,
                actor_role: Some(ServerRole::Operator),
                project_id: Some(&caller.project_id),
                action: &format!("mcp.{server}.{tool}"),
                target: Some(&caller.project_id),
                summary: format!("args={}", redact_json_value(args)),
                remote: caller.remote,
                allowed,
            },
        );
    }
}
