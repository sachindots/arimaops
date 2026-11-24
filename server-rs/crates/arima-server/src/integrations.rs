// SPDX-License-Identifier: AGPL-3.0-or-later

//! Integrations and sandbox settings over the WebSocket: MCP server registry, tool connections, per-agent
//! sandbox limits, lab mode, and template import and export.
//!
//! Commands that need a live terminal, sandbox or OAuth runtime (see [`unsupported`]) answer with a plain
//! error, so the UI shows why nothing happened instead of waiting.

use arima_core::{ToolServer, ToolServerCheck, ToolServerSource, ToolServerTransport};
use arima_db::DbError;
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use crate::state::AppState;

const TEMPLATE_FORMAT: &str = "arimaops-template";

fn text(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").trim().chars().take(max).collect()
}

pub(crate) fn broadcast(state: &AppState, project_id: &str) {
    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
}

fn db_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub(crate) fn setting(state: &AppState, key: &str) -> Option<Value> {
    let raw: Option<String> = state
        .inner
        .db
        .read(|conn| conn.query_row("SELECT value_json FROM server_settings WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(DbError::from))
        .ok()
        .flatten();
    serde_json::from_str(&raw?).ok()
}

pub(crate) fn save_setting(state: &AppState, key: &str, value: &Value) -> Result<(), String> {
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

pub(crate) fn drop_setting(state: &AppState, key: &str) -> Result<(), String> {
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

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Metadata, link-local and unspecified addresses are never allowed; loopback, private, shared (CGNAT) and
/// unique-local ranges only when the host's owner opts in (`ServerConfig::allow_private_connections`).
/// The same guard the egress proxy uses, so the two can't disagree.
pub(crate) fn ip_blocked(ip: std::net::IpAddr, allow_private: bool) -> bool {
    arima_proxy::is_imds_or_link_local_ip(ip) || (!allow_private && arima_proxy::is_restricted_ip(ip))
}

const BLOCKED_MSG: &str = "That address is on a private network, or is a cloud metadata or link-local address, so HQ won't connect to it.";

/// Checks the URL's scheme and any literal address. Names are checked when they are resolved, in `resolve_endpoint`.
pub(crate) fn check_endpoint(raw: &str, allow_private: bool) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "That isn't a valid URL.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The URL must start with http:// or https://".into());
    }
    let blocked = match url.host() {
        Some(url::Host::Ipv4(v4)) => ip_blocked(v4.into(), allow_private),
        Some(url::Host::Ipv6(v6)) => ip_blocked(v6.into(), allow_private),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("metadata.google.internal") || (d.eq_ignore_ascii_case("localhost") && !allow_private),
        None => true,
    };
    if blocked {
        return Err(BLOCKED_MSG.into());
    }
    Ok(url)
}

/// Resolves the URL's host and refuses it if any address is blocked. The caller connects to the returned
/// addresses only, so a name that changes its answer between this check and the request can't reach a blocked one.
async fn resolve_endpoint(url: &url::Url, allow_private: bool) -> Result<Option<(String, Vec<std::net::SocketAddr>)>, String> {
    let Some(url::Host::Domain(host)) = url.host() else { return Ok(None) };
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await.map_err(|_| format!("Couldn't find {host}."))?.collect();
    if addrs.is_empty() || addrs.iter().any(|a| ip_blocked(a.ip(), allow_private)) {
        return Err(BLOCKED_MSG.into());
    }
    Ok(Some((host.to_owned(), addrs)))
}

fn servers_key(project_id: &str) -> String {
    format!("mcpServers:{project_id}")
}

/// The vault id of a project's tool-server key.
#[must_use]
pub fn mcp_secret_id(project_id: &str, name: &str) -> String {
    format!("mcp:{project_id}:{name}")
}

/// This project's tool servers.
#[must_use]
pub fn tool_servers(state: &AppState, project_id: &str) -> Vec<ToolServer> {
    setting(state, &servers_key(project_id)).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save_tool_servers(state: &AppState, project_id: &str, servers: &[ToolServer]) -> Result<(), String> {
    save_setting(state, &servers_key(project_id), &json!(servers))
}

/// The only way to change a project's tool-server list: reads, edits and saves it under one lock, so concurrent
/// writers can't drop each other's change. Nothing is saved when `edit` fails. `edit` must not await or call back
/// into this function (the lock isn't reentrant).
pub fn update_tool_servers<R>(state: &AppState, project_id: &str, edit: impl FnOnce(&mut Vec<ToolServer>) -> Result<R, String>) -> Result<R, String> {
    let _guard = state.inner.tool_servers_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut servers = tool_servers(state, project_id);
    let out = edit(&mut servers)?;
    save_tool_servers(state, project_id, &servers)?;
    Ok(out)
}

pub(crate) fn live_projects(state: &AppState) -> Vec<(String, String)> {
    state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT id, name FROM projects WHERE archived = 0 ORDER BY created_at ASC")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
        })
        .unwrap_or_default()
}

