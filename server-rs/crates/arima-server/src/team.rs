// SPDX-License-Identifier: AGPL-3.0-or-later

//! Team model: the built-in templates, seat resolution and the per-project team config.
//!
//! Templates and agent configs stay as JSON because `src/data/types.ts` owns their shape; this module
//! reads only the few fields it needs. The config lives in `projects.config_json["team"]`, next to the
//! other namespaced keys (`githubSync`, `scope`, `memorySettings`).

use std::sync::OnceLock;

use arima_db::DbError;
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::state::AppState;

const TEAM_DATA: &str = include_str!("../assets/team-data.json");
const CONFIG_KEY: &str = "team";

fn data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(TEAM_DATA).expect("assets/team-data.json is valid JSON"))
}

/// Built-in templates in library order, shaped as `TemplateEntry` for the welcome picker.
#[must_use]
pub fn template_library() -> Vec<Value> {
    data()["templates"]
        .as_array()
        .map(|ts| ts.iter().map(|t| json!({ "template": t, "builtin": true, "problems": [] })).collect())
        .unwrap_or_default()
}

/// The model providers an account can be for, with the non-secret fields each needs.
#[must_use]
pub fn provider_specs() -> &'static Value {
    &data()["providers"]
}

fn template_by_id(id: &str) -> Option<&'static Value> {
    data()["templates"].as_array()?.iter().find(|t| t["id"] == id)
}

/// Persisted team config for one project. Absent means the first-run welcome is still open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamModel {
    pub template: Value,
    pub team: Vec<Value>,
    pub workflow: Value,
    pub rules: Value,
    pub stack: Option<Value>,
    /// Project settings HQ keeps beyond the name and path: officeName, charter, standup, rituals, exportPlan, crossProject.
    #[serde(default)]
    pub project: Value,
}

pub(crate) fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() { "project".into() } else { trimmed.to_owned() }
}

pub(crate) fn free_color(want: &str, taken: &[String]) -> String {
    if !taken.iter().any(|c| c == want) {
        return want.to_owned();
    }
    let palette: Vec<&str> = data()["palette"].as_array().map(|p| p.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    palette
        .iter()
        .find(|c| !taken.iter().any(|t| t == **c))
        .or_else(|| palette.get(taken.len() % palette.len().max(1)))
        .map_or_else(|| want.to_owned(), |c| (*c).to_owned())
}

fn next_worker_name(taken: &[String]) -> String {
    let used: Vec<String> = taken.iter().map(|n| n.trim().to_lowercase()).collect();
    data()["workerNames"]
        .as_array()
        .and_then(|ns| ns.iter().filter_map(Value::as_str).find(|n| !used.contains(&n.to_lowercase())))
        .map_or_else(|| format!("Agent {}", taken.len() + 1), str::to_owned)
}

fn role_of<'a>(template: &'a Value, role_id: &str) -> Option<&'a Value> {
    template["roles"].as_array()?.iter().find(|r| r["id"] == role_id)
}

/// The seats a new project starts with: each role's seat count, the lead first, with default names.
#[must_use]
pub fn seats_for(template: &Value, mode: &str) -> Vec<Value> {
    let lead_name = data()["leadName"].as_str().unwrap_or("Lead");
    let mut roles: Vec<&Value> = template["roles"].as_array().map(|r| r.iter().collect()).unwrap_or_default();
    roles.sort_by_key(|r| !r["isLead"].as_bool().unwrap_or(false));
    let mut names: Vec<String> = Vec::new();
    let mut colors: Vec<String> = Vec::new();
    let mut seats = Vec::new();
    for role in roles {
        for _ in 0..role["seats"].as_u64().unwrap_or(0) {
            let is_lead = role["isLead"].as_bool().unwrap_or(false);
            let name = if is_lead && !names.iter().any(|n| n == lead_name) { lead_name.to_owned() } else { next_worker_name(&names) };
            names.push(name.clone());
            let color = free_color(role["color"].as_str().unwrap_or("#818cf8"), &colors);
            colors.push(color.clone());
            seats.push(json!({
                "id": slugify(&name), "name": name, "roleId": role["id"], "color": color, "mode": mode,
                "account": "", "workspacePath": null,
                "sandbox": { "resources": { "cpus": null, "memoryGb": null }, "allow": [], "deny": [] },
                "mcp": []
            }));
        }
    }
    seats
}

