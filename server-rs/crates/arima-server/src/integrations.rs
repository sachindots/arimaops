// SPDX-License-Identifier: AGPL-3.0-or-later

//! Integrations and sandbox settings over the WebSocket: MCP server registry, tool connections, per-agent
//! sandbox limits, lab mode, and template import and export.
//!
//! Commands that need a live terminal, sandbox or OAuth runtime (see [`unsupported`]) answer with a plain
//! error, so the UI shows why nothing happened instead of waiting.

use arima_db::DbError;
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use crate::state::AppState;

const TEMPLATE_FORMAT: &str = "arimaops-template";

fn text(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").trim().chars().take(max).collect()
}

fn broadcast(state: &AppState, project_id: &str) {
    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
}

fn db_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn setting(state: &AppState, key: &str) -> Option<Value> {
    let raw: Option<String> = state
        .inner
        .db
        .read(|conn| conn.query_row("SELECT value_json FROM server_settings WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(DbError::from))
        .ok()
        .flatten();
    serde_json::from_str(&raw?).ok()
}

fn save_setting(state: &AppState, key: &str, value: &Value) -> Result<(), String> {
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "INSERT INTO server_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                rusqlite::params![key, value.to_string(), Utc::now().timestamp_millis()],
            )?;
            Ok::<_, DbError>(())
        })
        .map_err(db_err)
}

fn drop_setting(state: &AppState, key: &str) -> Result<(), String> {
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute("DELETE FROM server_settings WHERE key = ?1", [key])?;
            Ok::<_, DbError>(())
        })
        .map_err(db_err)
}

/// Why a command has no effect in this build, in words for the person who clicked.
#[must_use]
pub fn unsupported(cmd: &str) -> Option<&'static str> {
    Some(match cmd {
        "openShell" | "openHostShell" | "closeShell" | "closeHostShell" => "Extra shells beside an agent's own terminal aren't available in this HQ build yet.",
        "forwardPort" | "unforwardPort" => "Port forwarding needs the sandbox runtime, which this HQ build doesn't have yet.",
        "openWorkspace" | "inspectWorkspace" => "Workspace inspection needs the agent runtime, which this HQ build doesn't have yet.",
        "recreateSandbox" | "runSetupFix" => "Sandbox setup checks and fixes need the sandbox runtime, which this HQ build doesn't have yet.",
        "authMcp" => "Signing in to an MCP server isn't available in this HQ build yet.",
        "finishGithubApp" => "Creating the GitHub App from HQ isn't available in this HQ build yet.",
        "answerApproval" => "Sandbox approvals come from the sandbox runtime, which this HQ build doesn't have yet.",
        "resolveAccess" => "Access requests come from the agent runtime, which this HQ build doesn't have yet.",
        "sendProposal" => "Sending a proposed action isn't available in this HQ build yet.",
        "addToSuite" => "Adding a task to the benchmark suite isn't available in this HQ build yet.",
        _ => return None,
    })
}

// ---------------------------------------------------------------- sandbox and lab mode

pub fn host_resources() -> (u32, f64) {
    let cpus = std::thread::available_parallelism().map_or(2, |n| u32::try_from(n.get()).unwrap_or(2));
    let mem_gb = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|m| m.lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()))
        .map_or(8.0, |kb| kb / 1024.0 / 1024.0);
    (cpus, mem_gb)
}

pub fn update_sandbox(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 80);
    let patch = args.get(1).cloned().unwrap_or(Value::Null);
    let (host_cpus, host_gb) = host_resources();
    crate::team_edit::edit_seat(state, project_id, &id, |seat| {
        let clean = |list: &Value| -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            for item in list.as_array().into_iter().flatten() {
                let d = text(item, 200).to_lowercase();
                if !d.is_empty() && !out.contains(&d) {
                    out.push(d);
                }
            }
            out
        };
        for key in ["allow", "deny"] {
            if patch[key].is_array() {
                seat["sandbox"][key] = json!(clean(&patch[key]));
            }
        }
        if let Some(res) = patch["resources"].as_object() {
            let cpus = match res.get("cpus") {
                Some(Value::Null) => Value::Null,
                Some(v) => json!(v.as_f64().unwrap_or(1.0).round().clamp(1.0, f64::from(host_cpus))),
                None => seat["sandbox"]["resources"]["cpus"].clone(),
            };
            let max_gb = ((host_gb * 0.75 * 2.0).floor() / 2.0).max(0.5);
            let memory = match res.get("memoryGb") {
                Some(Value::Null) => Value::Null,
                Some(v) => json!(((v.as_f64().unwrap_or(0.5) * 2.0).round() / 2.0).clamp(0.5, max_gb)),
                None => seat["sandbox"]["resources"]["memoryGb"].clone(),
            };
            seat["sandbox"]["resources"] = json!({ "cpus": cpus, "memoryGb": memory });
        }
        Ok(())
    })
}

