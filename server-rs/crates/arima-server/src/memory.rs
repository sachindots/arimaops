// SPDX-License-Identifier: AGPL-3.0-or-later

//! Team Memory extraction orchestration (native provider API when configured with clean
//! deterministic offline fallback), contradiction checks, and Inbox `MemoryReview` emission.

use arima_agents::{
    ChatMessage, HttpSseModelRunner, ModelRequest, ModelRunner, ProviderKind, SeatRole,
};
use arima_core::{DecisionPayload, DecisionStatus, VisualDecision, WsServerEvent};
use arima_db::{scrub_sensitive_and_keep_out, CreateMemoryInput, DbError, MemoryRecord};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

/// Request body for `POST /api/projects/{id}/memory/extract`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractMemoryRequest {
    pub text: Option<String>,
    pub source: Option<String>,
    pub task_id: Option<String>,
    pub mem_type: Option<String>,
    #[serde(default)]
    pub about: Vec<String>,
    /// When `true` and a vaulted LLM API key is configured, attempts live provider extraction.
    #[serde(default)]
    pub use_live_provider: bool,
}

#[derive(Debug, Clone)]
struct CandidateMemory {
    mem_type: String,
    text: String,
    about: Vec<String>,
}

/// Extracts candidate memories for `project_id`, honors `keepOut`, runs contradiction checks,
/// inserts uncertified items into SQLite + FTS5, and emits a `MemoryReview` decision in Inbox.
pub async fn extract_and_queue_memories(
    state: &AppState,
    project_id: &str,
    req: ExtractMemoryRequest,
) -> Result<(Vec<MemoryRecord>, Option<VisualDecision>, &'static str), DbError> {
    let settings = state.inner.memory.get_settings(project_id)?;

    let raw_corpus = match req.text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) => t.to_owned(),
        None => gather_recent_project_context(state, project_id)?,
    };

    let (candidates, mode) = if req.use_live_provider && settings.extraction.enabled {
        match try_live_provider_extract(state, &raw_corpus).await {
            Some(cands) if !cands.is_empty() => (cands, "native-api"),
            _ => (
                deterministic_extract(
                    &raw_corpus,
                    req.mem_type.as_deref(),
                    &req.about,
                    req.source.as_deref(),
                ),
                "deterministic",
            ),
        }
    } else {
        (
            deterministic_extract(
                &raw_corpus,
                req.mem_type.as_deref(),
                &req.about,
                req.source.as_deref(),
            ),
            "deterministic",
        )
    };

    let mut created = Vec::new();
    for cand in candidates {
        let scrubbed = scrub_sensitive_and_keep_out(&cand.text, &settings.keep_out);
        if scrubbed.trim().len() < 4 {
            continue;
        }
        let rec = state.inner.memory.insert(
            project_id,
            CreateMemoryInput {
                id: None,
                mem_type: cand.mem_type,
                text: scrubbed,
                about: cand.about,
                certified: false,
                created_at_ms: None,
                last_used_at_ms: None,
            },
        )?;
        created.push(rec);
    }

    if created.is_empty() {
        return Ok((created, None, mode));
    }

    let conflicts = created
        .iter()
        .filter(|m| m.conflict_id.is_some())
        .count();
    let title = if conflicts > 0 {
        format!(
            "Review {} extracted memor{} ({conflicts} conflict)",
            created.len(),
            if created.len() == 1 { "y" } else { "ies" }
        )
    } else {
        format!(
            "Review {} extracted memor{}",
            created.len(),
            if created.len() == 1 { "y" } else { "ies" }
        )
    };

    let decision = VisualDecision {
        id: format!("dec-mem-{}", uuid::Uuid::new_v4().simple()),
        project_id: project_id.to_owned(),
        from_id: req.source.unwrap_or_else(|| "memory-extractor".into()),
        task_id: req.task_id,
        title,
        details: "Certify memories to preserve them permanently in FTS5 Team Memory (uncertified items decay after 30 days)."
            .into(),
        waiting: false,
        owner_only: true,
        status: DecisionStatus::Open,
        payload: DecisionPayload::MemoryReview {
            memories: serde_json::to_value(&created).unwrap_or_else(|_| json!([])),
        },
        note: None,
        created_at: Utc::now().to_rfc3339(),
        closed_at: None,
    };

    let saved = state.inner.decisions.upsert(&decision)?;
    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::DecisionUpdated {
            decision: saved.clone(),
        });

    Ok((created, Some(saved), mode))
}

fn gather_recent_project_context(state: &AppState, project_id: &str) -> Result<String, DbError> {
    let mut snippets = Vec::new();
    state.inner.db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT title, status FROM tasks WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT 8",
        )?;
        let rows = stmt.query_map([project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for r in rows {
            let (title, status) = r?;
            snippets.push(format!("Lesson: Task '{title}' reached status '{status}'."));
        }
        Ok::<_, DbError>(())
    })?;

    if snippets.is_empty() {
        snippets.push(
            "Lesson: Keep database migrations atomic with SAVEPOINT and verify foreign keys."
                .into(),
        );
    }
    Ok(snippets.join("\n"))
}