/// The agent HQ runs for a seat: the seat plus its role's title, CLI, model, skills and role text.
#[must_use]
pub fn resolve_seat(template: &Value, seat: &Value) -> Value {
    let mut out: Map<String, Value> = seat.as_object().cloned().unwrap_or_default();
    if let Some(role) = seat["roleId"].as_str().and_then(|id| role_of(template, id)) {
        out.insert("role".into(), role["title"].clone());
        for key in ["isLead", "cli", "model", "skills", "roleMd"] {
            out.insert(key.into(), role[key].clone());
        }
    }
    Value::Object(out)
}

pub(crate) fn flow_mode(template: &Value) -> &'static str {
    let waits_for_merge = template["flow"]["stages"].as_array().is_some_and(|stages| {
        stages.iter().any(|s| s["gates"].as_array().is_some_and(|g| g.iter().any(|g| g["kind"] == "pr-merged")))
    });
    if waits_for_merge { "github-pr" } else { "deliverables" }
}

/// Where new agents can run: containers when HQ can reach Docker, else on HQ's own host.
fn default_agent_mode(state: &AppState) -> &'static str {
    if state.inner.runtime.config.enabled { "container" } else { "local" }
}

/// A project's folder-safe name.
#[must_use]
pub fn project_slug(state: &AppState, project_id: &str) -> Option<String> {
    state
        .inner
        .db
        .read(|conn| conn.query_row("SELECT slug FROM projects WHERE id = ?1", [project_id], |r| r.get::<_, String>(0)).optional().map_err(DbError::from))
        .ok()
        .flatten()
}

/// `AgentStatus` for an agent that has not started.
#[must_use]
pub fn fresh_status(agent_id: &str) -> Value {
    json!({
        "agentId": agent_id, "state": "idle", "currentTaskId": null, "stateSince": Utc::now().to_rfc3339(),
        "note": "Not started", "session": { "state": "stopped", "detail": null, "workspace": null, "sandbox": null }
    })
}

/// Loads the project's team config, or `None` while the welcome is still open.
pub fn load(state: &AppState, project_id: &str) -> Option<TeamModel> {
    let raw: Option<String> = state
        .inner
        .db
        .read(|conn| {
            conn.query_row("SELECT config_json FROM projects WHERE id = ?1", [project_id], |r| r.get(0))
                .optional()
                .map_err(DbError::from)
        })
        .ok()
        .flatten();
    let root: Value = serde_json::from_str(&raw?).ok()?;
    serde_json::from_value(root.get(CONFIG_KEY)?.clone()).ok()
}

pub(crate) fn save(conn: &rusqlite::Connection, project_id: &str, model: &TeamModel) -> Result<(), DbError> {
    let raw: String = conn.query_row("SELECT config_json FROM projects WHERE id = ?1", [project_id], |r| r.get(0))?;
    let mut root: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    root[CONFIG_KEY] = serde_json::to_value(model).map_err(|e| DbError::InvalidInput(e.to_string()))?;
    conn.execute(
        "UPDATE projects SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![root.to_string(), Utc::now().timestamp_millis(), project_id],
    )?;
    Ok(())
}