pub fn set_lab_mode(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let on = args.first().and_then(Value::as_bool) == Some(true);
    crate::team_edit::mutate(state, project_id, |model, _| {
        model.template["rules"]["labMode"] = json!(on);
        model.rules["labMode"] = json!(on);
        Ok(())
    })
}

// ---------------------------------------------------------------- MCP server registry

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Private-network targets are refused unless the host's owner opts in with `ARIMA_ALLOW_PRIVATE_CONNECTIONS=1`.
fn allow_private() -> bool {
    std::env::var("ARIMA_ALLOW_PRIVATE_CONNECTIONS").is_ok_and(|v| v == "1")
}

/// Metadata and link-local addresses are never allowed; loopback, private, shared and unique-local ranges only with the opt-in.
fn ip_blocked(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let always = v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast();
            let o = v4.octets();
            always || (!allow_private() && (v4.is_loopback() || v4.is_private() || (o[0] == 100 && (o[1] & 0xc0) == 64)))
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => ip_blocked(IpAddr::V4(v4)),
            None => {
                let seg = v6.segments()[0];
                let always = v6.is_unspecified() || v6.is_multicast() || (seg & 0xffc0) == 0xfe80;
                always || (!allow_private() && (v6.is_loopback() || (seg & 0xfe00) == 0xfc00))
            }
        },
    }
}

const BLOCKED_MSG: &str = "That address is on a private network, or is a cloud metadata or link-local address, so HQ won't connect to it.";

/// Checks the URL's scheme and any literal address. Names are checked when they are resolved, in `resolve_endpoint`.
pub(crate) fn check_endpoint(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "That isn't a valid URL.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The URL must start with http:// or https://".into());
    }
    let blocked = match url.host() {
        Some(url::Host::Ipv4(v4)) => ip_blocked(v4.into()),
        Some(url::Host::Ipv6(v6)) => ip_blocked(v6.into()),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("metadata.google.internal") || (d.eq_ignore_ascii_case("localhost") && !allow_private()),
        None => true,
    };
    if blocked {
        return Err(BLOCKED_MSG.into());
    }
    Ok(url)
}

/// Resolves the URL's host and refuses it if any address is blocked. The caller connects to the returned
/// addresses only, so a name that changes its answer between this check and the request can't reach a blocked one.
async fn resolve_endpoint(url: &url::Url) -> Result<Option<(String, Vec<std::net::SocketAddr>)>, String> {
    let Some(url::Host::Domain(host)) = url.host() else { return Ok(None) };
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await.map_err(|_| format!("Couldn't find {host}."))?.collect();
    if addrs.is_empty() || addrs.iter().any(|a| ip_blocked(a.ip())) {
        return Err(BLOCKED_MSG.into());
    }
    Ok(Some((host.to_owned(), addrs)))
}

pub(crate) fn mcp_servers(state: &AppState) -> Vec<Value> {
    setting(state, "mcpServers").and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

pub fn add_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let name = text(&input["name"], 40);
    if !valid_name(&name) {
        return Err("A server name uses lowercase letters, digits and dashes.".into());
    }
    if name == "arima" {
        return Err("\"arima\" is HQ's own tool server. Pick another name.".into());
    }
    if !text(&input["command"], 300).is_empty() {
        return Err("Local stdio servers can't run on a hosted HQ. Add a remote server URL instead.".into());
    }
    let url = text(&input["url"], 500);
    check_endpoint(&url)?;
    let mut servers = mcp_servers(state);
    if servers.iter().any(|s| s["name"] == name) {
        return Err(format!("A server named \"{name}\" already exists."));
    }
    let key = text(&input["apiKey"], 4000);
    if !key.is_empty() {
        state.store_vault_secret(Some(&format!("mcp-{name}")), "mcp", "mcp", &name, &key).map_err(db_err)?;
    }
    servers.push(json!({ "name": name, "url": url, "hasKey": !key.is_empty() }));
    save_setting(state, "mcpServers", &json!(servers))?;
    broadcast(state, project_id);
    Ok(())
}

