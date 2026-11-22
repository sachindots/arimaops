// SPDX-License-Identifier: AGPL-3.0-or-later

//! Team memory, lessons and finding edits over the WebSocket: `keepOutOfMemory`, `setMemoryExtraction`,
//! `decideMemories`, `promoteLessons`, `removeLesson`, `setLessonPromotion`, `updateFinding`.
//! They wrap the same repositories the REST routes use, then broadcast a fresh snapshot.

use arima_db::{DbError, UpdateFindingInput};
use serde_json::{json, Value};

use crate::state::AppState;

fn text(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").trim().chars().take(max).collect()
}

fn done(state: &AppState, project_id: &str) -> Result<(), String> {
    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_raw_json(&snapshot.to_string());
    Ok(())
}

fn err(e: DbError) -> String {
    e.to_string()
}

pub fn keep_out_of_memory(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let name = text(args.first().unwrap_or(&Value::Null), 120);
    if name.chars().count() < 2 {
        return Err("A keep-out name needs at least 2 characters.".into());
    }
    let mut settings = state.inner.memory.get_settings(project_id).map_err(err)?;
    settings.keep_out.push(name);
    state.inner.memory.set_settings(project_id, &settings).map_err(err)?;
    done(state, project_id)
}

pub fn set_memory_extraction(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let mut settings = state.inner.memory.get_settings(project_id).map_err(err)?;
    if let Some(enabled) = input["enabled"].as_bool() {
        settings.extraction.enabled = enabled;
    }
    let account = text(&input["account"], 80);
    if !account.is_empty() {
        settings.extraction.account = account;
    }
    state.inner.memory.set_settings(project_id, &settings).map_err(err)?;
    done(state, project_id)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 60 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Certifies or rejects memories: `{ "<memoryId>": "certify" | "reject" }`. The item id is the inbox card the owner answered.
pub fn decide_memories(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let decisions = args.get(1).and_then(Value::as_object).ok_or("Nothing to decide.")?;
    let mut failures = Vec::new();
    for (id, verdict) in decisions.iter().filter(|(id, _)| valid_id(id)) {
        let result = match verdict.as_str() {
            Some("certify") => state.inner.memory.certify(project_id, id, false).map(|_| ()),
            Some("reject") => state.inner.memory.delete(project_id, id).map(|_| ()),
            _ => continue,
        };
        if let Err(e) = result {
            failures.push(format!("{id}: {e}"));
        }
    }
    done(state, project_id)?;
    if failures.is_empty() { Ok(()) } else { Err(format!("Couldn't check some memories: {}", failures.join("; "))) }
}

/// Promotes every certified lesson memory that is not a lesson yet. Returns how many were promoted through the ack text on failure only.
pub fn promote_lessons(state: &AppState, project_id: &str) -> Result<(), String> {
    let ids: Vec<String> = state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM memories WHERE project_id = ?1 AND certified = 1 AND promoted = 0 AND LOWER(mem_type) = 'lesson' ORDER BY created_at ASC")?;
            let rows = stmt.query_map([project_id], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
        })
        .map_err(err)?;
    for id in ids {
        state.inner.memory.promote_to_lesson(project_id, &id).map_err(err)?;
    }
    done(state, project_id)
}

pub fn remove_lesson(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 60);
    if !state.inner.memory.delete_promoted_lesson(project_id, &id).map_err(err)? {
        return Err(format!("No lesson \"{id}\"."));
    }
    done(state, project_id)
}

pub fn set_lesson_promotion(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let on = args.first().and_then(Value::as_bool) == Some(true);
    crate::team_edit::mutate(state, project_id, |model, _| {
        if !model.project.is_object() {
            model.project = json!({});
        }
        model.project["lessonsEnabled"] = json!(on);
        Ok(())
    })
}

/// A finding edit sent over the socket (the live UI also PATCHes the REST route). Unknown keys are ignored.
pub fn update_finding(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 40);
    let p = args.get(1).cloned().unwrap_or(Value::Null);
    let patch = UpdateFindingInput {
        severity: p["severity"].as_str().map(str::to_owned),
        status: p["status"].as_str().map(str::to_owned),
        verified: p["verified"].as_bool(),
        cvss_vector: p["cvss"].as_str().or_else(|| p["cvssVector"].as_str()).map(|v| Some(v.to_owned())),
        title: p["title"].as_str().map(str::to_owned),
        ..UpdateFindingInput::default()
    };
    state.inner.findings.update_finding(project_id, &id, patch).map_err(err)?;
    done(state, project_id)
}