/// SHA-256 of built-in `roleMd` texts that earlier HQ builds shipped (assets/team-data.json at c8b6f86 and
/// 576d527) and that name tools the tool server no longer runs, with the (template, role) whose current text
/// replaces them. Roles shared across templates had one text, so one entry covers all of them.
const RETIRED_ROLE_MD: &[(&str, &str, &str)] = &[
    ("0228e26a3b1929545b6f8cfb37d5d8da6447c2657f02a3a145b0970170eccbd8", "dev", "lead"),
    ("e733a652ec2ce7e3f0e6cebf4a6f53af05e4bfd99d5c1d2b366f5e0637615031", "security-red", "lead"),
    ("43bcd278238593cc8993d6942396d52e2e461f37ab2ac2fdbd66268dbf8d6948", "security-red", "recon"),
    ("5a318f1c47c5a7fcd882d53301dde4d0e5760b138b50023c709e329e9943b3cf", "security-red", "exploit"),
    ("04b609cffbc7534c83eab5c921e746ee3269ae0f2f40179a35f5d27425903486", "security-red", "reporter"),
    ("e8331d6f775f06ac90db7e35b82209e5a8cb037e3c5537398022aef1ee0206ee", "security-red", "second-opinion"),
    ("e8430a6e2c9f95df24e2d080c5e3540cd0f33f986c2d5537133a7da19d0bc241", "security-purple", "lead"),
    ("10f2df0d3f153969d05075bda9682a3f74c7c927851ffd353297afaf04262b75", "security-purple", "defender"),
    ("ba425696840b35a651b513c93e24af66a80346c0a0feabf2c27e4513e0d4170f", "security-blue", "lead"),
    ("8d13671b95b7a725552869cf6a2a69ab85695597ba760dae7857a5520ec50deb", "security-blue", "analyst"),
    ("b036b0540175f873787f925e7d3bbc78a87940ca64ed391a071734fb9cabc455", "security-blue", "responder"),
    ("27f405998fa915c32c5edfea72e927be9d185f8b125b531d27f9849d3827873c", "blank", "lead"),
];

/// The current built-in text for a role prompt that still equals a retired built-in version.
fn current_builtin_role_md(role_md: &str) -> Option<&'static Value> {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(role_md.as_bytes()));
    let (_, template_id, role_id) = RETIRED_ROLE_MD.iter().find(|(h, _, _)| *h == digest)?;
    Some(&role_of(template_by_id(template_id)?, role_id)?["roleMd"])
}

/// Every role prompt a team config holds: the template's roles and each seat's resolved copy.
fn role_texts_mut(model: &mut TeamModel) -> impl Iterator<Item = &mut Value> {
    let roles = model.template["roles"].as_array_mut().into_iter().flatten();
    roles.chain(model.team.iter_mut()).filter_map(|v| v.get_mut("roleMd")).filter(|v| v.is_string())
}

/// Boot step: brings every project's untouched built-in role prompts up to the current text, and raises one
/// Inbox notice per project whose edited prompts still name tools HQ doesn't run. Safe to run on every boot.
pub fn refresh_builtin_role_prompts(state: &AppState) {
    let ids: Vec<String> = state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM projects")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
        })
        .unwrap_or_default();
    for pid in ids {
        let Some(mut model) = load(state, &pid) else { continue };
        let mut updated = 0;
        for md in role_texts_mut(&mut model) {
            if let Some(current) = md.as_str().and_then(current_builtin_role_md) {
                *md = current.clone();
                updated += 1;
            }
        }
        if updated > 0 {
            match state.inner.db.transaction(|conn| save(conn, &pid, &model)) {
                Ok(()) => tracing::info!(project = %pid, updated, "refreshed built-in role prompts to the current tool names"),
                Err(e) => tracing::warn!(project = %pid, error = %e, "couldn't refresh built-in role prompts"),
            }
        }
        let mut unknown: Vec<String> = role_texts_mut(&mut model)
            .filter_map(|v| v.as_str())
            .flat_map(|t| crate::mcp::unknown_tool_names(t).into_iter().map(str::to_owned).collect::<Vec<_>>())
            .collect();
        unknown.sort_unstable();
        unknown.dedup();
        if !unknown.is_empty() {
            raise_unknown_tools_notice(state, &pid, &unknown);
        }
    }
}