pub fn remove_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let name = text(args.first().unwrap_or(&Value::Null), 40);
    let mut servers = mcp_servers(state);
    let before = servers.len();
    servers.retain(|s| s["name"] != name);
    if servers.len() == before {
        return Err(format!("No MCP server \"{name}\"."));
    }
    save_setting(state, "mcpServers", &json!(servers))?;
    let _ = state.inner.vault_secrets.delete(&format!("mcp-{name}"));
    let _ = crate::team_edit::mutate(state, project_id, |model, _| {
        for agent in &mut model.team {
            if let Some(list) = agent["mcp"].as_array_mut() {
                list.retain(|n| n != name.as_str());
            }
        }
        Ok(())
    });
    broadcast(state, project_id);
    Ok(())
}

pub fn set_agent_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 80);
    let known: Vec<String> = mcp_servers(state).iter().filter_map(|s| s["name"].as_str().map(str::to_owned)).collect();
    let mut chosen: Vec<String> = Vec::new();
    for n in args.get(1).and_then(Value::as_array).into_iter().flatten().take(50) {
        let n = text(n, 40);
        if known.contains(&n) && !chosen.contains(&n) {
            chosen.push(n);
        }
    }
    crate::team_edit::edit_seat(state, project_id, &id, |seat| {
        seat["mcp"] = json!(chosen);
        Ok(())
    })
}

/// The MCP section of the snapshot.
#[must_use]
pub fn mcp_state(state: &AppState, team: &[Value], checked_at: &str) -> Value {
    let servers: Vec<Value> = mcp_servers(state)
        .iter()
        .map(|s| {
            json!({ "name": s["name"], "transport": "remote http", "status": s["status"].as_str().unwrap_or("unchecked"),
                "error": s.get("error").cloned().unwrap_or(Value::Null), "checkedAt": s.get("checkedAt").cloned().unwrap_or(Value::Null), "nextStep": null })
        })
        .collect();
    let attached: Map<String, Value> = team.iter().filter_map(|a| Some((a["id"].as_str()?.to_owned(), a["mcp"].clone()))).collect();
    json!({ "servers": servers, "attached": attached, "error": null, "checkedAt": checked_at })
}

fn mcp_key(state: &AppState, name: &str) -> Option<String> {
    let row = state.inner.vault_secrets.get_by_id(&format!("mcp-{name}")).ok().flatten()?;
    let raw = state.inner.auth.vault().decrypt(format!("vault-secret:{}", row.id).as_bytes(), &row.secret_enc).ok()?;
    Some(String::from_utf8_lossy(&raw).into_owned())
}

const MCP_CHECKS_PER_MINUTE: u32 = 10;

/// Spends one of the project's live checks for this minute; each one makes HQ call out to MCP servers.
fn take_mcp_check(state: &AppState, project_id: &str) -> Result<(), String> {
    let now = std::time::Instant::now();
    let mut checks = state.inner.mcp_checks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let (start, count) = checks.entry(project_id.to_owned()).or_insert((now, 0));
    if now.duration_since(*start) >= std::time::Duration::from_secs(60) {
        (*start, *count) = (now, 0);
    }
    if *count >= MCP_CHECKS_PER_MINUTE {
        return Err("MCP servers were checked too often. Try again in a minute.".into());
    }
    *count += 1;
    Ok(())
}

