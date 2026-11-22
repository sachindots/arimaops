// SPDX-License-Identifier: AGPL-3.0-or-later

//! Planning data and project settings: goals, board edits, per-task runtime, spend caps, company text and stack.
//! Commands: `addGoal`, `updateGoal`, `setTaskGoal`, `updateBoard`, `setTaskRunsOn`, `setSpendCaps`,
//! `setCompany`, `updateStack`. Each saves, then broadcasts a fresh snapshot.

use arima_db::DbError;
use chrono::{Datelike, TimeZone, Utc};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::state::AppState;

const AGENT_CLIS: [&str; 6] = ["claude", "codex", "agy", "opencode", "gemini", "copilot"];
const COMPANY_MAX: usize = 3000;
const DEFAULT_DAILY_USD: f64 = 5.0;
const DEFAULT_MONTHLY_USD: f64 = 50.0;

fn text(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").trim().chars().take(max).collect()
}

fn broadcast(state: &AppState, project_id: &str) {
    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_raw_json(&snapshot.to_string());
}

fn write(state: &AppState, project_id: &str, f: impl FnOnce(&rusqlite::Connection) -> Result<(), String>) -> Result<(), String> {
    state
        .inner
        .db
        .transaction(|conn| f(conn).map_err(DbError::InvalidInput))
        .map_err(|e: DbError| match e {
            DbError::InvalidInput(msg) => msg,
            other => other.to_string(),
        })?;
    broadcast(state, project_id);
    Ok(())
}

/// Goals with the task counts and spend that sit under them, shaped as the UI's `Goal`.
pub fn goals_for(state: &AppState, project_id: &str) -> Vec<Value> {
    state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT g.id, g.title, g.metric, g.target_text, g.current_text, g.status,
                    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = g.project_id AND t.goal_id = g.id),
                    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = g.project_id AND t.goal_id = g.id AND t.status = 'done'),
                    (SELECT COALESCE(SUM(u.cost_usd), 0) FROM usage_events u WHERE u.project_id = g.project_id
                        AND u.task_id IN (SELECT t.id FROM tasks t WHERE t.project_id = g.project_id AND t.goal_id = g.id))
                 FROM goals g WHERE g.project_id = ?1 ORDER BY g.created_at ASC, g.id ASC",
            )?;
            let rows = stmt.query_map([project_id], |r| {
                let opt = |s: String| if s.is_empty() { Value::Null } else { json!(s) };
                let mut goal = json!({
                    "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "status": r.get::<_, String>(5)?,
                    "total": r.get::<_, i64>(6)?, "done": r.get::<_, i64>(7)?, "usd": r.get::<_, f64>(8)?
                });
                for (key, val) in [("metric", r.get::<_, String>(2)?), ("target", r.get::<_, String>(3)?), ("current", r.get::<_, String>(4)?)] {
                    if !val.is_empty() {
                        goal[key] = opt(val);
                    }
                }
                Ok(goal)
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
        })
        .unwrap_or_default()
}

fn next_goal_id(conn: &rusqlite::Connection, project_id: &str) -> Result<String, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT id FROM goals WHERE project_id = ?1")?;
    let max = stmt
        .query_map([project_id], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .filter_map(|id| id.strip_prefix('G').and_then(|n| n.parse::<u32>().ok()))
        .max()
        .unwrap_or(0);
    Ok(format!("G{}", max + 1))
}