fn raise_unknown_tools_notice(state: &AppState, project_id: &str, unknown: &[String]) {
    use arima_core::{DecisionPayload, DecisionStatus, VisualDecision};
    // One notice per project, ever: a fixed id, created only if absent, so a dismissed notice stays dismissed.
    let id = format!("dec-role-tools-{project_id}");
    if !matches!(state.inner.decisions.get(&id), Ok(None)) {
        return;
    }
    let names = unknown.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ");
    let decision = VisualDecision {
        id,
        project_id: project_id.to_owned(),
        from_id: "hq".into(),
        task_id: None,
        title: "Edited role prompts name tools HQ doesn't run".into(),
        details: format!("Update these role prompts in Agents: {names}"),
        waiting: false,
        owner_only: true,
        status: DecisionStatus::Open,
        payload: DecisionPayload::Info {
            markdown: format!("Some role prompts in this project were edited and still mention {names}. HQ's tool server no longer runs these tools, so agents that try them get an error. Edit the role prompts in Agents to use the current tool names."),
        },
        note: None,
        created_at: Utc::now().to_rfc3339(),
        closed_at: None,
    };
    match state.inner.decisions.upsert(&decision) {
        Ok(_) => tracing::info!(project = %project_id, tools = %names, "raised an Inbox notice for role prompts naming unknown tools"),
        Err(e) => tracing::warn!(project = %project_id, error = %e, "couldn't raise the unknown-tools notice"),
    }
}

/// Boards of a project in creation order, shaped as the UI's `Board`.
pub fn boards_for(state: &AppState, project_id: &str) -> Vec<Value> {
    state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT id, name, status, spec_version, spec_markdown FROM boards WHERE project_id = ?1 ORDER BY created_at ASC, id ASC")?;
            let rows = stmt.query_map([project_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?))
            })?;
            let mut out = Vec::new();
            for (order, row) in rows.enumerate() {
                let (id, title, status, spec_version, spec_markdown) = row?;
                out.push(json!({ "id": id, "title": title, "status": status, "order": order, "specVersion": spec_version, "specMarkdown": spec_markdown }));
            }
            Ok::<_, DbError>(out)
        })
        .unwrap_or_default()
}

/// Tasks of a project in creation order, shaped as the UI's `Task`.
pub fn tasks_for(state: &AppState, project_id: &str) -> Vec<Value> {
    state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT id, board_id, goal_id, stage_id, status, title, owner_id, pr_number, data_json FROM tasks WHERE project_id = ?1 ORDER BY created_at ASC, id ASC")?;
            let rows = stmt.query_map([project_id], |r| {
                let mut task = json!({
                    "id": r.get::<_, String>(0)?, "boardId": r.get::<_, String>(1)?, "goalId": r.get::<_, Option<String>>(2)?,
                    "stageId": r.get::<_, String>(3)?, "status": r.get::<_, String>(4)?, "title": r.get::<_, String>(5)?,
                    "ownerId": r.get::<_, Option<String>>(6)?, "prNumber": r.get::<_, Option<i64>>(7)?
                });
                // data_json holds the rest of a task (needs, files, cli, model...); the columns above win.
                if let Ok(Value::Object(extra)) = serde_json::from_str::<Value>(&r.get::<_, String>(8)?) {
                    for (k, v) in extra {
                        if task.get(&k).is_none() {
                            task[k] = v;
                        }
                    }
                }
                Ok(task)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
        })
        .unwrap_or_default()
}

/// Task counts by status, as the UI's `ProjectInfo.counts`.
#[must_use]
pub fn task_counts(tasks: &[Value]) -> Value {
    let n = |status: &str| tasks.iter().filter(|t| t["status"] == status).count();
    json!({ "todo": n("todo"), "inProgress": n("in-progress"), "inReview": n("in-review"), "done": n("done"), "blocked": n("blocked"), "total": tasks.len() })
}

/// One row of the project switcher, shaped as the UI's `ProjectInfo`.
pub struct ProjectRow {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub path: String,
    pub paused: bool,
    pub archived: bool,
    pub updated_at_ms: i64,
}

