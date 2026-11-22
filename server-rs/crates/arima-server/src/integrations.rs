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
    state.inner.ws_hub.broadcast_raw_json(&snapshot.to_string());
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

fn host_resources() -> (u32, f64) {
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

/// Blocks cloud metadata and link-local targets; everything else is the owner's call.
fn check_endpoint(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "That isn't a valid URL.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The URL must start with http:// or https://".into());
    }
    let blocked = match url.host() {
        Some(url::Host::Ipv4(v4)) => v4.is_link_local() || v4.is_unspecified(),
        Some(url::Host::Ipv6(v6)) => v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80,
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("metadata.google.internal"),
        None => true,
    };
    if blocked {
        return Err("That address is a cloud metadata or link-local address and can't be used.".into());
    }
    Ok(url)
}

fn mcp_servers(state: &AppState) -> Vec<Value> {
    setting(state, "mcpServers").and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

pub fn add_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let name = text(&input["name"], 40);
    if !valid_name(&name) {
        return Err("A server name uses lowercase letters, digits and dashes.".into());
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
        .map(|s| json!({ "name": s["name"], "transport": "remote http", "status": "ready", "nextStep": null }))
        .collect();
    let attached: Map<String, Value> = team.iter().filter_map(|a| Some((a["id"].as_str()?.to_owned(), a["mcp"].clone()))).collect();
    json!({ "servers": servers, "attached": attached, "error": null, "checkedAt": checked_at })
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

pub async fn check_connection(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let name = text(args.first().unwrap_or(&Value::Null), 40);
    let conn = state.inner.connections.list().map_err(db_err)?.into_iter().find(|c| c.id == name).ok_or_else(|| format!("No connection \"{name}\"."))?;
    let url = check_endpoint(&conn.endpoint)?;
    let mut req = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(db_err)?
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    if conn.has_secret {
        let enc: Option<String> = state
            .inner
            .db
            .read(|c| c.query_row("SELECT secret_enc FROM tool_connections WHERE id = ?1", [&name], |r| r.get(0)).optional().map_err(DbError::from))
            .map_err(db_err)?
            .flatten();
        if let Some(bytes) = enc.and_then(|e| state.inner.auth.vault().decrypt(format!("tool-connection:{name}").as_bytes(), &e).ok()) {
            req = req.bearer_auth(String::from_utf8_lossy(&bytes));
        }
    }
    let resp = req.send().await.map_err(|e| format!("Couldn't reach {name}: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(format!("{name} answered {}.", resp.status()));
    }
    let tools = parse_tools(&resp.text().await.map_err(db_err)?);
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
    state.inner.ws_hub.broadcast_raw_json(&json!({ "type": "template.file", "file": file }).to_string());
    Ok(())
}

pub fn import_template(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let result = import_template_inner(state, args.first().and_then(Value::as_str).unwrap_or(""));
    let event = match &result {
        Ok(id) => json!({ "type": "template.imported", "ok": true, "message": format!("Imported template {id}."), "id": id }),
        Err(message) => json!({ "type": "template.imported", "ok": false, "message": message }),
    };
    state.inner.ws_hub.broadcast_raw_json(&event.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_block_metadata_and_bad_schemes() {
        assert!(check_endpoint("https://mcp.example.com/rpc").is_ok());
        assert!(check_endpoint("http://127.0.0.1:9000/mcp").is_ok());
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