pub fn add_goal(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let title = text(&input["title"], 200);
    if title.is_empty() {
        return Err("A goal needs a title.".into());
    }
    let now = Utc::now().timestamp_millis();
    write(state, project_id, |conn| {
        let id = next_goal_id(conn, project_id).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO goals (id, project_id, title, metric, target_value, current_value, status, created_at, target_text, current_text)
             VALUES (?1, ?2, ?3, ?4, 0, 0, 'active', ?5, ?6, ?7)",
            rusqlite::params![id, project_id, title, text(&input["metric"], 80), now, text(&input["target"], 80), text(&input["current"], 80)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub fn update_goal(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 20);
    let patch = args.get(1).cloned().unwrap_or(Value::Null);
    write(state, project_id, |conn| {
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM goals WHERE project_id = ?1 AND id = ?2", rusqlite::params![project_id, id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            return Err(format!("No goal \"{id}\"."));
        }
        for (key, column, max) in [("title", "title", 200), ("metric", "metric", 80), ("target", "target_text", 80), ("current", "current_text", 80)] {
            if let Some(v) = patch[key].as_str() {
                let v: String = v.trim().chars().take(max).collect();
                if key == "title" && v.is_empty() {
                    continue;
                }
                conn.execute(&format!("UPDATE goals SET {column} = ?1 WHERE project_id = ?2 AND id = ?3"), rusqlite::params![v, project_id, id]).map_err(|e| e.to_string())?;
            }
        }
        if let Some(status) = patch["status"].as_str().filter(|s| ["active", "done", "dropped"].contains(s)) {
            conn.execute("UPDATE goals SET status = ?1 WHERE project_id = ?2 AND id = ?3", rusqlite::params![status, project_id, id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

pub fn set_task_goal(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let task_id = text(args.first().unwrap_or(&Value::Null), 40);
    let goal_id = text(args.get(1).unwrap_or(&Value::Null), 20);
    write(state, project_id, |conn| {
        if !goal_id.is_empty() {
            let exists: Option<i64> = conn
                .query_row("SELECT 1 FROM goals WHERE project_id = ?1 AND id = ?2", rusqlite::params![project_id, goal_id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            exists.ok_or_else(|| format!("No goal \"{goal_id}\"."))?;
        }
        let goal: Option<&str> = if goal_id.is_empty() { None } else { Some(&goal_id) };
        let changed = conn
            .execute(
                "UPDATE tasks SET goal_id = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4",
                rusqlite::params![goal, Utc::now().timestamp_millis(), project_id, task_id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("No task \"{task_id}\"."));
        }
        Ok(())
    })
}

pub fn update_board(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let id = text(args.first().unwrap_or(&Value::Null), 20);
    let patch = args.get(1).cloned().unwrap_or(Value::Null);
    let title = text(&patch["title"], 120);
    let status = patch["status"].as_str().filter(|s| ["active", "planned", "done"].contains(s)).map(str::to_owned);
    write(state, project_id, |conn| {
        let now = Utc::now().timestamp_millis();
        let mut changed = 0;
        if !title.is_empty() {
            changed += conn.execute("UPDATE boards SET name = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4", rusqlite::params![title, now, project_id, id]).map_err(|e| e.to_string())?;
        }
        if let Some(status) = &status {
            changed += conn.execute("UPDATE boards SET status = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4", rusqlite::params![status, now, project_id, id]).map_err(|e| e.to_string())?;
        }
        if changed == 0 {
            return Err(format!("No board \"{id}\" or nothing to change."));
        }
        Ok(())
    })
}

/// A task's own CLI and model, kept in `tasks.data_json`; empty values clear them.
pub fn set_task_runs_on(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let task_id = text(args.first().unwrap_or(&Value::Null), 40);
    let cli = args.get(1).and_then(Value::as_str).filter(|c| AGENT_CLIS.contains(c)).map(str::to_owned);
    let model = text(args.get(2).unwrap_or(&Value::Null), 80);
    write(state, project_id, |conn| {
        let raw: String = conn
            .query_row("SELECT data_json FROM tasks WHERE project_id = ?1 AND id = ?2", rusqlite::params![project_id, task_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("No task \"{task_id}\"."))?;
        let mut data: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        data["cli"] = cli.map_or(Value::Null, Value::String);
        data["model"] = if model.is_empty() { Value::Null } else { json!(model) };
        conn.execute(
            "UPDATE tasks SET data_json = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4",
            rusqlite::params![data.to_string(), Utc::now().timestamp_millis(), project_id, task_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

fn cap(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n > 0.0 && *n <= 100_000.0).map(|n| (n * 100.0).round() / 100.0)
}

pub fn set_spend_caps(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let (Some(daily), Some(monthly)) = (cap(&input["dailyUsd"]), cap(&input["monthlyUsd"])) else {
        return Err("Caps are amounts in USD above 0.".into());
    };
    if daily > monthly {
        return Err("The daily cap can't be more than the monthly one.".into());
    }
    crate::team_edit::mutate(state, project_id, |model, _| {
        if !model.project.is_object() {
            model.project = json!({});
        }
        model.project["spendCaps"] = json!({ "dailyUsd": daily, "monthlyUsd": monthly });
        Ok(())
    })
}

/// A project's spend against its caps, shaped as the UI's `SpendState`.
pub fn spend_state(state: &AppState, project_id: &str, caps: Option<&Value>) -> Value {
    let daily_cap = caps.and_then(|c| c["dailyUsd"].as_f64()).unwrap_or(DEFAULT_DAILY_USD);
    let monthly_cap = caps.and_then(|c| c["monthlyUsd"].as_f64()).unwrap_or(DEFAULT_MONTHLY_USD);
    let now = Utc::now();
    let day_start = Utc.with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0).single().map_or(0, |d| d.timestamp_millis());
    let month_start = Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0).single().map_or(0, |d| d.timestamp_millis());
    let since = |from: i64| -> f64 {
        state
            .inner
            .db
            .read(|conn| {
                conn.query_row("SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE project_id = ?1 AND at >= ?2", rusqlite::params![project_id, from], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap_or(0.0)
    };
    let (day, month) = (since(day_start), since(month_start));
    let paused = if month >= monthly_cap { json!("month") } else if day >= daily_cap { json!("day") } else { Value::Null };
    json!({ "day": { "usd": day, "cap": daily_cap }, "month": { "usd": month, "cap": monthly_cap }, "paused": paused, "unpriced": 0 })
}

/// The machine-wide company context every agent gets.
#[must_use]
pub fn company(state: &AppState) -> String {
    state
        .inner
        .db
        .read(|conn| {
            conn.query_row("SELECT value_json FROM server_settings WHERE key = 'company'", [], |r| r.get::<_, String>(0))
                .optional()
                .map_err(DbError::from)
        })
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
        .unwrap_or_default()
}

pub fn set_company(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let body = text(args.first().unwrap_or(&Value::Null), COMPANY_MAX);
    write(state, project_id, |conn| {
        conn.execute(
            "INSERT INTO server_settings (key, value_json, updated_at) VALUES ('company', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            rusqlite::params![json!(body).to_string(), Utc::now().timestamp_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

fn clean_choice(v: &Value) -> Option<Value> {
    let id = text(&v["id"], 40);
    if id.is_empty() {
        return None;
    }
    let mut out = json!({ "id": id });
    for (key, max) in [("where", 120), ("name", 60), ("docsUrl", 300)] {
        let s = text(&v[key], max);
        if !s.is_empty() {
            out[key] = json!(s);
        }
    }
    Some(out)
}

/// A stack from the browser, trimmed to its shape. Null when nothing is chosen.
/// shortcut: ids are not checked against the UI's stack catalog, only their shape; check them when the catalog moves server-side.
#[must_use]
pub fn clean_stack(raw: &Value) -> Option<Value> {
    let frameworks: Vec<Value> = raw["frameworks"].as_array().map(|a| a.iter().take(10).filter_map(clean_choice).collect()).unwrap_or_default();
    let mut tools = serde_json::Map::new();
    for (category, choice) in raw["tools"].as_object().into_iter().flatten().take(20) {
        if let Some(c) = clean_choice(choice) {
            tools.insert(text(&json!(category), 40), c);
        }
    }
    (!frameworks.is_empty() || !tools.is_empty()).then(|| json!({ "frameworks": frameworks, "tools": tools }))
}

pub fn update_stack(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let stack = clean_stack(args.first().unwrap_or(&Value::Null));
    crate::team_edit::mutate(state, project_id, |model, _| {
        model.stack = stack;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stack_keeps_known_shape_and_drops_the_rest() {
        let raw = json!({ "frameworks": [{ "id": "next", "where": "apps/web", "junk": 1 }, { "id": "" }], "tools": { "db": { "id": "postgres" }, "x": {} } });
        let s = clean_stack(&raw).unwrap();
        assert_eq!(s["frameworks"].as_array().unwrap().len(), 1);
        assert!(s["frameworks"][0].get("junk").is_none());
        assert_eq!(s["tools"].as_object().unwrap().len(), 1);
        assert!(clean_stack(&json!({ "frameworks": [], "tools": {} })).is_none());
    }

    #[test]
    fn caps_must_be_positive_money() {
        assert_eq!(cap(&json!(5.456)), Some(5.46));
        assert_eq!(cap(&json!(0)), None);
        assert_eq!(cap(&json!(-1)), None);
        assert_eq!(cap(&json!(1_000_000)), None);
        assert_eq!(cap(&json!("5")), None);
    }
}
