// SPDX-License-Identifier: AGPL-3.0-or-later

//! Roster, workflow and project edits on a project's team config (`updateAgent`, `addAgent`, `removeAgent`,
//! `setTeamMode`, `updateWorkflow`, `updateProject`) plus `assignTask`. Every edit loads the stored
//! [`TeamModel`], changes it, saves it and broadcasts a fresh snapshot, so all clients converge.

use arima_db::DbError;
use chrono::Utc;
use serde_json::{json, Map, Value};

use crate::state::AppState;
use crate::team::{resolve_seat, TeamModel};

const NO_TEMPLATE: &str = "This project has no team yet. Pick a team first.";
const SEAT_KEYS: [&str; 11] = ["id", "name", "roleId", "color", "mode", "nextMode", "account", "workspacePath", "sandbox", "mcp", "engine"];
const MODES: [&str; 3] = ["local", "sandbox", "container"];

fn text(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").trim().chars().take(max).collect()
}

fn is_mode(v: &Value) -> bool {
    v.as_str().is_some_and(|m| MODES.contains(&m))
}

fn seat_of(agent: &Value) -> Value {
    let mut seat = Map::new();
    for key in SEAT_KEYS {
        if let Some(v) = agent.get(key) {
            seat.insert(key.into(), v.clone());
        }
    }
    Value::Object(seat)
}

/// A mode change applies now when the agent is down, else waits as `nextMode` so a running agent never switches mid-task.
fn change_mode(seat: &mut Value, mode: &Value, running: bool) {
    if !running || seat["mode"] == *mode {
        seat["mode"] = mode.clone();
        if let Some(o) = seat.as_object_mut() {
            o.remove("nextMode");
        }
    } else {
        seat["nextMode"] = mode.clone();
    }
}

fn agent_index(model: &TeamModel, id: &str) -> Option<usize> {
    model.team.iter().position(|a| a["id"] == id)
}

fn running(state: &AppState, project_id: &str) -> Vec<String> {
    state.inner.supervisor.load_desired_running(project_id).unwrap_or_default()
}

fn rebuild(model: &mut TeamModel, idx: usize, seat: &Value) {
    let mut resolved = resolve_seat(&model.template, seat);
    if resolved["account"] == "" {
        if let Some(o) = resolved.as_object_mut() {
            o.remove("account");
        }
    }
    model.team[idx] = resolved;
}

/// Loads, edits, saves and broadcasts. `f` may also run SQL on `conn`, inside the same transaction.
pub(crate) fn mutate(
    state: &AppState,
    project_id: &str,
    f: impl FnOnce(&mut TeamModel, &rusqlite::Connection) -> Result<(), String>,
) -> Result<(), String> {
    let mut model = crate::team::load(state, project_id).ok_or(NO_TEMPLATE)?;
    state
        .inner
        .db
        .transaction(|conn| {
            f(&mut model, conn).map_err(DbError::InvalidInput)?;
            crate::team::save(conn, project_id, &model)
        })
        .map_err(|e: DbError| match e {
            DbError::InvalidInput(msg) => msg,
            other => other.to_string(),
        })?;
    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
    Ok(())
}

pub fn update_agent(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 80);
    let patch = args.get(1).cloned().unwrap_or(Value::Null);
    let up = running(state, project_id).contains(&id);
    mutate(state, project_id, |model, _| {
        let idx = agent_index(model, &id).ok_or_else(|| format!("No agent \"{id}\"."))?;
        let mut seat = seat_of(&model.team[idx]);
        let is_lead = model.team[idx]["isLead"] == true;
        let name = text(&patch["name"], 40);
        if !name.is_empty() {
            seat["name"] = json!(name);
        }
        if let Some(color) = patch["color"].as_str() {
            seat["color"] = json!(color.chars().take(20).collect::<String>());
        }
        if is_mode(&patch["mode"]) {
            change_mode(&mut seat, &patch["mode"], up);
        }
        let worker_role = patch["roleId"].as_str().filter(|r| {
            model.template["roles"].as_array().is_some_and(|rs| rs.iter().any(|x| x["id"] == *r && x["isLead"] != true))
        });
        if let (Some(role), false) = (worker_role, is_lead) {
            seat["roleId"] = json!(role);
        }
        if let Some(account) = patch["account"].as_str() {
            let acct = account.trim();
            seat["account"] = json!(if acct == "default" { "" } else { acct });
        }
        if patch.get("workspacePath").is_some() {
            let path = text(&patch["workspacePath"], 500);
            seat["workspacePath"] = if path.is_empty() { Value::Null } else { json!(path) };
        }
        match patch["engine"].as_str() {
            Some("stream") => seat["engine"] = json!("stream"),
            Some("terminal") => {
                if let Some(o) = seat.as_object_mut() {
                    o.remove("engine");
                }
            }
            _ => {}
        }
        rebuild(model, idx, &seat);
        Ok(())
    })
}

