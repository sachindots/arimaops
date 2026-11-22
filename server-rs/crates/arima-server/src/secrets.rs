// SPDX-License-Identifier: AGPL-3.0-or-later

//! App variables, service keys, accounts and the sandbox proxy: `setEnvVar`, `removeEnvVar`, `setSecret`,
//! `removeSecret`, `openEnvFile`, `saveAccount`, `removeAccount`, `setProxy`.
//!
//! Values are encrypted with the vault key before they touch SQLite and never leave this module in clear text
//! except through [`env_for`], which the agent launcher calls. Snapshots carry names and the last four
//! characters of an account key, never values.

use std::collections::HashMap;

use arima_db::DbError;
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::state::AppState;

const SERVICE_KEYS: [&str; 13] = ["anthropic", "openai", "github", "google", "groq", "mistral", "openrouter", "xai", "nebius", "copilot", "cursor", "devin", "droid"];
const ACCOUNT_PREFIX: &str = "acct-";
/// Variables that would change how every program in an agent's container loads or finds code.
const BLOCKED_ENV: [&str; 8] = ["PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV"];
/// The variable each well-known service key becomes inside an agent.
const KEY_ENV: [(&str, &str); 8] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("github", "GH_TOKEN"),
    ("google", "GEMINI_API_KEY"),
    ("groq", "GROQ_API_KEY"),
    ("mistral", "MISTRAL_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("xai", "XAI_API_KEY"),
];

fn text(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").trim().chars().take(max).collect()
}

fn broadcast(state: &AppState, project_id: &str) {
    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_project(project_id, &snapshot.to_string());
}

fn db_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn aad(project_id: &str, agent_id: &str, kind: &str, name: &str) -> String {
    format!("agent-secret:{project_id}:{agent_id}:{kind}:{name}")
}

/// `null` means every agent; a string must name an agent on this project's team.
fn scope(state: &AppState, project_id: &str, arg: &Value) -> Result<String, String> {
    match arg {
        Value::Null => Ok(String::new()),
        Value::String(id) => {
            let known = crate::team::load(state, project_id).is_some_and(|m| m.team.iter().any(|a| a["id"] == id.as_str()));
            if known { Ok(id.clone()) } else { Err(format!("No agent \"{id}\".")) }
        }
        _ => Err("Pick an agent or all agents.".into()),
    }
}

fn valid_env_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let ok_start = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if name.len() > 120 || !ok_start || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Variable names use letters, digits and underscores, and don't start with a digit.".into());
    }
    if name.starts_with("ARIMA_") || BLOCKED_ENV.contains(&name) {
        return Err(format!("{name} is reserved and can't be set."));
    }
    Ok(())
}

fn put(state: &AppState, project_id: &str, agent_id: &str, kind: &str, name: &str, value: &str) -> Result<(), String> {
    let enc = state.inner.auth.vault().encrypt(aad(project_id, agent_id, kind, name).as_bytes(), value.as_bytes()).map_err(db_err)?;
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "INSERT INTO agent_secrets (project_id, agent_id, kind, name, value_enc, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(project_id, agent_id, kind, name) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at",
                rusqlite::params![project_id, agent_id, kind, name, enc, Utc::now().timestamp_millis()],
            )?;
            Ok::<_, DbError>(())
        })
        .map_err(db_err)
}

fn drop_row(state: &AppState, project_id: &str, agent_id: &str, kind: &str, name: &str) -> Result<(), String> {
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "DELETE FROM agent_secrets WHERE project_id = ?1 AND agent_id = ?2 AND kind = ?3 AND name = ?4",
                rusqlite::params![project_id, agent_id, kind, name],
            )?;
            Ok::<_, DbError>(())
        })
        .map_err(db_err)
}

pub fn set_env_var(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let agent = scope(state, project_id, args.first().unwrap_or(&Value::Null))?;
    let name = text(args.get(1).unwrap_or(&Value::Null), 120);
    valid_env_name(&name)?;
    let value = args.get(2).and_then(Value::as_str).unwrap_or("");
    if value.is_empty() || value.len() > 20_000 {
        return Err("A variable needs a value of up to 20,000 characters.".into());
    }
    put(state, project_id, &agent, "env", &name, value)?;
    broadcast(state, project_id);
    Ok(())
}

pub fn remove_env_var(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let agent = scope(state, project_id, args.first().unwrap_or(&Value::Null))?;
    drop_row(state, project_id, &agent, "env", &text(args.get(1).unwrap_or(&Value::Null), 120))?;
    broadcast(state, project_id);
    Ok(())
}