async fn try_live_provider_extract(state: &AppState, corpus: &str) -> Option<Vec<CandidateMemory>> {
    let secret_row = state
        .inner
        .vault_secrets
        .get_by_provider("anthropic")
        .ok()
        .flatten()
        .or_else(|| {
            state
                .inner
                .vault_secrets
                .get_by_provider("gemini")
                .ok()
                .flatten()
        })?;

    let aad = format!("vault-secret:{}", secret_row.id);
    let api_key_bytes = state
        .inner
        .auth
        .vault()
        .decrypt(aad.as_bytes(), &secret_row.secret_enc)
        .ok()?;
    let api_key = String::from_utf8(api_key_bytes).ok()?;
    if api_key.trim().is_empty() {
        return None;
    }

    let (kind, model) = if secret_row.provider == "gemini" {
        (ProviderKind::Gemini, "gemini-2.5-flash")
    } else {
        (ProviderKind::Anthropic, "claude-3-5-haiku-latest")
    };

    let runner = HttpSseModelRunner::new();
    let req = ModelRequest {
        provider: kind,
        model: model.to_owned(),
        api_key: api_key.trim().to_owned(),
        base_url: None,
        seat_role: SeatRole::Reviewer,
        system_prompt: Some(
            "Extract concise team memories as a JSON array of objects: [{\"memType\":\"Decision|Lesson|DeadEnd\",\"text\":\"...\",\"about\":[\"topic\"]}]. Output JSON only."
                .into(),
        ),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: corpus.chars().take(4000).collect(),
        }],
        tools: vec![],
        max_tokens: 512,
        temperature: 0.1,
    };
    let resp = tokio::time::timeout(std::time::Duration::from_secs(12), runner.run_stream(&req))
        .await
        .ok()?
        .ok()?;

    parse_llm_candidates(&resp.text)
}

fn parse_llm_candidates(raw: &str) -> Option<Vec<CandidateMemory>> {
    let start = raw.find('[')?;
    let end = raw.rfind(']')?;
    let arr: Vec<Value> = serde_json::from_str(&raw[start..=end]).ok()?;
    let mut out = Vec::new();
    for item in arr {
        let text = item.get("text").and_then(Value::as_str)?.trim().to_owned();
        if text.is_empty() {
            continue;
        }
        let mem_type = item
            .get("memType")
            .and_then(Value::as_str)
            .unwrap_or("Lesson")
            .to_owned();
        let about = item
            .get("about")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        out.push(CandidateMemory {
            mem_type,
            text,
            about,
        });
    }
    Some(out)
}

fn deterministic_extract(
    corpus: &str,
    default_type: Option<&str>,
    default_about: &[String],
    source: Option<&str>,
) -> Vec<CandidateMemory> {
    let mut out = Vec::new();
    for raw_line in corpus.lines() {
        let line = raw_line
            .trim()
            .trim_start_matches(['-', '*', '•', ' '])
            .trim();
        if line.len() < 6 {
            continue;
        }
        let (mem_type, body) = if let Some(rest) = strip_prefix_ci(line, "decision:") {
            ("Decision".to_owned(), rest.trim().to_owned())
        } else if let Some(rest) = strip_prefix_ci(line, "dead end:")
            .or_else(|| strip_prefix_ci(line, "deadend:"))
        {
            ("DeadEnd".to_owned(), rest.trim().to_owned())
        } else if let Some(rest) = strip_prefix_ci(line, "lesson:") {
            ("Lesson".to_owned(), rest.trim().to_owned())
        } else {
            let inferred = default_type.unwrap_or_else(|| {
                let low = line.to_ascii_lowercase();
                if low.contains("decided") || low.contains("decision") || low.contains("use ") {
                    "Decision"
                } else if low.contains("dead end") || low.contains("avoid") || low.contains("failed")
                {
                    "DeadEnd"
                } else {
                    "Lesson"
                }
            });
            (inferred.to_owned(), line.to_owned())
        };

        if body.is_empty() {
            continue;
        }

        let mut about = default_about.to_vec();
        if about.is_empty() {
            if let Some(src) = source.map(str::trim).filter(|s| !s.is_empty()) {
                about.push(src.to_ascii_lowercase());
            }
            for kw in ["sqlite", "auth", "proxy", "security", "preview", "backup", "voice", "ci"] {
                if body.to_ascii_lowercase().contains(kw) {
                    about.push(kw.to_owned());
                }
            }
        }
        out.push(CandidateMemory {
            mem_type,
            text: body,
            about,
        });
        if out.len() >= 10 {
            break;
        }
    }
    out
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}