#[must_use]
pub fn project_info(state: &AppState, row: &ProjectRow) -> Value {
    let model = load(state, &row.id);
    let tasks = tasks_for(state, &row.id);
    let counts = task_counts(&tasks);
    let team: Vec<Value> = model
        .as_ref()
        .map(|m| {
            m.team
                .iter()
                .map(|a| json!({ "id": a["id"], "name": a["name"], "roleId": a["roleId"], "role": a["role"], "isLead": a["isLead"], "cli": a["cli"], "model": a["model"] }))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": row.id, "name": row.name, "path": row.path, "repo": row.slug, "hqPort": state.inner.config.port,
        "online": true, "paused": row.paused, "archived": row.archived, "isCurrent": false, "readOnly": false,
        "templateName": model.as_ref().and_then(|m| m.template["name"].as_str()),
        "secure": model.as_ref().is_some_and(|m| m.rules["findings"] == true),
        "workflowMode": model.as_ref().map_or("github-pr", |m| m.workflow["mode"].as_str().unwrap_or("github-pr")),
        "lastUpdatedAt": chrono::DateTime::from_timestamp_millis(row.updated_at_ms).unwrap_or_default().to_rfc3339(),
        "team": team, "boards": boards_for(state, &row.id), "tasks": tasks, "counts": counts, "waiting": 0
    })
}

