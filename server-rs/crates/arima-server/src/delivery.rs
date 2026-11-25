// SPDX-License-Identifier: AGPL-3.0-or-later

//! Chat and the agent outbox: what the owner says is shown in Chat and typed into the running agent's terminal.
//! Messages for an agent that isn't running wait in the outbox and are typed in shortly after it starts.

use std::time::Duration;

use arima_core::{OutboxMessage, OutboxMessageKind};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};

use crate::state::AppState;

/// A fresh CLI needs a few seconds before it reads input; typing sooner gets lost.
const START_GRACE: Duration = Duration::from_secs(8);
const MAX_LINE: usize = 2000;

fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().map_or_else(String::new, |d| d.to_rfc3339())
}

fn seat_ids(state: &AppState, project_id: &str) -> Vec<(String, String)> {
    crate::team::load(state, project_id)
        .map(|m| {
            m.team
                .iter()
                .map(|a| (a["id"].as_str().unwrap_or("").to_owned(), a["roleId"].as_str().unwrap_or("").to_owned()))
                .collect()
        })
        .unwrap_or_default()
}

/// The lead's agent id: the seat with the `lead` role, else the first seat.
pub fn lead_id(state: &AppState, project_id: &str) -> Option<String> {
    let seats = seat_ids(state, project_id);
    seats.iter().find(|(_, role)| role == "lead").or_else(|| seats.first()).map(|(id, _)| id.clone())
}

/// The newest 100 messages, newest first, in the shape the UI's `AgentMessage` expects.
pub fn messages_for(state: &AppState, project_id: &str) -> Vec<Value> {
    state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn
                .prepare("SELECT id, from_id, to_id, body, created_at FROM messages WHERE project_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 100")
                .map_err(arima_db::DbError::from)?;
            let rows = stmt
                .query_map([project_id], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "fromId": r.get::<_, String>(1)?,
                        "toId": r.get::<_, String>(2)?,
                        "text": r.get::<_, String>(3)?,
                        "at": iso(r.get::<_, i64>(4)?),
                    }))
                })
                .map_err(arima_db::DbError::from)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(arima_db::DbError::from)
        })
        .unwrap_or_default()
}

/// Records the owner's message, shows it in Chat, and types it into the agent if it is running.
pub async fn send_from_owner(state: &AppState, project_id: &str, to: &str, text: &str) -> Result<(), String> {
    let (to_id, mut message) = record_message(state, project_id, "you", to, text)?;
    if deliver_pending(state, project_id, &to_id).await > 0 {
        message["delivered"] = json!("typed");
        broadcast_message(state, project_id, &message);
    }
    Ok(())
}

/// An agent's message to a teammate (typed in the background) or to the owner ("you"), shown in Chat.
pub fn send_from_agent(state: &AppState, project_id: &str, from: &str, to: &str, text: &str) -> Result<(), String> {
    let (to_id, _) = record_message(state, project_id, from, to, text)?;
    if to_id != "you" {
        kick(state, project_id, &to_id);
    }
    Ok(())
}

/// Saves a message, queues it for an agent recipient and shows it in Chat. Returns the recipient and the message.
fn record_message(state: &AppState, project_id: &str, from: &str, to: &str, text: &str) -> Result<(String, Value), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Type a message first.".into());
    }
    let to_id = if to == "lead" {
        lead_id(state, project_id).ok_or("This project has no team yet.")?
    } else if (to == "you" && from != "you") || seat_ids(state, project_id).iter().any(|(id, _)| id == to) {
        to.to_owned()
    } else {
        return Err(format!("No agent \"{to}\"."));
    };
    let id = format!("msg-{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().timestamp_millis();
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "INSERT INTO messages (id, project_id, from_id, to_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, project_id, from, to_id, text, now],
            )?;
            Ok::<_, arima_db::DbError>(())
        })
        .map_err(|e| e.to_string())?;
    let mut message = json!({ "id": id, "fromId": from, "toId": to_id, "text": text, "at": iso(now) });
    if to_id != "you" {
        state
            .inner
            .supervisor
            .enqueue_outbox(project_id, &to_id, OutboxMessageKind::Text, &json!({ "from": from, "text": text }).to_string())
            .map_err(|e| e.to_string())?;
        message["delivered"] = json!("queued");
    }
    broadcast_message(state, project_id, &message);
    Ok((to_id, message))
}