/// Probes the named MCP server, or every one when no name is given, and records each result for the snapshot.
pub async fn refresh_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    use futures_util::StreamExt;
    let only = args.first().map(|v| text(v, 40)).filter(|n| !n.is_empty());
    let targets: Vec<(String, String)> = mcp_servers(state)
        .iter()
        .filter(|s| only.as_ref().is_none_or(|n| s["name"] == n.as_str()))
        .filter_map(|s| Some((s["name"].as_str()?.to_owned(), s["url"].as_str()?.to_owned())))
        .collect();
    if let (Some(n), true) = (&only, targets.is_empty()) {
        return Err(format!("No MCP server \"{n}\"."));
    }
    take_mcp_check(state, project_id)?;
    let results: Vec<(String, Result<Vec<Value>, String>)> = futures_util::stream::iter(targets)
        .map(|(name, url)| async move {
            let result = probe(&name, &url, mcp_key(state, &name)).await;
            (name, result)
        })
        .buffer_unordered(4)
        .collect()
        .await;
    let now = Utc::now().to_rfc3339();
    // Re-read after the probes so a server added or removed meanwhile isn't lost or brought back.
    let mut servers = mcp_servers(state);
    for s in &mut servers {
        if let Some((_, result)) = results.iter().find(|(n, _)| s["name"] == n.as_str()) {
            s["status"] = json!(if result.is_ok() { "ready" } else { "error" });
            s["error"] = result.as_ref().err().map_or(Value::Null, |e| json!(e));
            s["checkedAt"] = json!(now);
        }
    }
    save_setting(state, "mcpServers", &json!(servers))?;
    broadcast(state, project_id);
    Ok(())
}

// ---------------------------------------------------------------- tool connections

fn conn_meta_key(name: &str) -> String {
    format!("connection-meta:{name}")
}

fn strings(v: &Value, max: usize) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|s| text(s, 80)).filter(|s| !s.is_empty()).take(max).collect()).unwrap_or_default()
}

pub fn save_connection(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let name = text(&input["name"], 40);
    if !valid_name(&name) {
        return Err("A connection name uses lowercase letters, digits and dashes.".into());
    }
    let existing = state.inner.connections.list().map_err(db_err)?.into_iter().find(|c| c.id == name);
    let url = Some(text(&input["url"], 500)).filter(|u| !u.is_empty()).or_else(|| existing.as_ref().map(|c| c.endpoint.clone())).ok_or("A connection needs a URL.")?;
    check_endpoint(&url)?;
    let key = input["apiKey"].as_str().map(str::trim);
    let enc = match key {
        Some(k) if !k.is_empty() => Some(state.inner.auth.vault().encrypt(format!("tool-connection:{name}").as_bytes(), k.as_bytes()).map_err(db_err)?),
        _ => None,
    };
    state.inner.connections.upsert(&name, "mcp", &name, &url, enc.as_deref()).map_err(db_err)?;
    if key == Some("") {
        state
            .inner
            .db
            .transaction(|conn| {
                conn.execute("UPDATE tool_connections SET secret_enc = NULL WHERE id = ?1", [&name])?;
                Ok::<_, DbError>(())
            })
            .map_err(db_err)?;
    }
    let mut meta = setting(state, &conn_meta_key(&name)).unwrap_or_else(|| json!({}));
    if input.get("roles").is_some() {
        meta["roles"] = json!(strings(&input["roles"], 20));
    }
    if input.get("read").is_some() {
        meta["read"] = json!(strings(&input["read"], 100));
    }
    if input.get("send").is_some() {
        let send = text(&input["send"], 80);
        meta["send"] = if send.is_empty() { Value::Null } else { json!(send) };
    }
    save_setting(state, &conn_meta_key(&name), &meta)?;
    broadcast(state, project_id);
    Ok(())
}

pub fn remove_connection(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let name = text(args.first().unwrap_or(&Value::Null), 40);
    if !state.inner.connections.delete(&name).map_err(db_err)? {
        return Err(format!("No connection \"{name}\"."));
    }
    drop_setting(state, &conn_meta_key(&name))?;
    broadcast(state, project_id);
    Ok(())
}

/// Parses a `tools/list` reply, plain JSON or one server-sent `data:` event.
fn parse_tools(body: &str) -> Vec<Value> {
    let json_text = body.lines().find_map(|l| l.strip_prefix("data:")).map_or(body, str::trim);
    serde_json::from_str::<Value>(json_text)
        .ok()
        .and_then(|v| v["result"]["tools"].as_array().cloned())
        .map(|ts| ts.iter().map(|t| json!({ "name": t["name"], "description": t["description"].as_str().unwrap_or("") })).collect())
        .unwrap_or_default()
}