/// Copies one vault secret to a new id. `Ok(false)` when there was none to copy.
pub(crate) fn copy_secret(state: &AppState, from: &str, to: &str, label: &str) -> Result<bool, String> {
    let Some(key) = crate::runtime::vault_secret(state, from)? else { return Ok(false) };
    state.store_vault_secret(Some(to), "mcp", "mcp", label, &key).map_err(db_err)?;
    Ok(true)
}

/// Moves the old HQ-wide `mcpServers` list and its `mcp-{name}` keys into every live project. Safe to rerun:
/// each copy overwrites the same entry, and the old data goes only after every copy has succeeded.
pub fn migrate_hq_wide_tool_servers(state: &AppState) -> Result<(), String> {
    let Some(old) = setting(state, "mcpServers").and_then(|v| v.as_array().cloned()) else { return Ok(()) };
    let entries: Vec<ToolServer> = old
        .iter()
        .filter_map(|s| {
            let name = s["name"].as_str().filter(|n| valid_name(n) && *n != "arima")?.to_owned();
            let url = s["url"].as_str()?.to_owned();
            let status = s["status"].as_str().unwrap_or("");
            let check = s["checkedAt"].as_str().filter(|_| matches!(status, "ready" | "error")).map(|at| ToolServerCheck {
                ok: status == "ready",
                error: s["error"].as_str().map(str::to_owned),
                at: at.to_owned(),
            });
            Some(ToolServer { name, transport: ToolServerTransport::Http { url }, has_key: s["hasKey"] == true, source: ToolServerSource::Manual, check, tools_sha256: None, blocked: None })
        })
        .collect();
    for (pid, _) in live_projects(state) {
        for entry in entries.iter().filter(|e| e.has_key) {
            copy_secret(state, &format!("mcp-{}", entry.name), &mcp_secret_id(&pid, &entry.name), &entry.name)?;
        }
        update_tool_servers(state, &pid, |servers| {
            for entry in &entries {
                servers.retain(|s| s.name != entry.name);
                servers.push(entry.clone());
            }
            Ok(())
        })?;
    }
    for s in &old {
        if let Some(name) = s["name"].as_str() {
            let _ = state.inner.vault_secrets.delete(&format!("mcp-{name}"));
        }
    }
    drop_setting(state, "mcpServers")
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
    check_endpoint(&url, state.inner.config.allow_private_connections)?;
    let key = text(&input["apiKey"], 4000);
    update_tool_servers(state, project_id, |servers| {
        if servers.iter().any(|s| s.name == name) {
            return Err(format!("A server named \"{name}\" already exists."));
        }
        if !key.is_empty() {
            state.store_vault_secret(Some(&mcp_secret_id(project_id, &name)), "mcp", "mcp", &name, &key).map_err(db_err)?;
        }
        servers.push(ToolServer { name, transport: ToolServerTransport::Http { url }, has_key: !key.is_empty(), source: ToolServerSource::Manual, check: None, tools_sha256: None, blocked: None });
        Ok(())
    })?;
    broadcast(state, project_id);
    Ok(())
}

