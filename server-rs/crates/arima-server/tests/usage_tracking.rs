// SPDX-License-Identifier: AGPL-3.0-or-later

//! Usage from an agent's transcript is recorded once, billed only on API-key accounts, and the spend caps stop work.

use std::io::Write;
use std::time::Duration;

use arima_auth::VaultKey;
use arima_db::Db;
use arima_server::{planning, team, usage_watch, AppState, ServerConfig};
use serde_json::json;

fn line(id: &str, input: i64, output: i64) -> String {
    format!(r#"{{"type":"assistant","requestId":"r-{id}","message":{{"id":"{id}","model":"claude-sonnet-4-6","usage":{{"input_tokens":{input},"output_tokens":{output}}}}}}}"#)
}

fn total(state: &AppState, project: &str) -> (i64, f64) {
    state
        .inner
        .db
        .read(|c| {
            c.query_row("SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(cost_usd),0) FROM usage_events WHERE project_id = ?1", [project], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(arima_db::DbError::from)
        })
        .unwrap()
}

#[tokio::test]
async fn transcript_usage_is_recorded_once_priced_only_on_api_accounts_and_capped() {
    let state = AppState::new(Db::open_in_memory().unwrap(), VaultKey::from_bytes([3u8; 32]), ServerConfig::default());
    state.ensure_default_project("Demo", "demo", "/workspaces/demo").unwrap();
    let pid = state.default_project().unwrap().0;
    team::complete_welcome(&state, &pid, &[json!({ "projectName": "Demo", "templateId": "dev", "reviewTool": "human", "reviewEnabled": false })]).unwrap();

    let slug = team::project_slug(&state, &pid).unwrap();
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(state.inner.db.clone(), VaultKey::from_bytes([3u8; 32]), ServerConfig { data_root: Some(tmp.path().to_path_buf()), ..ServerConfig::default() });
    let root = state.inner.runtime.config.workspaces_root.clone();
    let ws = root.join(&slug).join("cipher");
    let dir = ws.join(".agent-home/.claude/projects/-workspace");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("old.jsonl"), format!("{}\n", line("old", 999, 1))).unwrap();

    // The same transcript format on an agent that bills an API-key account is priced.
    arima_server::team_edit::update_agent(&state, &pid, &[json!("ghost"), json!({ "account": "work" })]).unwrap();
    let gdir = root.join(&slug).join("ghost").join(".agent-home/.claude/projects/-workspace");
    std::fs::create_dir_all(&gdir).unwrap();

    usage_watch::watch(&state, &pid, "cipher");
    usage_watch::watch(&state, &pid, "ghost");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("new.jsonl")).unwrap();
    writeln!(f, "{}\n{}\n{}", line("m1", 1000, 200), line("m1", 1000, 200), line("m2", 500, 100)).unwrap();
    drop(f);
    std::fs::write(gdir.join("g.jsonl"), format!("{}\n", line("g1", 1_000_000, 0))).unwrap();
    tokio::time::sleep(Duration::from_secs(6)).await;
    let (tokens, cost) = total(&state, &pid);
    assert_eq!(tokens, 1500 + 1_000_000, "history from before the start is skipped; m1 is counted once: {tokens}");
    assert!((cost - 3.0).abs() < 0.01, "1M input tokens on an API account is billed (~$3), the subscription agent's tokens are free: {cost}");

    assert!(usage_watch::cap_message(&state, &pid).is_none());
    state
        .inner
        .db
        .transaction(|c| {
            c.execute("INSERT INTO usage_events (project_id, agent_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, at) VALUES (?1, 'cipher', 'anthropic', 'm', 1, 1, 0, 7.5, ?2)", rusqlite::params![pid, chrono::Utc::now().timestamp_millis()])?;
            Ok::<_, arima_db::DbError>(())
        })
        .unwrap();
    let msg = usage_watch::cap_message(&state, &pid).expect("the default $5 daily cap is passed");
    assert!(msg.contains("daily spend cap"), "{msg}");
    planning::set_spend_caps(&state, &pid, &[json!({ "dailyUsd": 20, "monthlyUsd": 100 })]).unwrap();
    assert!(usage_watch::cap_message(&state, &pid).is_none(), "raising the cap lifts the block");
}