/// One `tools/list` call through the endpoint guard, connecting only to the addresses that passed it.
async fn probe(name: &str, endpoint: &str, bearer: Option<String>) -> Result<Vec<Value>, String> {
    let url = check_endpoint(endpoint)?;
    let call = async {
        let pinned = resolve_endpoint(&url).await?;
        let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none());
        if let Some((host, addrs)) = pinned {
            builder = builder.resolve_to_addrs(&host, &addrs);
        }
        let mut req = builder
            .build()
            .map_err(db_err)?
            .post(url.clone())
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        if let Some(key) = bearer {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await.map_err(|e| format!("Couldn't reach {name}: {}", e.without_url()))?;
        if !resp.status().is_success() {
            return Err(format!("{name} answered {}.", resp.status()));
        }
        Ok(parse_tools(&resp.text().await.map_err(db_err)?))
    };
    // The request has its own timeout; this also bounds the name lookup and reading the body.
    tokio::time::timeout(std::time::Duration::from_secs(10), call).await.map_err(|_| format!("{name} didn't answer in time."))?
}

pub async fn check_connection(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let name = text(args.first().unwrap_or(&Value::Null), 40);
    let conn = state.inner.connections.list().map_err(db_err)?.into_iter().find(|c| c.id == name).ok_or_else(|| format!("No connection \"{name}\"."))?;
    let mut bearer = None;
    if conn.has_secret {
        let enc: Option<String> = state
            .inner
            .db
            .read(|c| c.query_row("SELECT secret_enc FROM tool_connections WHERE id = ?1", [&name], |r| r.get(0)).optional().map_err(DbError::from))
            .map_err(db_err)?
            .flatten();
        bearer = enc.and_then(|e| state.inner.auth.vault().decrypt(format!("tool-connection:{name}").as_bytes(), &e).ok()).map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    let tools = probe(&name, &conn.endpoint, bearer).await?;
    let mut meta = setting(state, &conn_meta_key(&name)).unwrap_or_else(|| json!({}));
    meta["tools"] = json!(tools);
    meta["probedAt"] = json!(Utc::now().to_rfc3339());
    save_setting(state, &conn_meta_key(&name), &meta)?;
    broadcast(state, project_id);
    Ok(())
}

/// The connections section of the snapshot: no keys, only whether one is stored.
#[must_use]
pub fn connections_state(state: &AppState) -> Vec<Value> {
    state
        .inner
        .connections
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let meta = setting(state, &conn_meta_key(&c.id)).unwrap_or_else(|| json!({}));
            json!({
                "name": c.id, "url": c.endpoint, "roles": meta["roles"].as_array().cloned().unwrap_or_default(),
                "read": meta["read"].as_array().cloned().unwrap_or_default(), "send": meta.get("send").cloned().unwrap_or(Value::Null),
                "tools": meta["tools"].as_array().cloned().unwrap_or_default(), "probedAt": meta.get("probedAt").cloned().unwrap_or(Value::Null),
                "hasKey": c.has_secret
            })
        })
        .collect()
}

// ---------------------------------------------------------------- template library

/// An imported template by id.
#[must_use]
pub fn custom_template(state: &AppState, id: &str) -> Option<Value> {
    custom_templates(state).into_iter().find(|t| t["id"] == id)
}

fn custom_templates(state: &AppState) -> Vec<Value> {
    setting(state, "customTemplates").and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

/// Built-in templates followed by the ones imported into this HQ, shaped as `TemplateEntry`.
#[must_use]
pub fn template_library(state: &AppState) -> Vec<Value> {
    let mut library = crate::team::template_library();
    library.extend(custom_templates(state).into_iter().map(|t| json!({ "template": t, "builtin": false, "problems": [] })));
    library
}

pub fn export_template(state: &AppState, project_id: &str) -> Result<(), String> {
    let model = crate::team::load(state, project_id).ok_or("This project has no team yet, so there is no template to save.")?;
    let file = json!({ "format": TEMPLATE_FORMAT, "v": 1, "exportedAt": Utc::now().to_rfc3339(), "template": model.template, "packs": {} });
    state.inner.ws_hub.broadcast_project(project_id, &json!({ "type": "template.file", "file": file }).to_string());
    Ok(())
}

pub fn import_template(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let result = import_template_inner(state, args.first().and_then(Value::as_str).unwrap_or(""));
    let event = match &result {
        Ok(id) => json!({ "type": "template.imported", "ok": true, "message": format!("Imported template {id}."), "id": id }),
        Err(message) => json!({ "type": "template.imported", "ok": false, "message": message }),
    };
    state.inner.ws_hub.broadcast_project(project_id, &event.to_string());
    if result.is_ok() {
        broadcast(state, project_id);
    }
    result.map(|_| ())
}

fn import_template_inner(state: &AppState, raw: &str) -> Result<String, String> {
    if raw.len() > 1_000_000 {
        return Err("That template file is too large.".into());
    }
    let file: Value = serde_json::from_str(raw).map_err(|_| "That isn't a template file.".to_owned())?;
    if file["format"] != TEMPLATE_FORMAT || file["v"] != 1 {
        return Err("That isn't an ArimaOps template file.".into());
    }
    let template = file["template"].clone();
    crate::team_edit::validate_template(&template)?;
    let id = text(&template["id"], 40);
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("The template needs an id of letters, digits, dashes or underscores.".into());
    }
    let builtin = crate::team::template_library().iter().any(|e| e["template"]["id"] == id.as_str());
    if builtin {
        return Err(format!("\"{id}\" is a built-in template; rename the template's id before importing."));
    }
    let mut all = custom_templates(state);
    all.retain(|t| t["id"] != id.as_str());
    all.push(template);
    save_setting(state, "customTemplates", &json!(all))?;
    Ok(id)
}