/// Copies another project's server, and its key without revealing it, into this project.
/// Args: the source project id, then the server name.
pub fn copy_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let from = text(args.first().unwrap_or(&Value::Null), 80);
    let name = text(args.get(1).unwrap_or(&Value::Null), 40);
    if from == project_id || !live_projects(state).iter().any(|(id, _)| *id == from) {
        return Err("Pick another project to copy from.".into());
    }
    let entry = tool_servers(state, &from).into_iter().find(|s| s.name == name).ok_or_else(|| format!("That project has no server \"{name}\"."))?;
    if matches!(entry.source, ToolServerSource::Pack { .. }) {
        return Err(format!("\"{name}\" comes from a pack. Install the pack in this project instead."));
    }
    update_tool_servers(state, project_id, |servers| {
        if servers.iter().any(|s| s.name == name) {
            return Err(format!("A server named \"{name}\" already exists."));
        }
        let has_key = entry.has_key && copy_secret(state, &mcp_secret_id(&from, &name), &mcp_secret_id(project_id, &name), &name)?;
        servers.push(ToolServer { has_key, check: None, ..entry });
        Ok(())
    })?;
    broadcast(state, project_id);
    Ok(())
}

pub fn remove_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let name = text(args.first().unwrap_or(&Value::Null), 40);
    let servers = tool_servers(state, project_id);
    match servers.iter().find(|s| s.name == name) {
        None => return Err(format!("No MCP server \"{name}\".")),
        Some(ToolServer { source: ToolServerSource::Pack { pack_id, .. }, .. }) => return Err(format!("\"{name}\" comes from the pack {pack_id}. Remove the pack instead.")),
        Some(_) => {}
    }
    drop_servers(state, project_id, &[name])?;
    broadcast(state, project_id);
    Ok(())
}

/// Removes these servers from the project's list, their keys from the vault, and their names from every seat.
pub(crate) fn drop_servers(state: &AppState, project_id: &str, names: &[String]) -> Result<(), String> {
    update_tool_servers(state, project_id, |servers| {
        servers.retain(|s| !names.contains(&s.name));
        crate::codemode::store_tools(state, project_id, |all| all.retain(|n, _| !names.contains(n)))
    })?;
    for name in names {
        let _ = state.inner.vault_secrets.delete(&mcp_secret_id(project_id, name));
    }
    let _ = crate::team_edit::mutate(state, project_id, |model, _| {
        for agent in &mut model.team {
            if let Some(list) = agent["mcp"].as_array_mut() {
                list.retain(|n| !n.as_str().is_some_and(|n| names.iter().any(|x| x == n)));
            }
        }
        Ok(())
    });
    Ok(())
}

/// `setToolServerKey [name, key]`: stores (or, when empty, clears) a server's key without showing the old one.
pub fn set_tool_server_key(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let name = text(args.first().unwrap_or(&Value::Null), 40);
    let key = text(args.get(1).unwrap_or(&Value::Null), 4000);
    update_tool_servers(state, project_id, |servers| {
        let entry = servers.iter_mut().find(|s| s.name == name).ok_or_else(|| format!("No MCP server \"{name}\"."))?;
        if key.is_empty() {
            let _ = state.inner.vault_secrets.delete(&mcp_secret_id(project_id, &name));
        } else {
            state.store_vault_secret(Some(&mcp_secret_id(project_id, &name)), "mcp", "mcp", &name, &key).map_err(db_err)?;
        }
        entry.has_key = !key.is_empty();
        Ok(())
    })?;
    broadcast(state, project_id);
    Ok(())
}

pub fn set_agent_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 80);
    let known: Vec<String> = tool_servers(state, project_id).into_iter().map(|s| s.name).collect();
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