fn broadcast_message(state: &AppState, project_id: &str, message: &Value) {
    state.inner.ws_hub.broadcast_project(project_id, &json!({ "type": "message", "message": message }).to_string());
}

fn clean(s: &str) -> String {
    let one_line: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    one_line.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_LINE).collect()
}

/// What to type for an outbox item; `None` is acknowledged without typing anything.
fn line_for(m: &OutboxMessage) -> Option<String> {
    let p: Value = serde_json::from_str(&m.payload_json).unwrap_or(Value::Null);
    let text = |k: &str| p[k].as_str().unwrap_or("").to_owned();
    match m.kind {
        OutboxMessageKind::Text => {
            let from = if text("from") == "you" { "the owner".to_owned() } else { text("from") };
            Some(format!("Message from {from}: {}", clean(&text("text"))))
        }
        OutboxMessageKind::DecisionAnswer => Some(format!(
            "The owner answered decision {}: {}. {} {}",
            text("decisionId"),
            text("status"),
            // A form's answer, not the form itself, which could fill the line on its own.
            clean(&if !p["answer"].is_null() { &p["answer"] } else if p["payload"]["kind"] == "form" { &p["payload"]["answer"] } else { &p["payload"] }.to_string()),
            clean(&text("note"))
        )),
        OutboxMessageKind::VisualFeedback => Some("The owner sent visual feedback on the preview. Check the feedback folder in your workspace.".to_owned()),
        OutboxMessageKind::Reset => None,
    }
}

/// Types every waiting outbox item into the agent's terminal, oldest first, acknowledging each one only after it was
/// written. Returns how many were typed. An agent that isn't running keeps its items for the next start.
pub async fn deliver_pending(state: &AppState, project_id: &str, agent_id: &str) -> usize {
    if !state.inner.runtime.is_running(project_id, agent_id) {
        return 0;
    }
    let sup = &state.inner.supervisor;
    let mut typed = 0;
    let mut next = sup.poll_next_outbox(project_id, agent_id, 0, 0).ok().flatten();
    while let Some(m) = next {
        if let Some(line) = line_for(&m) {
            let rt = &state.inner.runtime;
            if rt.send_input(project_id, agent_id, &line).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            if rt.send_input(project_id, agent_id, "\r").await.is_err() {
                break;
            }
            typed += 1;
        }
        next = sup.poll_next_outbox(project_id, agent_id, m.epoch, m.seq).ok().flatten();
    }
    typed
}

/// Deliver in the background: for callers that are not async (decision answers, visual feedback).
pub fn kick(state: &AppState, project_id: &str, agent_id: &str) {
    let (state, project, agent) = (state.clone(), project_id.to_owned(), agent_id.to_owned());
    tokio::spawn(async move {
        deliver_pending(&state, &project, &agent).await;
    });
}

/// After a start: wait for the CLI to be ready, then type whatever queued up while it was stopped.
pub fn kick_after_start(state: &AppState, project_id: &str, agent_id: &str) {
    let (state, project, agent) = (state.clone(), project_id.to_owned(), agent_id.to_owned());
    tokio::spawn(async move {
        tokio::time::sleep(START_GRACE).await;
        deliver_pending(&state, &project, &agent).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_form_answer_types_the_answer_not_the_form() {
        let form = json!({ "components": [{ "id": "root", "component": "Text", "text": "x".repeat(3_000) }], "data": {} });
        let payload = json!({ "decisionId": "dec-1", "status": "resolved", "note": null, "payload": { "kind": "form", "form": form, "answer": { "action": "send", "componentId": "go", "context": {}, "data": { "name": "Ada" } } } });
        let m = OutboxMessage { project_id: "p".into(), agent_id: "lead".into(), epoch: 1, seq: 1, kind: OutboxMessageKind::DecisionAnswer, payload_json: payload.to_string(), created_at: 0, acked_at: None };
        assert_eq!(line_for(&m).unwrap(), r#"The owner answered decision dec-1: resolved. {"action":"send","componentId":"go","context":{},"data":{"name":"Ada"}} "#);
    }
}