// ---------------------------------------------------------------- setup checklist

/// The setup checklist from what HQ can really observe: this machine's size and the last Docker check.
/// Every agent CLI ships in the agent image, so a CLI is "ready" exactly when the runtime is.
pub fn setup_state(state: &AppState, now: &str) -> Value {
    let (cpus, mem_gb) = host_resources();
    let st = state.inner.runtime.status();
    let fix = |command: &str| json!({ "command": command, "runnable": false, "docs": null });
    let mut checks = vec![
        json!({ "id": "docker", "label": "Docker", "status": if st.docker_ok { "ok" } else { "missing" }, "detail": st.docker_detail, "neededFor": "container",
            "fix": if st.docker_ok { Value::Null } else { fix("- /var/run/docker.sock:/var/run/docker.sock  (add under HQ's volumes, then restart)") } }),
        json!({ "id": "agent-image", "label": "Agent image", "status": if st.image_ok { "ok" } else if st.docker_ok { "warning" } else { "missing" }, "detail": st.image_detail, "neededFor": "container",
            "fix": if st.image_ok || !st.docker_ok { Value::Null } else { fix(&format!("docker pull {}", state.inner.runtime.config.image)) } }),
    ];
    for a in &crate::cli::ADAPTERS {
        checks.push(json!({ "id": a.id, "label": a.label, "status": if st.docker_ok { "ok" } else { "missing" },
            "detail": if st.docker_ok { "Included in the agent image. Sign in from the agent's terminal on first Start." } else { "Needs Docker." }, "neededFor": "container", "fix": Value::Null }));
    }
    json!({
        "machine": { "cpus": cpus, "memoryGb": (mem_gb * 10.0).round() / 10.0, "persistentAgents": true },
        "checks": checks,
        "sandboxReady": false,
        "localReady": false,
        "containerReady": st.docker_ok,
        "checkedAt": now
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_block_metadata_and_bad_schemes() {
        assert!(check_endpoint("https://mcp.example.com/rpc").is_ok());
        for bad in ["http://127.0.0.1:9000/mcp", "http://localhost/x", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:10.0.0.1]/"] {
            assert!(check_endpoint(bad).is_err(), "{bad} is private");
        }
        for bad in ["http://169.254.169.254/latest", "ftp://x.com", "not a url", "http://metadata.google.internal/", "http://[fe80::1]/"] {
            assert!(check_endpoint(bad).is_err(), "{bad} is rejected");
        }
    }

    #[test]
    fn tools_parse_from_json_and_event_streams() {
        let plain = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search","description":"find"}]}}"#;
        assert_eq!(parse_tools(plain)[0]["name"], "search");
        let sse = format!("event: message\ndata: {plain}\n\n");
        assert_eq!(parse_tools(&sse).len(), 1);
        assert!(parse_tools("garbage").is_empty());
    }

    #[test]
    fn runtime_bound_commands_explain_themselves() {
        assert!(unsupported("openShell").is_some() && unsupported("addToSuite").is_some());
        assert!(unsupported("setEnvVar").is_none());
    }
}