pub fn set_secret(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let agent = scope(state, project_id, args.first().unwrap_or(&Value::Null))?;
    let service = text(args.get(1).unwrap_or(&Value::Null), 40);
    if !SERVICE_KEYS.contains(&service.as_str()) {
        return Err(format!("\"{service}\" isn't a service HQ stores keys for."));
    }
    let value = args.get(2).and_then(Value::as_str).unwrap_or("").trim();
    if value.is_empty() {
        return Err("A key can't be empty.".into());
    }
    put(state, project_id, &agent, "key", &service, value)?;
    broadcast(state, project_id);
    Ok(())
}

pub fn remove_secret(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let agent = scope(state, project_id, args.first().unwrap_or(&Value::Null))?;
    let service = text(args.get(1).unwrap_or(&Value::Null), 40);
    if !SERVICE_KEYS.contains(&service.as_str()) {
        return Err(format!("\"{service}\" isn't a service HQ stores keys for."));
    }
    drop_row(state, project_id, &agent, "key", &service)?;
    broadcast(state, project_id);
    Ok(())
}

/// HQ runs on a server, so there is no local editor to open; variables live in the vault.
pub fn open_env_file() -> Result<(), String> {
    Err("There is no env file to open here. Add variables in Settings → Sandbox → App variables.".into())
}

fn names(state: &AppState, project_id: &str, agent_id: &str, kind: &str) -> Vec<String> {
    state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT name FROM agent_secrets WHERE project_id = ?1 AND agent_id = ?2 AND kind = ?3 ORDER BY name ASC")?;
            let rows = stmt.query_map(rusqlite::params![project_id, agent_id, kind], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
        })
        .unwrap_or_default()
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

fn put_setting(conn: &rusqlite::Connection, key: &str, value: &Value) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO server_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        rusqlite::params![key, value.to_string(), Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

/// The sandbox section of the snapshot: names only.
#[must_use]
pub fn sbx_state(state: &AppState, project_id: &str, agent_ids: &[String], checked_at: &str) -> Value {
    let project_env = names(state, project_id, "", "env");
    let mut agents = serde_json::Map::new();
    for id in agent_ids {
        let env = names(state, project_id, id, "env");
        agents.insert(
            id.clone(),
            json!({ "rules": [], "keys": names(state, project_id, id, "key"), "envFile": { "path": "HQ vault", "exists": !env.is_empty(), "keys": env }, "syncError": null, "approvals": [] }),
        );
    }
    json!({
        "basePolicy": "balanced",
        "proxy": setting(state, "sandboxProxy").and_then(|v| v.as_str().map(str::to_owned)),
        "globalKeys": names(state, project_id, "", "key"),
        "projectEnv": { "path": "HQ vault", "exists": !project_env.is_empty(), "keys": project_env },
        "agents": agents,
        "checkedAt": checked_at
    })
}

pub fn set_proxy(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let url = text(args.first().unwrap_or(&Value::Null), 300);
    let valid = (url.starts_with("http://") || url.starts_with("https://")) && url.len() > 8 && !url.contains(char::is_whitespace);
    if !url.is_empty() && !valid {
        return Err("Proxy must be an http(s):// URL".into());
    }
    state
        .inner
        .db
        .transaction(|conn| {
            if url.is_empty() {
                conn.execute("DELETE FROM server_settings WHERE key = 'sandboxProxy'", [])?;
            } else {
                put_setting(conn, "sandboxProxy", &json!(url))?;
            }
            Ok::<_, DbError>(())
        })
        .map_err(db_err)?;
    broadcast(state, project_id);
    Ok(())
}

/// The environment for one agent's container: project-wide values, then the agent's own, then service keys.
/// Called by the launcher; this is the only place values leave the vault.
pub fn env_for(state: &AppState, project_id: &str, agent_id: &str) -> HashMap<String, String> {
    let rows: Vec<(String, String, String, String)> = state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT agent_id, kind, name, value_enc FROM agent_secrets WHERE project_id = ?1 AND agent_id IN ('', ?2) ORDER BY (agent_id <> '') ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_id, agent_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
        })
        .unwrap_or_default();
    let mut env = HashMap::new();
    for (owner, kind, name, enc) in rows {
        let Ok(bytes) = state.inner.auth.vault().decrypt(aad(project_id, &owner, &kind, &name).as_bytes(), &enc) else { continue };
        let Ok(value) = String::from_utf8(bytes) else { continue };
        let var = if kind == "key" { KEY_ENV.iter().find(|(s, _)| *s == name).map(|(_, v)| (*v).to_owned()) } else { Some(name) };
        if let Some(var) = var {
            env.insert(var, value);
        }
    }
    env
}

fn provider_spec(provider: &str) -> Option<Value> {
    crate::team::provider_specs().get(provider).cloned()
}