pub fn add_agent(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    mutate(state, project_id, |model, _| {
        let role = model.template["roles"]
            .as_array()
            .and_then(|rs| rs.iter().find(|r| r["id"] == input["roleId"] && r["isLead"] != true))
            .cloned()
            .ok_or("Pick a role from the project's template for the new agent (the lead's seat is taken).")?;
        let raw_name = text(&input["name"], 40);
        let name = if raw_name.is_empty() { "Agent".to_owned() } else { raw_name };
        let base = crate::team::slugify(&name);
        let mut id = base.clone();
        let mut n = 2;
        while model.team.iter().any(|a| a["id"] == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        let taken: Vec<String> = model.team.iter().filter_map(|a| a["color"].as_str().map(str::to_owned)).collect();
        let sandbox = model.team.iter().find(|a| a["isLead"] == true).map_or_else(
            || json!({ "resources": { "cpus": null, "memoryGb": null }, "allow": [], "deny": [] }),
            |lead| lead["sandbox"].clone(),
        );
        let seat = json!({
            "id": id, "name": name, "roleId": role["id"], "color": crate::team::free_color(role["color"].as_str().unwrap_or("#818cf8"), &taken),
            "mode": if is_mode(&input["mode"]) { input["mode"].clone() } else { model.team.first().map_or_else(|| json!("container"), |lead| lead["mode"].clone()) },
            "account": "", "workspacePath": null, "sandbox": sandbox, "mcp": []
        });
        model.team.push(resolve_seat(&model.template, &seat));
        Ok(())
    })
}

pub async fn remove_agent(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 80);
    let known = crate::team::load(state, project_id).is_some_and(|m| m.team.iter().any(|a| a["id"] == id && a["isLead"] != true));
    if known {
        let _ = state.inner.supervisor.stop_agent(project_id, &id).await;
        let _ = state.inner.runtime.stop(state, project_id, &id).await;
    }
    mutate(state, project_id, |model, conn| {
        let idx = agent_index(model, &id).ok_or_else(|| format!("No agent \"{id}\"."))?;
        if model.team[idx]["isLead"] == true {
            return Err("The lead can't be removed.".into());
        }
        model.team.remove(idx);
        conn.execute(
            "UPDATE tasks SET owner_id = NULL, status = CASE status WHEN 'in-progress' THEN 'todo' ELSE status END, updated_at = ?1
             WHERE project_id = ?2 AND owner_id = ?3 AND status <> 'done'",
            rusqlite::params![Utc::now().timestamp_millis(), project_id, id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM agent_secrets WHERE project_id = ?1 AND agent_id = ?2", rusqlite::params![project_id, id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM mcp_tokens WHERE project_id = ?1 AND agent_id = ?2", rusqlite::params![project_id, id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub fn set_team_mode(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let mode = args.first().cloned().unwrap_or(Value::Null);
    if !is_mode(&mode) {
        return Err("Mode is local, sandbox or container.".into());
    }
    let up = running(state, project_id);
    mutate(state, project_id, |model, _| {
        for idx in 0..model.team.len() {
            let mut seat = seat_of(&model.team[idx]);
            let is_up = model.team[idx]["id"].as_str().is_some_and(|id| up.iter().any(|u| u == id));
            change_mode(&mut seat, &mode, is_up);
            rebuild(model, idx, &seat);
        }
        Ok(())
    })
}


fn is_cli(v: &Value) -> bool {
    v.as_str().and_then(crate::cli::adapter).is_some()
}

/// Structural checks every template must pass: one lead, unique ids, valid CLIs and a flow.
pub(crate) fn validate_template(template: &Value) -> Result<(), String> {
    let roles = template["roles"].as_array().ok_or("A template needs roles.")?;
    if roles.iter().filter(|r| r["isLead"] == true).count() != 1 {
        return Err("A template needs exactly one lead role.".into());
    }
    let mut ids: Vec<&str> = roles.iter().filter_map(|r| r["id"].as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != roles.len() {
        return Err("Role ids must be unique.".into());
    }
    if let Some(bad) = roles.iter().find(|r| !is_cli(&r["cli"])) {
        return Err(format!("Role \"{}\" has no valid CLI.", bad["id"].as_str().unwrap_or("?")));
    }
    if !template["flow"]["stages"].is_array() {
        return Err("A template needs a flow with stages.".into());
    }
    Ok(())
}

/// Replaces the project's template and re-resolves every seat from it. A seat whose role is gone blocks the change.
fn set_template(model: &mut TeamModel, template: Value) -> Result<(), String> {
    validate_template(&template)?;
    let ids: Vec<&str> = template["roles"].as_array().into_iter().flatten().filter_map(|r| r["id"].as_str()).collect();
    if let Some(orphan) = model.team.iter().find(|a| a["roleId"].as_str().is_some_and(|r| !ids.contains(&r))) {
        return Err(format!("{} still sits in a role this template removes.", orphan["name"].as_str().unwrap_or("An agent")));
    }
    model.rules = template["rules"].clone();
    model.workflow["mode"] = json!(crate::team::flow_mode(&template));
    model.template = template;
    for idx in 0..model.team.len() {
        let seat = seat_of(&model.team[idx]);
        rebuild(model, idx, &seat);
    }
    Ok(())
}

/// Edits one agent's seat and re-resolves it from its role.
pub(crate) fn edit_seat(state: &AppState, project_id: &str, id: &str, f: impl FnOnce(&mut Value) -> Result<(), String>) -> Result<(), String> {
    mutate(state, project_id, |model, _| {
        let idx = agent_index(model, id).ok_or_else(|| format!("No agent \"{id}\"."))?;
        let mut seat = seat_of(&model.team[idx]);
        f(&mut seat)?;
        rebuild(model, idx, &seat);
        Ok(())
    })
}

pub fn update_project_template(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let mut next = args.first().cloned().unwrap_or(Value::Null);
    mutate(state, project_id, |model, _| {
        next["id"] = model.template["id"].clone();
        next["version"] = model.template["version"].clone();
        set_template(model, next)
    })
}

pub fn update_role(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let role_id = text(args.first().unwrap_or(&Value::Null), 40);
    let patch = args.get(1).cloned().unwrap_or(Value::Null);
    mutate(state, project_id, |model, _| {
        let mut template = model.template.clone();
        let role = template["roles"]
            .as_array_mut()
            .and_then(|rs| rs.iter_mut().find(|r| r["id"] == role_id))
            .ok_or_else(|| format!("No role \"{role_id}\"."))?;
        for key in ["title", "model", "roleMd", "color"] {
            if let Some(s) = patch[key].as_str() {
                role[key] = json!(s.chars().take(8000).collect::<String>());
            }
        }
        if is_cli(&patch["cli"]) && patch["cli"] != role["cli"] {
            role["cli"] = patch["cli"].clone();
            if !patch["model"].is_string() {
                role["model"] = json!("");
            }
        }
        if let Some(skills) = patch["skills"].as_array() {
            role["skills"] = json!(skills.iter().map(|s| text(s, 80)).filter(|s| !s.is_empty()).collect::<Vec<_>>());
        }
        if let Some(on_demand) = patch["onDemand"].as_bool() {
            role["onDemand"] = json!(on_demand);
        }
        match &patch["capUsd"] {
            Value::Null if patch.get("capUsd").is_some() => {
                role.as_object_mut().map(|o| o.remove("capUsd"));
            }
            v if v.as_f64().is_some_and(|n| n >= 0.0) => role["capUsd"] = v.clone(),
            _ => {}
        }
        match patch["outbound"].as_str() {
            Some(o @ ("none" | "drafts-only")) => role["outbound"] = json!(o),
            _ if patch.get("outbound").is_some_and(Value::is_null) => {
                role.as_object_mut().map(|o| o.remove("outbound"));
            }
            _ => {}
        }
        if patch.get("fallback").is_some_and(Value::is_null) {
            role["fallback"] = Value::Null;
        } else if is_cli(&patch["fallback"]["cli"]) {
            role["fallback"] = json!({ "cli": patch["fallback"]["cli"], "model": text(&patch["fallback"]["model"], 80) });
        }
        set_template(model, template)
    })
}

pub fn update_workflow(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let patch = args.first().cloned().unwrap_or(Value::Null);
    mutate(state, project_id, |model, _| {
        let wf = &mut model.workflow;
        for section in ["review", "deploy"] {
            if let Some(p) = patch[section].as_object() {
                for (k, v) in p {
                    wf[section][k] = v.clone();
                }
            }
        }
        if matches!(patch["merge"]["by"].as_str(), Some("human" | "lead")) {
            wf["merge"]["by"] = patch["merge"]["by"].clone();
        }
        if let Some(clear) = patch["lean"]["clearBetweenTasks"].as_bool() {
            wf["lean"]["clearBetweenTasks"] = json!(clear);
        }
        Ok(())
    })
}

pub fn update_project(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let patch = args.first().cloned().unwrap_or(Value::Null);
    let name = text(&patch["name"], 80);
    mutate(state, project_id, |model, conn| {
        if !name.is_empty() {
            conn.execute(
                "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![name, Utc::now().timestamp_millis(), project_id],
            )
            .map_err(|e| e.to_string())?;
        }
        if !model.project.is_object() {
            model.project = json!({});
        }
        if let Some(office) = patch["officeName"].as_str() {
            let office: String = office.trim().chars().take(19).collect();
            if office.is_empty() {
                model.project.as_object_mut().map(|o| o.remove("officeName"));
            } else {
                model.project["officeName"] = json!(office);
            }
        }
        for flag in ["exportPlan", "crossProject", "standup", "rituals"] {
            if let Some(b) = patch[flag].as_bool() {
                model.project[flag] = json!(b);
            }
        }
        if let Some(charter) = patch["charter"].as_str() {
            let charter: String = charter.trim().chars().take(4000).collect();
            if charter.is_empty() {
                model.project.as_object_mut().map(|o| o.remove("charter"));
            } else {
                model.project["charter"] = json!(charter);
            }
        }
        Ok(())
    })
}

/// Sets a task's owner. The owner must be an agent on this project's team.
pub fn assign_task(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let task_id = text(args.first().unwrap_or(&Value::Null), 40);
    let agent_id = text(args.get(1).unwrap_or(&Value::Null), 80);
    mutate(state, project_id, |model, conn| {
        agent_index(model, &agent_id).ok_or_else(|| format!("No agent \"{agent_id}\"."))?;
        let changed = conn
            .execute(
                "UPDATE tasks SET owner_id = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4",
                rusqlite::params![agent_id, Utc::now().timestamp_millis(), project_id, task_id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("No task \"{task_id}\"."));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_change_waits_for_a_running_agent() {
        let mut seat = json!({ "mode": "local" });
        change_mode(&mut seat, &json!("container"), true);
        assert_eq!((seat["mode"].as_str(), seat["nextMode"].as_str()), (Some("local"), Some("container")));
        change_mode(&mut seat, &json!("container"), false);
        assert_eq!(seat["mode"], "container");
        assert!(seat.get("nextMode").is_none());
    }

    #[test]
    fn seat_keeps_only_seat_fields() {
        let agent = json!({ "id": "a", "name": "A", "role": "Dev", "cli": "claude", "mode": "local", "skills": [] });
        let seat = seat_of(&agent);
        assert!(seat.get("cli").is_none() && seat.get("skills").is_none());
        assert_eq!(seat["name"], "A");
    }
}