/// The tool-server section of a project's snapshot: its own list, plus other projects' servers it can copy.
#[must_use]
pub fn mcp_state(state: &AppState, project_id: &str, team: &[Value], checked_at: &str) -> Value {
    let attached: Map<String, Value> = team.iter().filter_map(|a| Some((a["id"].as_str()?.to_owned(), a["mcp"].clone()))).collect();
    let others: Vec<Value> = live_projects(state)
        .into_iter()
        .filter(|(id, _)| id != project_id)
        .flat_map(|(id, project)| {
            tool_servers(state, &id).into_iter().filter(|s| s.source == ToolServerSource::Manual).map(move |s| json!({ "projectId": id, "project": project, "name": s.name }))
        })
        .collect();
    json!({ "servers": tool_servers(state, project_id), "attached": attached, "others": others, "toolsAsCode": crate::codemode::enabled(state, project_id), "error": null, "checkedAt": checked_at })
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

/// Probes the project's named server, or every one when no name is given, and records each result for the snapshot.
pub async fn refresh_mcp(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    use futures_util::StreamExt;
    let only = args.first().map(|v| text(v, 40)).filter(|n| !n.is_empty());
    let targets: Vec<(String, String, bool)> = tool_servers(state, project_id)
        .into_iter()
        .filter(|s| only.as_ref().is_none_or(|n| s.name == *n))
        .map(|s| {
            let ToolServerTransport::Http { url } = s.transport;
            (s.name, url, s.has_key)
        })
        .collect();
    if let (Some(n), true) = (&only, targets.is_empty()) {
        return Err(format!("No MCP server \"{n}\"."));
    }
    take_mcp_check(state, project_id)?;
    let results: Vec<(String, Result<Vec<Value>, String>)> = futures_util::stream::iter(targets)
        .map(|(name, url, has_key)| async move {
            let key = if has_key { crate::runtime::vault_secret(state, &mcp_secret_id(project_id, &name)).ok().flatten() } else { None };
            let result = probe(state, &name, &url, key).await;
            (name, result)
        })
        .buffer_unordered(4)
        .collect()
        .await;
    let at = Utc::now().to_rfc3339();
    // on_tools_listed may file a review that rewrites this list, so it runs on copies outside the lock.
    let listed: Vec<ToolServer> = tool_servers(state, project_id)
        .into_iter()
        .filter_map(|mut s| {
            let Some((_, Ok(tools))) = results.iter().find(|(n, _)| s.name == *n) else { return None };
            crate::packs::on_tools_listed(state, project_id, &mut s, tools);
            Some(s)
        })
        .collect();
    // Re-read under the lock so a server added or removed meanwhile isn't lost or brought back.
    update_tool_servers(state, project_id, |servers| {
        for s in servers.iter_mut() {
            if let Some((_, result)) = results.iter().find(|(n, _)| s.name == *n) {
                s.check = Some(ToolServerCheck { ok: result.is_ok(), error: result.as_ref().err().cloned(), at: at.clone() });
            }
            if let Some(l) = listed.iter().find(|l| l.name == s.name) {
                (s.blocked, s.tools_sha256) = (l.blocked.clone(), l.tools_sha256.clone());
            }
        }
        crate::codemode::store_tools(state, project_id, |all| {
            for s in servers.iter() {
                if let Some((_, Ok(tools))) = results.iter().find(|(n, _)| s.name == *n) {
                    all.insert(s.name.clone(), json!(tools));
                }
            }
        })
    })?;
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
    check_endpoint(&url, state.inner.config.allow_private_connections)?;
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

/// Parses a `tools/list` reply, plain JSON or one server-sent `data:` event, into the normalised list: each tool's
/// name, description, input schema and annotations, sorted by name. Its hash is what a pack's approval pins.
fn parse_tools(body: &str) -> Vec<Value> {
    let json_text = body.lines().find_map(|l| l.strip_prefix("data:")).map_or(body, str::trim);
    let mut tools: Vec<Value> = serde_json::from_str::<Value>(json_text)
        .ok()
        .and_then(|v| v["result"]["tools"].as_array().cloned())
        .map(|ts| {
            ts.iter()
                .map(|t| json!({ "name": t["name"], "description": t["description"].as_str().unwrap_or(""), "inputSchema": t["inputSchema"], "annotations": t["annotations"] }))
                .collect()
        })
        .unwrap_or_default();
    tools.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    tools
}

/// A client for `endpoint` that passed the endpoint guard: it connects only to the addresses checked here and
/// follows no redirects, so neither a changed DNS answer nor a redirect can reach a blocked address.
pub(crate) async fn guarded_client(state: &AppState, endpoint: &str, timeout: std::time::Duration) -> Result<(url::Url, reqwest::Client), String> {
    let allow_private = state.inner.config.allow_private_connections;
    let url = check_endpoint(endpoint, allow_private)?;
    let pinned = resolve_endpoint(&url, allow_private).await?;
    let mut builder = reqwest::Client::builder().timeout(timeout).connect_timeout(std::time::Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none());
    if let Some((host, addrs)) = pinned {
        builder = builder.resolve_to_addrs(&host, &addrs);
    }
    Ok((url, builder.build().map_err(db_err)?))
}

/// Records how a call through HQ to one of the project's servers went, the same way a live check does. A success
/// is written only over a failed check, so working calls don't rewrite the setting each time.
pub(crate) fn record_forward(state: &AppState, project_id: &str, name: &str, result: Result<(), String>) {
    let changed = update_tool_servers(state, project_id, |servers| {
        let Some(s) = servers.iter_mut().find(|s| s.name == name) else { return Err(String::new()) };
        if result.is_ok() && s.check.as_ref().is_none_or(|c| c.ok) {
            return Err(String::new());
        }
        s.check = Some(ToolServerCheck { ok: result.is_ok(), error: result.err(), at: Utc::now().to_rfc3339() });
        Ok(())
    });
    if changed.is_ok() {
        broadcast(state, project_id);
    }
}

/// One `tools/list` call through the endpoint guard, connecting only to the addresses that passed it.
pub(crate) async fn probe(state: &AppState, name: &str, endpoint: &str, bearer: Option<String>) -> Result<Vec<Value>, String> {
    let call = async {
        let (url, client) = guarded_client(state, endpoint, std::time::Duration::from_secs(8)).await?;
        let mut req = client
            .post(url)
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
    let tools = probe(state, &name, &conn.endpoint, bearer).await?;
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
    let file = json!({ "format": TEMPLATE_FORMAT, "v": 1, "exportedAt": Utc::now().to_rfc3339(), "template": model.template, "packs": crate::packs::export(state, project_id) });
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
    // Packs from a file are never trusted: a project started from this template installs them pending review.
    let packs = crate::packs::parse_template_packs(&file["packs"])?;
    let mut all = custom_templates(state);
    all.retain(|t| t["id"] != id.as_str());
    all.push(template);
    save_setting(state, "customTemplates", &json!(all))?;
    crate::packs::save_template_packs(state, &id, &packs)?;
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
        assert!(check_endpoint("https://mcp.example.com/rpc", false).is_ok());
        for bad in ["http://127.0.0.1:9000/mcp", "http://localhost/x", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:10.0.0.1]/"] {
            assert!(check_endpoint(bad, false).is_err(), "{bad} is private");
            assert!(check_endpoint(bad, true).is_ok(), "{bad} is allowed with the owner's opt-in");
        }
        // Even with the opt-in: AWS's IPv6 metadata address and 0.0.0.0/8 slipped past the old forwarder guard.
        for bad in ["http://169.254.169.254/latest", "ftp://x.com", "not a url", "http://metadata.google.internal/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", "http://0.0.0.1/", "http://[::ffff:169.254.169.254]/"] {
            assert!(check_endpoint(bad, false).is_err(), "{bad} is rejected");
            assert!(check_endpoint(bad, true).is_err(), "{bad} is rejected even with the opt-in");
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
    fn concurrent_tool_server_updates_are_all_kept() {
        let (state, pid, _) = two_projects();
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let (state, pid) = (state.clone(), pid.clone());
                std::thread::spawn(move || {
                    for i in 0..25 {
                        update_tool_servers(&state, &pid, |servers| {
                            let url = "https://example.com/mcp".to_owned();
                            servers.push(ToolServer { name: format!("s-{t}-{i}"), transport: ToolServerTransport::Http { url }, has_key: false, source: ToolServerSource::Manual, check: None, tools_sha256: None, blocked: None });
                            Ok(())
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(tool_servers(&state, &pid).len(), 200, "no concurrent update is lost");
    }

    /// Two projects, each with a team, plus an archived third one.
    fn two_projects() -> (AppState, String, String) {
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([3u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("Alpha", "alpha", "/w/alpha").unwrap();
        state
            .inner
            .db
            .transaction(|c| {
                c.execute("INSERT INTO projects (id, slug, name, root_path, created_at, updated_at) VALUES ('proj-beta', 'beta', 'Beta', '/w/beta', 1, 1)", [])?;
                c.execute("INSERT INTO projects (id, slug, name, root_path, archived, created_at, updated_at) VALUES ('proj-old', 'old', 'Old', '/w/old', 1, 2, 2)", [])?;
                Ok::<_, DbError>(())
            })
            .unwrap();
        for pid in ["proj-alpha", "proj-beta"] {
            crate::team::complete_welcome(&state, pid, &[json!({ "templateId": "dev" })]).unwrap();
        }
        (state, "proj-alpha".into(), "proj-beta".into())
    }

    fn first_seat(state: &AppState, pid: &str) -> Value {
        crate::team::load(state, pid).unwrap().team[0].clone()
    }

    fn tick(state: &AppState, pid: &str, names: Value) {
        let id = first_seat(state, pid)["id"].as_str().unwrap().to_owned();
        crate::team_edit::edit_seat(state, pid, &id, |seat| {
            seat["mcp"] = names;
            Ok(())
        })
        .unwrap();
    }

    fn key(state: &AppState, pid: &str, name: &str) -> Option<String> {
        crate::runtime::vault_secret(state, &mcp_secret_id(pid, name)).unwrap()
    }

    #[test]
    fn boot_migration_copies_every_hq_wide_server_and_key_into_every_live_project() {
        let (state, a, b) = two_projects();
        let old = json!([
            { "name": "docs", "url": "https://docs.example/mcp", "hasKey": true, "status": "ready", "error": null, "checkedAt": "2026-11-01T00:00:00Z" },
            { "name": "open", "url": "https://open.example/mcp", "hasKey": false },
        ]);
        save_setting(&state, "mcpServers", &old).unwrap();
        state.store_vault_secret(Some("mcp-docs"), "mcp", "mcp", "docs", "docs-key").unwrap();
        tick(&state, &a, json!(["docs"]));

        migrate_hq_wide_tool_servers(&state).unwrap();
        for pid in [&a, &b] {
            let servers = tool_servers(&state, pid);
            assert_eq!(servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["docs", "open"], "every server reaches {pid}");
            assert_eq!(servers[0].check, Some(ToolServerCheck { ok: true, error: None, at: "2026-11-01T00:00:00Z".into() }), "the last check carries over");
            assert!(servers[0].has_key && !servers[1].has_key);
            assert_eq!(key(&state, pid, "docs").as_deref(), Some("docs-key"), "the key is copied to {pid}");
        }
        assert!(tool_servers(&state, "proj-old").is_empty(), "archived projects are skipped");
        assert!(setting(&state, "mcpServers").is_none(), "the HQ-wide list is gone");
        assert!(state.inner.vault_secrets.get_by_id("mcp-docs").unwrap().is_none(), "the HQ-wide key is gone");
        assert_eq!(first_seat(&state, &a)["mcp"], json!(["docs"]), "seat selections are untouched");

        let before = tool_servers(&state, &a);
        migrate_hq_wide_tool_servers(&state).unwrap();
        assert_eq!(tool_servers(&state, &a), before, "a second run changes nothing");
    }

    #[test]
    fn boot_migration_keeps_the_hq_wide_data_when_a_key_copy_fails() {
        let (state, a, _) = two_projects();
        save_setting(&state, "mcpServers", &json!([{ "name": "docs", "url": "https://docs.example/mcp", "hasKey": true }])).unwrap();
        state.inner.vault_secrets.upsert("mcp-docs", "mcp", "mcp", "docs", "not-a-sealed-value").unwrap();

        assert!(migrate_hq_wide_tool_servers(&state).is_err());
        assert!(setting(&state, "mcpServers").is_some() && state.inner.vault_secrets.get_by_id("mcp-docs").unwrap().is_some(), "nothing old is deleted");

        state.store_vault_secret(Some("mcp-docs"), "mcp", "mcp", "docs", "docs-key").unwrap();
        migrate_hq_wide_tool_servers(&state).unwrap();
        assert_eq!(key(&state, &a, "docs").as_deref(), Some("docs-key"), "the rerun at next boot finishes the move");
        assert_eq!(tool_servers(&state, &a).len(), 1, "the rerun doesn't duplicate entries");
    }

    #[test]
    fn removing_a_server_touches_only_its_own_project() {
        // Bug: removal used to clear only the current project's seats, leaving dangling names elsewhere that a
        // later server with the same name would silently fill.
        let (state, a, b) = two_projects();
        add_mcp(&state, &a, &[json!({ "name": "docs", "url": "https://a.example/mcp", "apiKey": "key-a" })]).unwrap();
        add_mcp(&state, &b, &[json!({ "name": "docs", "url": "https://b.example/mcp", "apiKey": "key-b" })]).unwrap();
        tick(&state, &a, json!(["docs"]));
        tick(&state, &b, json!(["docs"]));

        remove_mcp(&state, &a, &[json!("docs")]).unwrap();
        assert_eq!(first_seat(&state, &a)["mcp"], json!([]), "the removed name leaves this project's seats");
        assert_eq!(key(&state, &a, "docs"), None, "and its key goes");
        add_mcp(&state, &a, &[json!({ "name": "docs", "url": "https://new.example/mcp" })]).unwrap();
        assert_eq!(first_seat(&state, &a)["mcp"], json!([]), "a new server with the old name isn't picked up silently");
        assert_eq!(first_seat(&state, &b)["mcp"], json!(["docs"]), "the other project keeps its selection");
        assert_eq!(tool_servers(&state, &b)[0].transport, ToolServerTransport::Http { url: "https://b.example/mcp".into() }, "and its own server");
        assert_eq!(key(&state, &b, "docs").as_deref(), Some("key-b"));
    }

    #[test]
    fn adding_a_server_shows_only_in_its_own_project() {
        // Bug: add and remove refreshed only the current project's snapshot while changing a list every project read.
        let (state, a, b) = two_projects();
        add_mcp(&state, &a, &[json!({ "name": "docs", "url": "https://a.example/mcp" })]).unwrap();
        let mcp = |pid: &str| crate::ws::build_initial_snapshot(&state, Some(pid))["snapshot"]["mcp"].clone();
        assert_eq!(mcp(&a)["servers"][0]["name"], "docs");
        assert_eq!(mcp(&a)["others"], json!([]), "a project doesn't offer its own servers for copying");
        assert_eq!(mcp(&b)["servers"], json!([]), "the other project's list is unchanged");
        assert_eq!(mcp(&b)["others"], json!([{ "projectId": a, "project": "Alpha", "name": "docs" }]), "but it can copy the server");
        assert!(set_agent_mcp(&state, &b, &[first_seat(&state, &b)["id"].clone(), json!(["docs"])]).is_ok());
        assert_eq!(first_seat(&state, &b)["mcp"], json!([]), "a seat can't tick another project's server");
    }

    #[test]
    fn copy_from_project_brings_the_entry_and_its_key() {
        let (state, a, b) = two_projects();
        add_mcp(&state, &a, &[json!({ "name": "docs", "url": "https://a.example/mcp", "apiKey": "key-a" })]).unwrap();
        copy_mcp(&state, &b, &[json!(a), json!("docs")]).unwrap();
        let copied = &tool_servers(&state, &b)[0];
        assert_eq!((copied.name.as_str(), copied.has_key, copied.check.is_none()), ("docs", true, true));
        assert_eq!(key(&state, &b, "docs").as_deref(), Some("key-a"));
        assert!(copy_mcp(&state, &b, &[json!(a), json!("docs")]).is_err(), "names stay unique");
        assert!(copy_mcp(&state, &a, &[json!(a), json!("docs")]).is_err(), "a project can't copy from itself");
        assert!(copy_mcp(&state, &b, &[json!("proj-old"), json!("docs")]).is_err(), "archived projects aren't a source");
        remove_mcp(&state, &a, &[json!("docs")]).unwrap();
        assert_eq!(key(&state, &b, "docs").as_deref(), Some("key-a"), "the copy owns its key");
    }

    #[test]
    fn runtime_bound_commands_explain_themselves() {
        assert!(unsupported("openShell").is_some() && unsupported("addToSuite").is_some());
        assert!(unsupported("setEnvVar").is_none());
    }
}
