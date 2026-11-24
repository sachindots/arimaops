// SPDX-License-Identifier: AGPL-3.0-or-later

//! Records what a running agent spends and enforces the project's spend caps.
//!
//! Claude Code writes every turn's token usage to a transcript under its home folder, which is inside the agent's
//! workspace and so visible to HQ. Other CLIs keep different formats and are not tracked yet.
//! Only agents on an API-key account are billed: a subscription sign-in costs nothing per token, so its events
//! are recorded with a cost of 0 and never move a cap.

use std::path::{Path, PathBuf};
use std::time::Duration;

use arima_agents::UsageTailer;
use crate::state::AppState;

const POLL: Duration = Duration::from_secs(5);

fn transcripts(workspace: &Path) -> Vec<PathBuf> {
    let root = workspace.join(".agent-home/.claude/projects");
    let mut out = Vec::new();
    for dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for file in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            if file.path().extension().is_some_and(|e| e == "jsonl") {
                out.push(file.path());
            }
        }
    }
    out
}

/// One pass over the agent's transcripts. Returns how many new events were recorded.
fn record_new(state: &AppState, tailer: &mut UsageTailer, workspace: &Path, project_id: &str, agent_id: &str, account: &str) -> usize {
    let mut n = 0;
    for path in transcripts(workspace) {
        let Ok(events) = tailer.poll_file(&path, project_id, agent_id) else { continue };
        for mut ev in events {
            ev.project_id = project_id.to_owned();
            ev.agent_id = agent_id.to_owned();
            if account.is_empty() {
                ev.cost_usd = 0.0;
            } else {
                ev.account_id = Some(account.to_owned());
            }
            if state.inner.usage.record_usage(&ev).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// Follows a started agent until its session ends, recording usage and stopping the project at its cap.
pub fn watch(state: &AppState, project_id: &str, agent_id: &str) {
    let seat = crate::team::load(state, project_id).and_then(|m| m.team.into_iter().find(|a| a["id"] == agent_id));
    let account = seat.as_ref().and_then(|a| a["account"].as_str()).unwrap_or("").to_owned();
    let slug = crate::team::project_slug(state, project_id).unwrap_or_else(|| project_id.to_owned());
    let workspace = state.inner.runtime.config.workspaces_root.join(slug).join(agent_id);
    let (state, project, agent) = (state.clone(), project_id.to_owned(), agent_id.to_owned());
    tokio::spawn(async move {
        let mut tailer = UsageTailer::new();
        // History from earlier sessions was recorded when they ran: start from the end of what is already there.
        record_new_silent(&mut tailer, &workspace, &project, &agent);
        loop {
            tokio::time::sleep(POLL).await;
            let running = state.inner.runtime.is_running(&project, &agent);
            if record_new(&state, &mut tailer, &workspace, &project, &agent, &account) > 0 {
                enforce_caps(&state, &project).await;
            }
            if !running {
                break;
            }
        }
    });
}

fn record_new_silent(tailer: &mut UsageTailer, workspace: &Path, project_id: &str, agent_id: &str) {
    for path in transcripts(workspace) {
        let _ = tailer.poll_file(&path, project_id, agent_id);
    }
}

/// The message to show when a cap blocks work, or `None` while the project is under both caps.
#[must_use]
pub fn cap_message(state: &AppState, project_id: &str) -> Option<String> {
    let caps = crate::team::load(state, project_id).and_then(|m| m.project.get("spendCaps").cloned());
    let spend = crate::planning::spend_state(state, project_id, caps.as_ref());
    let which = spend["paused"].as_str()?;
    let (usd, cap) = (spend[which]["usd"].as_f64().unwrap_or(0.0), spend[which]["cap"].as_f64().unwrap_or(0.0));
    let (period, until) = if which == "month" { ("monthly", "next month") } else { ("daily", "tomorrow") };
    Some(format!("The {period} spend cap is reached (${usd:.2} of ${cap:.2}). Agents stay stopped until {until}. Raise the cap in Settings, General."))
}

/// Stops every running agent of the project once a cap is reached.
pub async fn enforce_caps(state: &AppState, project_id: &str) {
    let Some(message) = cap_message(state, project_id) else { return };
    let Some(model) = crate::team::load(state, project_id) else { return };
    let mut stopped = false;
    for seat in &model.team {
        let Some(id) = seat["id"].as_str() else { continue };
        if state.inner.runtime.is_running(project_id, id) {
            let _ = state.inner.runtime.stop(state, project_id, id).await;
            let _ = state.inner.supervisor.stop_agent(project_id, id).await;
            let event = serde_json::json!({ "type": "agent-status", "projectId": project_id, "agentId": id, "state": "idle", "note": message });
            state.inner.ws_hub.broadcast_project(project_id, &event.to_string());
            stopped = true;
        }
    }
    if stopped {
        crate::ws::refresh(state, project_id);
    }
}