fn valid_account_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn last4(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() < 12 { "••••".into() } else { chars[chars.len() - 4..].iter().collect() }
}

/// The accounts section of the snapshot: no secret values, only the last four characters of long keys.
#[must_use]
pub fn accounts_state(state: &AppState) -> Value {
    let metas = state.inner.vault_secrets.list_meta().unwrap_or_default();
    let list: Vec<Value> = metas
        .iter()
        .filter(|m| m.scope == "account" && m.id.starts_with(ACCOUNT_PREFIX))
        .filter_map(|m| {
            let id = m.id.trim_start_matches(ACCOUNT_PREFIX).to_owned();
            let spec = provider_spec(&m.provider)?;
            let secret = state
                .inner
                .vault_secrets
                .get_by_id(&m.id)
                .ok()
                .flatten()
                .and_then(|row| state.inner.auth.vault().decrypt(format!("vault-secret:{}", m.id).as_bytes(), &row.secret_enc).ok())
                .and_then(|b| String::from_utf8(b).ok());
            Some(json!({
                "id": id, "provider": m.provider, "auth": spec["auth"], "label": m.label,
                "fields": setting(state, &format!("account-fields:{id}")).unwrap_or_else(|| json!({})),
                "secret": secret.map(|s| json!({ "last4": last4(&s), "updatedAt": m.updated_at }))
            }))
        })
        .collect();
    json!({ "list": list, "masterSource": "file" })
}

pub fn save_account(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let id = text(&input["id"], 40).to_lowercase();
    if !valid_account_id(&id) {
        return Err("An account id uses lowercase letters, digits and dashes.".into());
    }
    let provider = text(&input["provider"], 40);
    let spec = provider_spec(&provider).ok_or_else(|| format!("\"{provider}\" isn't a provider HQ knows."))?;
    let label = Some(text(&input["label"], 80)).filter(|l| !l.is_empty()).unwrap_or_else(|| spec["label"].as_str().unwrap_or(&provider).to_owned());
    let declared: Vec<&str> = spec["fields"].as_array().map(|f| f.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut fields = serde_json::Map::new();
    for key in declared {
        let v = text(&input["fields"][key], 200);
        if !v.is_empty() {
            fields.insert(key.to_owned(), json!(v));
        }
    }
    let vault_id = format!("{ACCOUNT_PREFIX}{id}");
    let secret = input["secret"].as_str().map(str::trim).unwrap_or("");
    let existing = state.inner.vault_secrets.get_by_id(&vault_id).map_err(db_err)?;
    if !secret.is_empty() {
        if spec["auth"] == "cloud" && !serde_json::from_str::<Value>(secret).is_ok_and(|v| v.is_object()) {
            return Err("These credentials aren't a JSON object.".into());
        }
        state.store_vault_secret(Some(&vault_id), "account", &provider, &label, secret).map_err(db_err)?;
    } else {
        let row = existing.ok_or("A new account needs its key.")?;
        if row.provider != provider {
            return Err("Changing an account's provider needs a new key.".into());
        }
        state.inner.vault_secrets.upsert(&vault_id, "account", &provider, &label, &row.secret_enc).map_err(db_err)?;
    }
    state.inner.db.transaction(|conn| put_setting(conn, &format!("account-fields:{id}"), &Value::Object(fields))).map_err(db_err)?;
    broadcast(state, project_id);
    Ok(())
}

pub fn remove_account(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 40);
    let vault_id = format!("{ACCOUNT_PREFIX}{id}");
    if !state.inner.vault_secrets.delete(&vault_id).map_err(db_err)? {
        return Err(format!("No account \"{id}\"."));
    }
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute("DELETE FROM server_settings WHERE key = ?1", [format!("account-fields:{id}")])?;
            Ok::<_, DbError>(())
        })
        .map_err(db_err)?;
    broadcast(state, project_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_names_follow_shell_rules_and_block_loader_variables() {
        assert!(valid_env_name("DATABASE_URL").is_ok());
        assert!(valid_env_name("_x1").is_ok());
        for bad in ["1A", "A-B", "", "PATH", "LD_PRELOAD", "ARIMA_TOKEN"] {
            assert!(valid_env_name(bad).is_err(), "{bad} is rejected");
        }
    }

    #[test]
    fn last4_hides_short_secrets() {
        assert_eq!(last4("sk-ant-api-abcdWXYZ"), "WXYZ");
        assert_eq!(last4("short"), "••••");
    }

    #[test]
    fn account_ids_are_lowercase_slugs() {
        assert!(valid_account_id("work-2"));
        assert!(!valid_account_id("Work"));
        assert!(!valid_account_id("-x"));
    }
}