/// First-run: put the project on a template. A project that already has a team ignores it, as v1 did.
pub fn complete_welcome(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    if load(state, project_id).is_some() {
        return Ok(());
    }
    let input = args.first().cloned().unwrap_or(Value::Null);
    let template_id = input["templateId"].as_str().unwrap_or("");
    let found = template_by_id(template_id).cloned().or_else(|| crate::integrations::custom_template(state, template_id));
    let template = &found.ok_or_else(|| format!("Unknown team template \"{template_id}\"."))?;

    let review_tool = input["reviewTool"].as_str().filter(|t| ["coderabbit", "greptile", "copilot", "human", "custom"].contains(t)).unwrap_or("human");
    let review_enabled = input["reviewEnabled"].as_bool().unwrap_or(true);
    let seats = seats_for(template, default_agent_mode(state));
    let model = TeamModel {
        template: template.clone(),
        team: seats.iter().map(|s| resolve_seat(template, s)).collect(),
        workflow: json!({
            "mode": flow_mode(template),
            "review": { "enabled": review_enabled, "tool": review_tool, "command": "" },
            "merge": { "by": "human" },
            "deploy": { "enabled": false, "tool": "custom", "command": "", "perAgentEnvironments": false }
        }),
        rules: template["rules"].clone(),
        stack: input.get("stack").and_then(crate::planning::clean_stack),
        project: json!({}),
    };
    let name = input["projectName"].as_str().map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(80).collect::<String>());
    let now_ms = Utc::now().timestamp_millis();

    state
        .inner
        .db
        .transaction(|conn| {
            if let Some(name) = &name {
                conn.execute("UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![name, now_ms, project_id])?;
            }
            for board in template["starter"]["boards"].as_array().into_iter().flatten() {
                conn.execute(
                    "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    rusqlite::params![board["id"].as_str().unwrap_or("B1"), project_id, board["title"].as_str().unwrap_or("Backlog"), board["status"].as_str().unwrap_or("active"), now_ms],
                )?;
            }
            save(conn, project_id, &model)
        })
        .map_err(|e: DbError| e.to_string())?;

    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_template_seats_lead_first_with_unique_names_and_resolved_roles() {
        let template = template_by_id("dev").expect("dev template is built in");
        let want: u64 = template["roles"].as_array().unwrap().iter().map(|r| r["seats"].as_u64().unwrap()).sum();
        let seats = seats_for(template, "local");
        assert_eq!(seats.len() as u64, want);
        assert_eq!(seats[0]["name"], "Cipher");
        let mut ids: Vec<&str> = seats.iter().map(|s| s["id"].as_str().unwrap()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), seats.len(), "seat ids are unique");
        let lead = resolve_seat(template, &seats[0]);
        assert_eq!(lead["isLead"], true);
        assert!(lead["cli"].is_string() && lead["role"].is_string());
    }

    #[test]
    fn every_builtin_template_has_one_lead_and_a_board() {
        for entry in template_library() {
            let t = &entry["template"];
            let leads = t["roles"].as_array().unwrap().iter().filter(|r| r["isLead"] == true).count();
            assert_eq!(leads, 1, "template {} has one lead", t["id"]);
            assert!(!t["starter"]["boards"].as_array().unwrap().is_empty(), "template {} starts with a board", t["id"]);
        }
    }

    #[test]
    fn retired_role_texts_point_at_a_current_text_that_is_not_itself_retired() {
        for (_, template_id, role_id) in RETIRED_ROLE_MD {
            let current = role_of(template_by_id(template_id).unwrap(), role_id).unwrap()["roleMd"].as_str().unwrap();
            assert!(current_builtin_role_md(current).is_none(), "{template_id}/{role_id} would be rewritten every boot");
        }
    }

    #[test]
    fn boot_refresh_updates_untouched_built_in_prompts_keeps_edits_and_raises_one_notice() {
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([7u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
        let pid = state.default_project().unwrap().0;
        complete_welcome(&state, &pid, &[json!({ "templateId": "security-red" })]).unwrap();

        let current = role_of(template_by_id("security-red").unwrap(), "recon").unwrap()["roleMd"].as_str().unwrap().to_owned();
        // The recon prompt as 576d527 shipped it: only this line changed.
        let retired = current.replace("send the plan with ask_user (ownerOnly) and wait for the owner's answer.", "submit_plan and wait for the owner.");
        assert_ne!(retired, current);
        let edited = "My own lead prompt: use `create_task` for each target.";
        let mut model = load(&state, &pid).unwrap();
        for role in model.template["roles"].as_array_mut().unwrap().iter_mut().chain(model.team.iter_mut()) {
            match role["roleId"].as_str().or(role["id"].as_str()) {
                Some("recon") => role["roleMd"] = json!(retired),
                Some("lead") => role["roleMd"] = json!(edited),
                _ => {}
            }
        }
        state.inner.db.transaction(|conn| save(conn, &pid, &model)).unwrap();

        refresh_builtin_role_prompts(&state);
        refresh_builtin_role_prompts(&state);

        let model = load(&state, &pid).unwrap();
        let texts = |id: &str| -> Vec<String> {
            model.template["roles"].as_array().unwrap().iter().filter(|r| r["id"] == id)
                .chain(model.team.iter().filter(|s| s["roleId"] == id))
                .map(|r| r["roleMd"].as_str().unwrap().to_owned()).collect()
        };
        let recon = texts("recon");
        assert!(recon.len() >= 2 && recon.iter().all(|t| *t == current), "template role and seat copies are refreshed");
        assert!(texts("lead").iter().all(|t| t == edited), "an edited prompt is never overwritten");

        let notices: Vec<_> = state.inner.decisions.list_by_project(&pid, None).unwrap().into_iter().filter(|d| d.id.starts_with("dec-role-tools-")).collect();
        assert_eq!(notices.len(), 1, "one notice per project across boots");
        assert!(notices[0].details.contains("`create_task`"));
    }

    #[test]
    fn task_counts_total_equals_sum_of_statuses() {
        let tasks = vec![json!({"status": "todo"}), json!({"status": "done"}), json!({"status": "in-review"}), json!({"status": "todo"})];
        let c = task_counts(&tasks);
        assert_eq!((c["todo"].as_u64(), c["done"].as_u64(), c["inReview"].as_u64(), c["total"].as_u64()), (Some(2), Some(1), Some(1), Some(4)));
    }

    #[test]
    fn slugify_matches_v1() {
        assert_eq!(slugify("Cipher"), "cipher");
        assert_eq!(slugify("Agent 4"), "agent-4");
        assert_eq!(slugify("***"), "project");
    }
}
