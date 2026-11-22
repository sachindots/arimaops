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

#[tokio::test]
async fn goals_boards_runtime_spend_company_and_stack() {
    use arima_server::planning as plan;
    let (state, pid) = state();
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    let board = team::boards_for(&state, &pid)[0]["id"].as_str().unwrap().to_owned();
    state
        .inner
        .db
        .transaction(|conn| {
            for (id, status) in [("T1", "done"), ("T2", "todo")] {
                conn.execute(
                    "INSERT INTO tasks (id, project_id, board_id, stage_id, status, title, created_at, updated_at) VALUES (?1, ?2, ?3, 'build', ?4, 'x', 1, 1)",
                    rusqlite::params![id, pid, board, status],
                )?;
            }
            conn.execute(
                "INSERT INTO usage_events (project_id, agent_id, task_id, provider, model, cost_usd, at) VALUES (?1, 'cipher', 'T1', 'anthropic', 'm', 1.25, ?2)",
                rusqlite::params![pid, chrono::Utc::now().timestamp_millis()],
            )?;
            Ok::<_, arima_db::DbError>(())
        })
        .unwrap();

    assert!(plan::add_goal(&state, &pid, &[json!({ "title": "  " })]).is_err());
    plan::add_goal(&state, &pid, &[json!({ "title": "Reach MRR", "metric": "MRR", "target": "$5k", "current": "$3.2k" })]).unwrap();
    plan::add_goal(&state, &pid, &[json!({ "title": "Second" })]).unwrap();
    assert_eq!(plan::goals_for(&state, &pid).iter().map(|g| g["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>(), ["G1", "G2"]);
    plan::set_task_goal(&state, &pid, &[json!("T1"), json!("G1")]).unwrap();
    plan::set_task_goal(&state, &pid, &[json!("T2"), json!("G1")]).unwrap();
    assert!(plan::set_task_goal(&state, &pid, &[json!("T2"), json!("G9")]).is_err());
    let g1 = plan::goals_for(&state, &pid).remove(0);
    assert_eq!((g1["total"].as_i64(), g1["done"].as_i64(), g1["usd"].as_f64(), g1["target"].as_str()), (Some(2), Some(1), Some(1.25), Some("$5k")));
    plan::update_goal(&state, &pid, &[json!("G1"), json!({ "current": "$4k", "status": "done", "title": "" })]).unwrap();
    let g1 = plan::goals_for(&state, &pid).remove(0);
    assert_eq!((g1["current"].as_str(), g1["status"].as_str(), g1["title"].as_str()), (Some("$4k"), Some("done"), Some("Reach MRR")));
    plan::set_task_goal(&state, &pid, &[json!("T2"), json!("")]).unwrap();
    assert_eq!(team::tasks_for(&state, &pid)[1]["goalId"], Value::Null);

    plan::update_board(&state, &pid, &[json!(board), json!({ "title": "Sprint 1", "status": "planned" })]).unwrap();
    let b = &team::boards_for(&state, &pid)[0];
    assert_eq!((b["title"].as_str(), b["status"].as_str()), (Some("Sprint 1"), Some("planned")));
    assert!(plan::update_board(&state, &pid, &[json!("nope"), json!({ "title": "x" })]).is_err());

    plan::set_task_runs_on(&state, &pid, &[json!("T2"), json!("codex"), json!("gpt-x")]).unwrap();
    let t2 = &team::tasks_for(&state, &pid)[1];
    assert_eq!((t2["cli"].as_str(), t2["model"].as_str()), (Some("codex"), Some("gpt-x")));
    plan::set_task_runs_on(&state, &pid, &[json!("T2"), json!("bogus"), json!("")]).unwrap();
    assert_eq!(team::tasks_for(&state, &pid)[1]["cli"], Value::Null, "an unknown CLI clears the override");

    assert!(plan::set_spend_caps(&state, &pid, &[json!({ "dailyUsd": 20, "monthlyUsd": 10 })]).is_err());
    plan::set_spend_caps(&state, &pid, &[json!({ "dailyUsd": 1, "monthlyUsd": 100 })]).unwrap();
    let spend = plan::spend_state(&state, &pid, team::load(&state, &pid).unwrap().project.get("spendCaps"));
    assert_eq!((spend["day"]["cap"].as_f64(), spend["day"]["usd"].as_f64(), spend["paused"].as_str()), (Some(1.0), Some(1.25), Some("day")));

    plan::set_company(&state, &pid, &[json!("We build boats.")]).unwrap();
    assert_eq!(plan::company(&state), "We build boats.");
    plan::update_stack(&state, &pid, &[json!({ "frameworks": [{ "id": "next" }], "tools": {} })]).unwrap();
    assert_eq!(team::load(&state, &pid).unwrap().stack.unwrap()["frameworks"][0]["id"], "next");
    plan::update_stack(&state, &pid, &[json!({})]).unwrap();
    assert!(team::load(&state, &pid).unwrap().stack.is_none());
}

#[tokio::test]
async fn role_and_template_edits_reach_every_seat() {
    let (state, pid) = state();
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    edit::update_role(&state, &pid, &[json!("developer"), json!({ "cli": "codex", "title": "Builder", "skills": ["a", " "], "capUsd": 3, "outbound": "none" })]).unwrap();
    let model = team::load(&state, &pid).unwrap();
    let dev: Vec<&Value> = model.team.iter().filter(|a| a["roleId"] == "developer").collect();
    assert_eq!(dev.len(), 2);
    assert!(dev.iter().all(|a| a["cli"] == "codex" && a["role"] == "Builder" && a["model"] == ""), "a CLI change resets the model on both seats");
    let role = model.template["roles"].as_array().unwrap().iter().find(|r| r["id"] == "developer").unwrap();
    assert_eq!((role["capUsd"].as_f64(), role["outbound"].as_str(), role["skills"].as_array().unwrap().len()), (Some(3.0), Some("none"), 1));
    edit::update_role(&state, &pid, &[json!("developer"), json!({ "capUsd": null, "outbound": null })]).unwrap();
    let role = team::load(&state, &pid).unwrap().template["roles"].as_array().unwrap().iter().find(|r| r["id"] == "developer").cloned().unwrap();
    assert!(role.get("capUsd").is_none() && role.get("outbound").is_none());
    assert!(edit::update_role(&state, &pid, &[json!("ghost"), json!({})]).is_err());

    let mut next = team::load(&state, &pid).unwrap().template;
    next["name"] = json!("My dev team");
    next["id"] = json!("hijack");
    edit::update_project_template(&state, &pid, &[next.clone()]).unwrap();
    let after = team::load(&state, &pid).unwrap().template;
    assert_eq!((after["name"].as_str(), after["id"].as_str()), (Some("My dev team"), Some("dev")), "the template keeps its id");
    next["roles"].as_array_mut().unwrap().retain(|r| r["id"] != "reviewer");
    assert!(edit::update_project_template(&state, &pid, &[next]).is_err(), "a role still in use can't be removed");
    assert!(edit::update_project_template(&state, &pid, &[json!({ "roles": [] })]).is_err());
}

#[tokio::test]
async fn memory_lessons_and_findings_commands() {
    use arima_db::{CreateFindingInput, CreateMemoryInput};
    use arima_server::memory_cmds as mem;
    let (state, pid) = state();
    let new_mem = |id: &str, mem_type: &str, text: &str, certified: bool| {
        state
            .inner
            .memory
            .insert(&pid, CreateMemoryInput { id: Some(id.into()), mem_type: mem_type.into(), text: text.into(), about: vec![], certified, created_at_ms: None, last_used_at_ms: None })
            .unwrap();
    };
    new_mem("M-1", "Lesson", "Run migrations before the seed", false);
    new_mem("M-2", "Lesson", "Pin the toolchain", false);
    new_mem("M-3", "Decision", "Staging is eu-west", true);

    mem::decide_memories(&state, &pid, &[json!("item"), json!({ "M-1": "certify", "M-2": "reject", "bad id!": "certify", "M-3": "maybe" })]).unwrap();
    assert!(state.inner.memory.get(&pid, "M-1").unwrap().unwrap().certified);
    assert!(state.inner.memory.get(&pid, "M-2").unwrap().is_none(), "a rejected memory is deleted");
    assert!(mem::decide_memories(&state, &pid, &[json!("item")]).is_err());

    mem::promote_lessons(&state, &pid).unwrap();
    let lessons = state.inner.memory.list_promoted_lessons(&pid).unwrap();
    assert_eq!(lessons.len(), 1, "only the certified lesson is promoted, not the decision: {lessons:?}");
    mem::promote_lessons(&state, &pid).unwrap();
    assert_eq!(state.inner.memory.list_promoted_lessons(&pid).unwrap().len(), 1, "promoting twice adds nothing");
    mem::remove_lesson(&state, &pid, &[json!(lessons[0].id)]).unwrap();
    assert!(state.inner.memory.list_promoted_lessons(&pid).unwrap().is_empty());
    assert!(!state.inner.memory.get(&pid, "M-1").unwrap().unwrap().promoted, "removing a lesson frees its memory");
    assert!(mem::remove_lesson(&state, &pid, &[json!("les-nope")]).is_err());

    assert!(mem::keep_out_of_memory(&state, &pid, &[json!("x")]).is_err());
    mem::keep_out_of_memory(&state, &pid, &[json!("Acme Corp")]).unwrap();
    mem::set_memory_extraction(&state, &pid, &[json!({ "enabled": true, "account": "work" })]).unwrap();
    let settings = state.inner.memory.get_settings(&pid).unwrap();
    assert_eq!((settings.keep_out.clone(), settings.extraction.enabled, settings.extraction.account.as_str()), (vec!["Acme Corp".to_owned()], true, "work"));

    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    mem::set_lesson_promotion(&state, &pid, &[json!(false)]).unwrap();
    assert_eq!(team::load(&state, &pid).unwrap().project["lessonsEnabled"], false);

    let finding = state
        .inner
        .findings
        .create_finding(&pid, CreateFindingInput { title: "XSS".into(), target: "app".into(), ..CreateFindingInput::default() })
        .unwrap();
    mem::update_finding(&state, &pid, &[json!(finding.id), json!({ "status": "confirmed", "verified": true, "bogus": 1 })]).unwrap();
    let after = state.inner.findings.get_finding(&pid, &finding.id).unwrap().unwrap();
    assert_eq!((after.status.as_str(), after.verified), ("confirmed", true));
}

#[tokio::test]
async fn secrets_accounts_and_proxy_never_expose_values() {
    use arima_server::secrets as sec;
    let (state, pid) = state();
    team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
    let snap = || arima_server::ws::build_initial_snapshot(&state, Some(&pid)).to_string();

    sec::set_env_var(&state, &pid, &[Value::Null, json!("DATABASE_URL"), json!("postgres://hunter2-project")]).unwrap();
    sec::set_env_var(&state, &pid, &[json!("cipher"), json!("DATABASE_URL"), json!("postgres://hunter2-cipher")]).unwrap();
    sec::set_secret(&state, &pid, &[Value::Null, json!("github"), json!("ghp_supersecretvalue123")]).unwrap();
    assert!(sec::set_env_var(&state, &pid, &[Value::Null, json!("PATH"), json!("/evil")]).is_err());
    assert!(sec::set_env_var(&state, &pid, &[json!("nobody"), json!("X"), json!("v")]).is_err());
    assert!(sec::set_env_var(&state, &pid, &[Value::Null, json!("EMPTY"), json!("")]).is_err());
    assert!(sec::set_secret(&state, &pid, &[Value::Null, json!("not-a-service"), json!("v")]).is_err());

    let raw: String = state.inner.db.read(|c| c.query_row("SELECT group_concat(value_enc) FROM agent_secrets", [], |r| r.get(0)).map_err(arima_db::DbError::from)).unwrap();
    assert!(!raw.contains("hunter2") && !raw.contains("ghp_"), "values are encrypted at rest");
    let json_snap = snap();
    assert!(!json_snap.contains("hunter2") && !json_snap.contains("ghp_super"), "snapshots carry names only");
    let s: Value = serde_json::from_str(&json_snap).unwrap();
    let sbx = &s["snapshot"]["sbx"];
    assert_eq!(sbx["projectEnv"]["keys"], json!(["DATABASE_URL"]));
    assert_eq!(sbx["globalKeys"], json!(["github"]));
    assert_eq!(sbx["agents"]["cipher"]["envFile"]["keys"], json!(["DATABASE_URL"]));

    let env = sec::env_for(&state, &pid, "cipher");
    assert_eq!(env["DATABASE_URL"], "postgres://hunter2-cipher", "an agent's own value wins");
    assert_eq!(env["GH_TOKEN"], "ghp_supersecretvalue123");
    assert_eq!(sec::env_for(&state, &pid, "zero")["DATABASE_URL"], "postgres://hunter2-project");
    sec::remove_env_var(&state, &pid, &[json!("cipher"), json!("DATABASE_URL")]).unwrap();
    assert_eq!(sec::env_for(&state, &pid, "cipher")["DATABASE_URL"], "postgres://hunter2-project");
    sec::remove_secret(&state, &pid, &[Value::Null, json!("github")]).unwrap();
    assert!(!sec::env_for(&state, &pid, "zero").contains_key("GH_TOKEN"));

    assert!(sec::save_account(&state, &pid, &[json!({ "id": "work", "provider": "anthropic" })]).is_err(), "a new account needs a key");
    assert!(sec::save_account(&state, &pid, &[json!({ "id": "bad id!", "provider": "anthropic", "secret": "sk-ant-aaaaaaaaaaaa" })]).is_err());
    assert!(sec::save_account(&state, &pid, &[json!({ "id": "bed", "provider": "bedrock", "secret": "not json" })]).is_err());
    sec::save_account(&state, &pid, &[json!({ "id": "work", "provider": "anthropic", "label": "Work", "secret": "sk-ant-api03-abcdWXYZ", "fields": { "region": "x" } })]).unwrap();
    sec::save_account(&state, &pid, &[json!({ "id": "bed", "provider": "bedrock", "secret": "{\"accessKeyId\":\"A\",\"secretAccessKey\":\"B\"}", "fields": { "region": "ap-southeast-2", "junk": "no" } })]).unwrap();
    let accounts = sec::accounts_state(&state);
    let list = accounts["list"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let work = list.iter().find(|a| a["id"] == "work").unwrap();
    assert_eq!((work["secret"]["last4"].as_str(), work["auth"].as_str(), work["fields"].as_object().unwrap().len()), (Some("WXYZ"), Some("api-key"), 0));
    let bed = list.iter().find(|a| a["id"] == "bed").unwrap();
    assert_eq!(bed["fields"], json!({ "region": "ap-southeast-2" }));
    assert!(!accounts.to_string().contains("sk-ant-api03") && !accounts.to_string().contains("secretAccessKey"));
    sec::save_account(&state, &pid, &[json!({ "id": "work", "provider": "anthropic", "label": "Renamed" })]).unwrap();
    let after = sec::accounts_state(&state);
    let work = after["list"].as_array().unwrap().iter().find(|a| a["id"] == "work").unwrap().clone();
    assert_eq!((work["label"].as_str(), work["secret"]["last4"].as_str()), (Some("Renamed"), Some("WXYZ")), "an update without a key keeps the key");
    assert!(sec::save_account(&state, &pid, &[json!({ "id": "work", "provider": "openai" })]).is_err());
    sec::remove_account(&state, &pid, &[json!("work")]).unwrap();
    assert!(sec::remove_account(&state, &pid, &[json!("work")]).is_err());
    assert_eq!(sec::accounts_state(&state)["list"].as_array().unwrap().len(), 1);

    assert!(sec::set_proxy(&state, &pid, &[json!("ftp://x")]).is_err());
    sec::set_proxy(&state, &pid, &[json!("http://proxy:3128")]).unwrap();
    assert_eq!(sec::sbx_state(&state, &pid, &[], "now")["proxy"], "http://proxy:3128");
    sec::set_proxy(&state, &pid, &[json!("")]).unwrap();
    assert_eq!(sec::sbx_state(&state, &pid, &[], "now")["proxy"], Value::Null);
    assert!(sec::open_env_file().is_err());

    sec::set_env_var(&state, &pid, &[json!("zero"), json!("TMP"), json!("v")]).unwrap();
    edit::remove_agent(&state, &pid, &[json!("zero")]).await.unwrap();
    let left: i64 = state.inner.db.read(|c| c.query_row("SELECT COUNT(*) FROM agent_secrets WHERE agent_id = 'zero'", [], |r| r.get(0)).map_err(arima_db::DbError::from)).unwrap();
    assert_eq!(left, 0, "removing an agent removes its variables");
}
