// SPDX-License-Identifier: AGPL-3.0-or-later

//! Team commands end to end against a real database: first-run, roster edits, workflow and task owner.

use arima_auth::VaultKey;
use arima_db::Db;
use arima_server::team::{self, ProjectRow};
use arima_server::team_edit as edit;
use arima_server::{AppState, ServerConfig};
use serde_json::{json, Value};

fn state() -> (AppState, String) {
    let state = AppState::new(Db::open_in_memory().unwrap(), VaultKey::from_bytes([5u8; 32]), ServerConfig::default());
    state.ensure_default_project("Demo", "demo", "/workspaces/demo").unwrap();
    let id = state.default_project().unwrap().0;
    (state, id)
}

fn names(state: &AppState, pid: &str) -> Vec<String> {
    team::load(state, pid).unwrap().team.iter().map(|a| a["name"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn first_run_then_roster_workflow_and_task_edits() {
    let (state, pid) = state();
    assert!(team::load(&state, &pid).is_none(), "welcome is open before a team exists");
    assert!(edit::add_agent(&state, &pid, &[json!({ "roleId": "developer" })]).is_err(), "no edits before first-run");

    team::complete_welcome(&state, &pid, &[json!({ "projectName": "Shop", "templateId": "dev", "reviewTool": "human", "reviewEnabled": false })]).unwrap();
    let model = team::load(&state, &pid).unwrap();
    assert_eq!(model.team.len(), 6);
    assert_eq!(model.team[0]["name"], "Cipher");
    assert_eq!(model.workflow["review"]["enabled"], false);
    assert_eq!(team::boards_for(&state, &pid).len(), 1);
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "research" })]).unwrap();
    assert_eq!(team::load(&state, &pid).unwrap().template["id"], "dev", "a second welcome is ignored");
    assert_eq!(state.default_project().unwrap().2, "Shop");

    assert!(edit::add_agent(&state, &pid, &[json!({ "roleId": "no-such-role" })]).is_err());
    edit::add_agent(&state, &pid, &[json!({ "name": "Ghost Two", "roleId": "developer", "mode": "local" })]).unwrap();
    assert_eq!(team::load(&state, &pid).unwrap().team.len(), 7);
    edit::update_agent(&state, &pid, &[json!("ghost-two"), json!({ "name": "Ada", "mode": "container", "account": "default" })]).unwrap();
    let ada = team::load(&state, &pid).unwrap().team.into_iter().find(|a| a["id"] == "ghost-two").unwrap();
    assert_eq!((ada["name"].as_str(), ada["mode"].as_str()), (Some("Ada"), Some("container")));
    assert!(ada.get("account").is_none(), "the default account is stored as none");

    edit::set_team_mode(&state, &pid, &[json!("local")]).unwrap();
    assert!(team::load(&state, &pid).unwrap().team.iter().all(|a| a["mode"] == "local"));
    assert!(edit::set_team_mode(&state, &pid, &[json!("vm")]).is_err());

    edit::update_workflow(&state, &pid, &[json!({ "review": { "enabled": true }, "merge": { "by": "lead" }, "lean": { "clearBetweenTasks": false } })]).unwrap();
    let wf = team::load(&state, &pid).unwrap().workflow;
    assert_eq!((wf["review"]["enabled"].as_bool(), wf["merge"]["by"].as_str(), wf["lean"]["clearBetweenTasks"].as_bool()), (Some(true), Some("lead"), Some(false)));
    edit::update_project(&state, &pid, &[json!({ "officeName": "Shop HQ", "standup": true, "charter": "Ship small" })]).unwrap();
    let project = team::load(&state, &pid).unwrap().project;
    assert_eq!((project["officeName"].as_str(), project["standup"].as_bool()), (Some("Shop HQ"), Some(true)));

    let board = team::boards_for(&state, &pid)[0]["id"].as_str().unwrap().to_owned();
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, project_id, board_id, stage_id, status, title, created_at, updated_at) VALUES ('T1', ?1, ?2, 'build', 'in-progress', 'Do it', 1, 1)",
                rusqlite::params![pid, board],
            )?;
            Ok::<_, arima_db::DbError>(())
        })
        .unwrap();
    edit::assign_task(&state, &pid, &[json!("T1"), json!("ghost-two")]).unwrap();
    assert_eq!(team::tasks_for(&state, &pid)[0]["ownerId"], "ghost-two");
    assert!(edit::assign_task(&state, &pid, &[json!("T1"), json!("nobody")]).is_err());
    assert!(edit::assign_task(&state, &pid, &[json!("T9"), json!("cipher")]).is_err());

    assert!(edit::remove_agent(&state, &pid, &[json!("cipher")]).await.is_err(), "the lead stays");
    edit::remove_agent(&state, &pid, &[json!("ghost-two")]).await.unwrap();
    assert!(!names(&state, &pid).contains(&"Ada".to_owned()));
    let task = &team::tasks_for(&state, &pid)[0];
    assert_eq!((task["ownerId"].clone(), task["status"].as_str()), (Value::Null, Some("todo")), "a removed owner frees an in-progress task");

    let row = ProjectRow { id: pid.clone(), slug: "demo".into(), name: "Shop".into(), path: "/w".into(), paused: false, archived: false, updated_at_ms: 0 };
    let info = team::project_info(&state, &row);
    assert_eq!(info["counts"]["total"], 1);
    assert_eq!(info["team"].as_array().unwrap().len(), 6);
    assert_eq!(info["templateName"], model.template["name"]);
}
