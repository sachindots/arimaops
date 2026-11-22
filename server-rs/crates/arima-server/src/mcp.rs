// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use arima_auth::{record_audit, redact_json_value, AuditWrite};
use arima_core::{
    DecisionPayload, DecisionStatus, MeetingKind, MeetingUrgency, OpinionSide, PermissionPayload,
    QuestionOption, QuestionPayload, QuestionPrompt, SecondOpinionPayload, ServerRole,
    VisualDecision, VoiceProvider, WsServerEvent,
};
use arima_db::{is_owner_only_gate, CreateFindingInput, DbError};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use crate::meetings::{start_or_request_meeting, StartMeetingInput};
use crate::state::AppState;

/// Per-`(project_id, agent_id)` cached MCP handler entry.
#[derive(Debug)]
pub struct CachedMcpHandler {
    pub project_id: String,
    pub agent_id: String,
    pub invocations: AtomicU64,
}

#[derive(Debug, Clone)]
struct AgentCredential {
    project_id: String,
    agent_id: String,
    token: String,
}

/// Registry of cached per-`(project_id, agent_id)` MCP handlers and bearer credentials.
#[derive(Debug, Default)]
pub struct McpRegistry {
    handlers: Mutex<HashMap<(String, String), Arc<CachedMcpHandler>>>,
    tokens: Mutex<HashMap<String, AgentCredential>>,
}

impl McpRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Issues (or replaces) a bearer token for `(project_id, agent_id)`.
    pub fn issue_agent_token(&self, project_id: &str, agent_id: &str) -> String {
        let token = format!(
            "mcp_{}_{}_{}",
            project_id,
            agent_id,
            uuid::Uuid::new_v4().simple()
        );
        if let Ok(mut guard) = self.tokens.lock() {
            guard.insert(
                format!("{project_id}:{agent_id}"),
                AgentCredential {
                    project_id: project_id.to_owned(),
                    agent_id: agent_id.to_owned(),
                    token: token.clone(),
                },
            );
        }
        token
    }

    /// Verifies a bearer token in constant time and returns `(project_id, agent_id)`.
    #[must_use]
    pub fn verify_bearer_token(&self, candidate: &str) -> Option<(String, String)> {
        let cand_bytes = candidate.as_bytes();
        let Ok(guard) = self.tokens.lock() else {
            return None;
        };
        let mut matched: Option<(String, String)> = None;
        for cred in guard.values() {
            let tok_bytes = cred.token.as_bytes();
            if tok_bytes.len() == cand_bytes.len() && bool::from(tok_bytes.ct_eq(cand_bytes)) {
                matched = Some((cred.project_id.clone(), cred.agent_id.clone()));
            }
        }
        matched
    }

    /// Returns the cached [`CachedMcpHandler`] for `(project_id, agent_id)`, creating it once on first access.
    pub fn get_or_create_handler(
        &self,
        project_id: &str,
        agent_id: &str,
    ) -> Arc<CachedMcpHandler> {
        let mut guard = self.handlers.lock().expect("mcp handlers lock");
        let entry = guard
            .entry((project_id.to_owned(), agent_id.to_owned()))
            .or_insert_with(|| {
                Arc::new(CachedMcpHandler {
                    project_id: project_id.to_owned(),
                    agent_id: agent_id.to_owned(),
                    invocations: AtomicU64::new(0),
                })
            })
            .clone();
        entry.invocations.fetch_add(1, Ordering::Relaxed);
        entry
    }

    /// Returns the invocation count for `(project_id, agent_id)` on its cached handler instance.
    #[must_use]
    pub fn handler_invocations(&self, project_id: &str, agent_id: &str) -> u64 {
        self.handlers
            .lock()
            .ok()
            .and_then(|g| g.get(&(project_id.to_owned(), agent_id.to_owned())).cloned())
            .map(|h| h.invocations.load(Ordering::Relaxed))
            .unwrap_or(0)
    }
}

/// Incoming JSON-RPC 2.0 request to `/mcp`.
#[derive(Debug, Clone, Deserialize)]
pub struct McpJsonRpcRequest {
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Outgoing JSON-RPC 2.0 response from `/mcp`.
#[derive(Debug, Clone, Serialize)]
pub struct McpJsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<McpJsonRpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpJsonRpcError {
    pub code: i32,
    pub message: String,
}

impl McpJsonRpcResponse {
    fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn err(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(McpJsonRpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

/// Caller identity executing an MCP request.
#[derive(Debug, Clone)]
pub struct McpCaller {
    pub project_id: String,
    pub agent_id: String,
    pub actor_user_id: Option<String>,
    pub actor_role: ServerRole,
    pub is_agent_token: bool,
    pub remote: bool,
}

/// Processes a JSON-RPC 2.0 MCP call using the cached per-`(project_id, agent_id)` handler.
pub fn handle_mcp_rpc(
    state: &AppState,
    caller: &McpCaller,
    req: McpJsonRpcRequest,
) -> McpJsonRpcResponse {
    let _ = req.jsonrpc;
    let rpc_id = req.id.unwrap_or(Value::Null);

    if matches!(caller.actor_role, ServerRole::Viewer) {
        return McpJsonRpcResponse::err(rpc_id, -32001, "viewer role is strictly read-only");
    }

    let handler = state
        .inner
        .mcp
        .get_or_create_handler(&caller.project_id, &caller.agent_id);

    match req.method.as_str() {
        "initialize" => McpJsonRpcResponse::ok(
            rpc_id,
            json!({
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "arimaops-mcp",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "tools": {} },
                "cachedHandlerInvocations": handler.invocations.load(Ordering::Relaxed)
            }),
        ),
        "tools/list" => McpJsonRpcResponse::ok(
            rpc_id,
            json!({
                "tools": [
                    { "name": "ask_user", "description": "Ask structured multi-choice questions with (Recommended) options." },
                    { "name": "propose_second_opinion", "description": "Create side-by-side Option A vs Option B second-opinion card." },
                    { "name": "report_disagreement", "description": "Escalate an agent-vs-agent disagreement with Option A and Option B rationales." },
                    { "name": "request_meeting", "description": "Request an interactive Standup or Discussion room with the team and owner." },
                    { "name": "record_gate", "description": "Record a task gate transition (passed, failed, reset, waived) with full Markdown rationale." },
                    { "name": "request_access", "description": "Request permission for a tool, command, path, or domain." },
                    { "name": "attach_evidence", "description": "Attach verifier PR/task steps and screenshot evidence." },
                    { "name": "get_visual_feedback", "description": "Retrieve visual feedback annotations submitted for this project." },
                    { "name": "list_tasks", "description": "List board tasks in this project." },
                    { "name": "update_task", "description": "Create or update a board task." },
                    { "name": "report_finding", "description": "Record a security finding with CVSS 4.0 scoring, reproduction steps, and evidence." },
                    { "name": "check_scope", "description": "Verify whether a target host or URL is allowed under the engagement scope and egress proxy policy." },
                    { "name": "propose_send", "description": "Propose an external tool send action requiring explicit Owner approval in Inbox." }
                ]
            }),
        ),
        "tools/call" => {
            let tool_name = req
                .params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let args = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| req.params.clone());

            let res = dispatch_tool(state, caller, &handler, &tool_name, &args);
            let redacted = redact_json_value(&args);
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: caller.actor_user_id.as_deref(),
                    actor_name: &caller.agent_id,
                    actor_role: Some(caller.actor_role),
                    project_id: Some(&caller.project_id),
                    action: &format!("mcp.{tool_name}"),
                    target: Some(&caller.project_id),
                    summary: format!("args={redacted}"),
                    remote: caller.remote,
                    allowed: res.is_ok(),
                },
            );

            match res {
                Ok(val) => McpJsonRpcResponse::ok(rpc_id, val),
                Err((code, msg)) => McpJsonRpcResponse::err(rpc_id, code, msg),
            }
        }
        other => {
            // Also allow direct method calls where `method` is the tool name itself.
            let res = dispatch_tool(state, caller, &handler, other, &req.params);
            let redacted = redact_json_value(&req.params);
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: caller.actor_user_id.as_deref(),
                    actor_name: &caller.agent_id,
                    actor_role: Some(caller.actor_role),
                    project_id: Some(&caller.project_id),
                    action: &format!("mcp.{other}"),
                    target: Some(&caller.project_id),
                    summary: format!("args={redacted}"),
                    remote: caller.remote,
                    allowed: res.is_ok(),
                },
            );
            match res {
                Ok(val) => McpJsonRpcResponse::ok(rpc_id, val),
                Err((code, msg)) => McpJsonRpcResponse::err(rpc_id, code, msg),
            }
        }
    }
}

fn dispatch_tool(
    state: &AppState,
    caller: &McpCaller,
    handler: &CachedMcpHandler,
    tool_name: &str,
    args: &Value,
) -> Result<Value, (i32, String)> {
    match tool_name {
        "ask_user" => tool_ask_user(state, caller, handler, args),
        "propose_second_opinion" => tool_second_opinion(state, caller, handler, args, false),
        "report_disagreement" => tool_second_opinion(state, caller, handler, args, true),
        "request_meeting" => tool_request_meeting(state, caller, handler, args),
        "record_gate" => tool_record_gate(state, caller, handler, args),
        "request_access" => tool_request_access(state, caller, handler, args),
        "attach_evidence" => tool_attach_evidence(state, caller, handler, args),
        "get_visual_feedback" => tool_get_visual_feedback(state, handler),
        "list_tasks" => tool_list_tasks(state, handler),
        "update_task" => tool_update_task(state, handler, args),
        "report_finding" => tool_report_finding(state, handler, args),
        "check_scope" => tool_check_scope(state, handler, args),
        "propose_send" => tool_propose_send(state, handler, args),
        other => Err((-32601, format!("Unknown MCP tool '{other}'"))),
    }
}

fn tool_ask_user(
    state: &AppState,
    _caller: &McpCaller,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let title = args
        .get("title")
        .or_else(|| args.get("question"))
        .and_then(Value::as_str)
        .unwrap_or("Question from agent")
        .to_owned();
    let details = args
        .get("details")
        .or_else(|| args.get("context"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let task_id = args
        .get("taskId")
        .or_else(|| args.get("task_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let owner_only = args
        .get("ownerOnly")
        .or_else(|| args.get("owner_only"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut questions: Vec<QuestionPrompt> = Vec::new();
    if let Some(q_arr) = args.get("questions").and_then(Value::as_array) {
        for (idx, q_val) in q_arr.iter().enumerate() {
            if let Ok(parsed) = serde_json::from_value::<QuestionPrompt>(q_val.clone()) {
                questions.push(parsed);
                continue;
            }
            let q_id = q_val
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("q{}", idx + 1));
            let prompt = q_val
                .get("prompt")
                .or_else(|| q_val.get("question"))
                .and_then(Value::as_str)
                .unwrap_or(&title)
                .to_owned();
            let multi_select = q_val
                .get("multiSelect")
                .or_else(|| q_val.get("multi_select"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let allow_other = q_val
                .get("allowOther")
                .or_else(|| q_val.get("allow_other"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let mut options = Vec::new();
            if let Some(opt_arr) = q_val.get("options").and_then(Value::as_array) {
                for (oidx, o_val) in opt_arr.iter().enumerate() {
                    if let Some(s) = o_val.as_str() {
                        options.push(QuestionOption {
                            id: format!("opt_{}", oidx + 1),
                            label: s.to_owned(),
                            description: None,
                            recommended: oidx == 0 || s.contains("(Recommended)"),
                        });
                    } else {
                        let oid = o_val
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("opt_{}", oidx + 1));
                        let label = o_val
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or("Option")
                            .to_owned();
                        let description = o_val
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        let recommended = o_val
                            .get("recommended")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        options.push(QuestionOption {
                            id: oid,
                            label,
                            description,
                            recommended,
                        });
                    }
                }
            }
            questions.push(QuestionPrompt {
                id: q_id,
                prompt,
                multi_select,
                allow_other,
                options,
            });
        }
    }

    if questions.is_empty() {
        questions.push(QuestionPrompt {
            id: "q1".into(),
            prompt: title.clone(),
            multi_select: false,
            allow_other: true,
            options: vec![
                QuestionOption {
                    id: "opt_1".into(),
                    label: "Proceed with recommended default".into(),
                    description: None,
                    recommended: true,
                },
                QuestionOption {
                    id: "opt_2".into(),
                    label: "Discuss alternatives".into(),
                    description: None,
                    recommended: false,
                },
            ],
        });
    }

    let decision = VisualDecision {
        id: format!("dec-q-{}", uuid::Uuid::new_v4().simple()),
        project_id: handler.project_id.clone(),
        from_id: handler.agent_id.clone(),
        task_id,
        title,
        details,
        waiting: true,
        owner_only,
        status: DecisionStatus::Open,
        payload: DecisionPayload::Question(QuestionPayload {
            questions,
            answers: Vec::new(),
        }),
        note: None,
        created_at: Utc::now().to_rfc3339(),
        closed_at: None,
    };

    let saved = state
        .inner
        .decisions
        .upsert(&decision)
        .map_err(|e| (-32000, e.to_string()))?;

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::DecisionUpdated {
            decision: saved.clone(),
        });

    Ok(json!({
        "decisionId": saved.id,
        "status": "open",
        "decision": saved
    }))
}

fn parse_opinion_side(val: Option<&Value>, default_label: &str, default_author: &str) -> OpinionSide {
    let Some(v) = val else {
        return OpinionSide {
            label: default_label.to_owned(),
            author_id: default_author.to_owned(),
            summary: default_label.to_owned(),
            rationale_markdown: String::new(),
            risks: Vec::new(),
        };
    };
    if let Ok(side) = serde_json::from_value::<OpinionSide>(v.clone()) {
        return side;
    }
    OpinionSide {
        label: v
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(default_label)
            .to_owned(),
        author_id: v
            .get("authorId")
            .or_else(|| v.get("author_id"))
            .and_then(Value::as_str)
            .unwrap_or(default_author)
            .to_owned(),
        summary: v
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or(default_label)
            .to_owned(),
        rationale_markdown: v
            .get("rationaleMarkdown")
            .or_else(|| v.get("rationale_markdown"))
            .or_else(|| v.get("rationale"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        risks: v
            .get("risks")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn tool_second_opinion(
    state: &AppState,
    _caller: &McpCaller,
    handler: &CachedMcpHandler,
    args: &Value,
    is_disagreement: bool,
) -> Result<Value, (i32, String)> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(if is_disagreement {
            "Agent disagreement"
        } else {
            "Second-opinion review"
        })
        .to_owned();
    let details = args
        .get("details")
        .or_else(|| args.get("rationale"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let task_id = args
        .get("taskId")
        .or_else(|| args.get("task_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let gate_id = args
        .get("gateId")
        .or_else(|| args.get("gate_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let recommendation = args
        .get("recommendation")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let confidence = args
        .get("confidence")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let can_waive_gate = args
        .get("canWaiveGate")
        .or_else(|| args.get("can_waive_gate"))
        .and_then(Value::as_bool)
        .unwrap_or(gate_id.is_some());
    let owner_only = args
        .get("ownerOnly")
        .or_else(|| args.get("owner_only"))
        .and_then(Value::as_bool)
        .unwrap_or(can_waive_gate);

    let option_a = parse_opinion_side(
        args.get("optionA").or_else(|| args.get("option_a")),
        "Option A",
        &handler.agent_id,
    );
    let option_b = parse_opinion_side(
        args.get("optionB").or_else(|| args.get("option_b")),
        "Option B",
        "reviewer",
    );

    let so_payload = SecondOpinionPayload {
        task_id: task_id.clone(),
        gate_id,
        recommendation,
        confidence,
        option_a,
        option_b,
        can_waive_gate,
        chosen_side: None,
    };

    let payload = if is_disagreement {
        DecisionPayload::Disagreement(so_payload)
    } else {
        DecisionPayload::SecondOpinion(so_payload)
    };

    let decision = VisualDecision {
        id: format!("dec-so-{}", uuid::Uuid::new_v4().simple()),
        project_id: handler.project_id.clone(),
        from_id: handler.agent_id.clone(),
        task_id,
        title,
        details,
        waiting: true,
        owner_only,
        status: DecisionStatus::Open,
        payload,
        note: None,
        created_at: Utc::now().to_rfc3339(),
        closed_at: None,
    };

    let saved = state
        .inner
        .decisions
        .upsert(&decision)
        .map_err(|e| (-32000, e.to_string()))?;

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::DecisionUpdated {
            decision: saved.clone(),
        });

    Ok(json!({
        "decisionId": saved.id,
        "status": "open",
        "decision": saved
    }))
}

fn tool_request_meeting(
    state: &AppState,
    _caller: &McpCaller,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let title = args
        .get("title")
        .or_else(|| args.get("topic"))
        .and_then(Value::as_str)
        .unwrap_or("Team Discussion")
        .to_owned();

    let kind = match args
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("discussion")
    {
        "standup" => MeetingKind::Standup,
        "kickoff" => MeetingKind::Kickoff,
        "review" => MeetingKind::Review,
        _ => MeetingKind::Discussion,
    };

    let urgency = match args
        .get("urgency")
        .and_then(Value::as_str)
        .unwrap_or("normal")
    {
        "low" => MeetingUrgency::Low,
        "high" => MeetingUrgency::High,
        _ => MeetingUrgency::Normal,
    };

    let participant_ids: Vec<String> = args
        .get("participantIds")
        .or_else(|| args.get("participant_ids"))
        .or_else(|| args.get("participants"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| vec!["lead".into(), handler.agent_id.clone()]);

    let agenda_titles: Vec<String> = args
        .get("agenda")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.as_str()
                        .or_else(|| v.get("title").and_then(Value::as_str))
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();

    let moderator_id = args
        .get("moderatorId")
        .or_else(|| args.get("moderator_id"))
        .and_then(Value::as_str)
        .unwrap_or("lead")
        .to_owned();

    let (meeting, _, decision) = start_or_request_meeting(
        state,
        StartMeetingInput {
            project_id: handler.project_id.clone(),
            kind,
            title,
            urgency,
            moderator_id,
            participant_ids,
            requested_by: handler.agent_id.clone(),
            agenda_titles,
            voice_enabled: false,
            voice_provider: VoiceProvider::BrowserWebSpeech,
        },
        false,
    )
    .map_err(|e| (-32000, e))?;

    Ok(json!({
        "meetingId": meeting.id,
        "decisionId": decision.as_ref().map(|d| d.id.clone()),
        "status": "requested",
        "meeting": meeting,
        "decision": decision
    }))
}

fn tool_record_gate(
    state: &AppState,
    caller: &McpCaller,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let task_id = args
        .get("taskId")
        .or_else(|| args.get("task_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| (-32602, "missing taskId".to_owned()))?;
    let gate_id = args
        .get("gateId")
        .or_else(|| args.get("gate_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| (-32602, "missing gateId".to_owned()))?;
    let gate_state = args
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("passed");
    let note = args
        .get("note")
        .or_else(|| args.get("rationale"))
        .and_then(Value::as_str);
    let url = args.get("url").and_then(Value::as_str);
    let by_id = args
        .get("byId")
        .or_else(|| args.get("by_id"))
        .and_then(Value::as_str)
        .unwrap_or(&handler.agent_id);

    // Strict RBAC invariant: operators and non-owner agent tokens CANNOT forge owner-only gate waivers!
    if is_owner_only_gate(gate_id, gate_state, by_id)
        && (caller.is_agent_token || !matches!(caller.actor_role, ServerRole::Owner))
    {
        return Err((
            -32003,
            "Forbidden: operators and agents cannot forge owner-only gate waivers".into(),
        ));
    }

    let record = state
        .inner
        .gates
        .record_gate(
            &handler.project_id,
            task_id,
            gate_id,
            gate_state,
            by_id,
            note,
            url,
        )
        .map_err(|e| (-32000, e.to_string()))?;

    Ok(json!({
        "ok": true,
        "gateEvent": record
    }))
}

fn tool_request_access(
    state: &AppState,
    _caller: &McpCaller,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let tool_name = args
        .get("toolName")
        .or_else(|| args.get("tool_name"))
        .and_then(Value::as_str)
        .unwrap_or("network-egress")
        .to_owned();
    let command_or_path = args
        .get("domain")
        .or_else(|| args.get("commandOrPath"))
        .or_else(|| args.get("command_or_path"))
        .and_then(Value::as_str)
        .unwrap_or("external")
        .to_owned();
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("Agent requested access")
        .to_owned();
    let scope_hint = args
        .get("scopeHint")
        .or_else(|| args.get("scope_hint"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let task_id = args
        .get("taskId")
        .or_else(|| args.get("task_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let decision = VisualDecision {
        id: format!("dec-perm-{}", uuid::Uuid::new_v4().simple()),
        project_id: handler.project_id.clone(),
        from_id: handler.agent_id.clone(),
        task_id,
        title: format!("Allow {} on `{}`?", tool_name, command_or_path),
        details: reason.clone(),
        waiting: true,
        owner_only: false,
        status: DecisionStatus::Open,
        payload: DecisionPayload::Permission(PermissionPayload {
            tool_name,
            command_or_path,
            reason,
            scope_hint,
            resolution: None,
        }),
        note: None,
        created_at: Utc::now().to_rfc3339(),
        closed_at: None,
    };

    let saved = state
        .inner
        .decisions
        .upsert(&decision)
        .map_err(|e| (-32000, e.to_string()))?;

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::DecisionUpdated {
            decision: saved.clone(),
        });

    Ok(json!({
        "decisionId": saved.id,
        "status": "open",
        "decision": saved
    }))
}

fn tool_attach_evidence(
    state: &AppState,
    _caller: &McpCaller,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let task_id = args
        .get("taskId")
        .or_else(|| args.get("task_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| (-32602, "missing taskId".to_owned()))?;
    let sha = args.get("sha").and_then(Value::as_str).unwrap_or("HEAD");
    let steps = args.get("steps").cloned().unwrap_or_else(|| json!([]));
    let shots = args.get("shots").cloned().unwrap_or_else(|| json!([]));
    let now_ms = Utc::now().timestamp_millis();
    let now_iso = Utc::now().to_rfc3339();

    let evidence = json!({
        "sha": sha,
        "by": handler.agent_id,
        "at": now_iso,
        "steps": steps,
        "shots": shots,
    });

    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                 VALUES ('B1', ?1, 'Main Board', 'active', ?2, ?2)",
                rusqlite::params![handler.project_id, now_ms],
            )?;
            let data_json = json!({ "evidence": evidence }).to_string();
            conn.execute(
                "INSERT INTO tasks (id, project_id, board_id, stage_id, status, title, data_json, created_at, updated_at)
                 VALUES (?1, ?2, 'B1', 'verify', 'doing', ?1, ?3, ?4, ?4)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at",
                rusqlite::params![task_id, handler.project_id, data_json, now_ms],
            )?;
            Ok::<_, DbError>(())
        })
        .map_err(|e| (-32000, e.to_string()))?;

    Ok(json!({
        "ok": true,
        "taskId": task_id,
        "evidence": evidence
    }))
}

fn tool_get_visual_feedback(
    state: &AppState,
    handler: &CachedMcpHandler,
) -> Result<Value, (i32, String)> {
    let items = state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, page_url, viewport_width, viewport_height, note, image_path, workspace_rel_dir, created_at
                 FROM visual_feedback
                 WHERE project_id = ?1
                 ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map([&handler.project_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "pageUrl": r.get::<_, String>(1)?,
                    "viewportWidth": r.get::<_, i64>(2)?,
                    "viewportHeight": r.get::<_, i64>(3)?,
                    "note": r.get::<_, String>(4)?,
                    "imagePath": r.get::<_, String>(5)?,
                    "workspaceRelDir": r.get::<_, String>(6)?,
                    "createdAt": r.get::<_, i64>(7)?,
                }))
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok::<_, DbError>(out)
        })
        .map_err(|e| (-32000, e.to_string()))?;

    Ok(json!({ "feedback": items }))
}

fn tool_list_tasks(state: &AppState, handler: &CachedMcpHandler) -> Result<Value, (i32, String)> {
    let tasks = state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, board_id, stage_id, status, title, owner_id, pr_number
                 FROM tasks
                 WHERE project_id = ?1
                 ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map([&handler.project_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "boardId": r.get::<_, String>(1)?,
                    "stageId": r.get::<_, String>(2)?,
                    "status": r.get::<_, String>(3)?,
                    "title": r.get::<_, String>(4)?,
                    "ownerId": r.get::<_, Option<String>>(5)?,
                    "prNumber": r.get::<_, Option<i64>>(6)?,
                }))
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok::<_, DbError>(out)
        })
        .map_err(|e| (-32000, e.to_string()))?;

    Ok(json!({ "tasks": tasks }))
}

fn tool_update_task(
    state: &AppState,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let task_id = args
        .get("id")
        .or_else(|| args.get("taskId"))
        .and_then(Value::as_str)
        .unwrap_or("T01");
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(task_id);
    let board_id = args
        .get("boardId")
        .and_then(Value::as_str)
        .unwrap_or("B1");
    let stage_id = args
        .get("stageId")
        .and_then(Value::as_str)
        .unwrap_or("build");
    let status = args
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("doing");
    let owner_id = args
        .get("ownerId")
        .and_then(Value::as_str)
        .or(Some(handler.agent_id.as_str()));
    let now_ms = Utc::now().timestamp_millis();

    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                 VALUES (?1, ?2, 'Main Board', 'active', ?3, ?3)",
                rusqlite::params![board_id, handler.project_id, now_ms],
            )?;
            conn.execute(
                "INSERT INTO tasks (id, project_id, board_id, stage_id, status, title, owner_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    stage_id = excluded.stage_id,
                    status = excluded.status,
                    title = excluded.title,
                    owner_id = excluded.owner_id,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    task_id,
                    handler.project_id,
                    board_id,
                    stage_id,
                    status,
                    title,
                    owner_id,
                    now_ms
                ],
            )?;
            conn.execute(
                "INSERT INTO task_events (project_id, task_id, status, stage_id, owner_id, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    handler.project_id,
                    task_id,
                    status,
                    stage_id,
                    owner_id,
                    now_ms
                ],
            )?;
            Ok::<_, DbError>(())
        })
        .map_err(|e| (-32000, e.to_string()))?;

    Ok(json!({
        "ok": true,
        "task": {
            "id": task_id,
            "boardId": board_id,
            "stageId": stage_id,
            "status": status,
            "title": title,
            "ownerId": owner_id
        }
    }))
}

fn tool_report_finding(
    state: &AppState,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let target = args
        .get("target")
        .or_else(|| args.get("asset"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if title.is_empty() || target.is_empty() {
        return Err((-32602, "title and target are required for report_finding".into()));
    }

    let evidence_refs = args
        .get("evidenceRefs")
        .or_else(|| args.get("evidence"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    let input = CreateFindingInput {
        id: args.get("id").and_then(Value::as_str).map(str::to_owned),
        title,
        target,
        cwe: args.get("cwe").and_then(Value::as_str).map(str::to_owned),
        cvss_vector: args
            .get("cvssVector")
            .or_else(|| args.get("cvss_vector"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        cvss_score: args
            .get("cvssScore")
            .or_else(|| args.get("cvss_score"))
            .and_then(Value::as_f64),
        severity: args
            .get("severity")
            .and_then(Value::as_str)
            .map(str::to_owned),
        status: args
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
        description_markdown: args
            .get("descriptionMarkdown")
            .or_else(|| args.get("description"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        reproduction_markdown: args
            .get("reproductionMarkdown")
            .or_else(|| args.get("reproduction"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        remediation_markdown: args
            .get("remediationMarkdown")
            .or_else(|| args.get("remediation"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        evidence_refs,
        reporter_id: Some(handler.agent_id.clone()),
        verified: args
            .get("verified")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };

    let finding = state
        .inner
        .findings
        .create_finding(&handler.project_id, input)
        .map_err(|e| (-32602, e.to_string()))?;

    Ok(json!({
        "ok": true,
        "finding": finding,
    }))
}

fn tool_check_scope(
    state: &AppState,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let target = args
        .get("target")
        .or_else(|| args.get("host"))
        .or_else(|| args.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if target.is_empty() {
        return Err((-32602, "target is required for check_scope".into()));
    }

    // Ensure the project's persisted scope is loaded in the live policy provider.
    if state
        .inner
        .egress_policy
        .policy_for_project(&handler.project_id)
        .is_none()
    {
        if let Ok(scope) = state.inner.findings.get_scope(&handler.project_id) {
            let _ = state.sync_project_scope_to_proxy(&handler.project_id, &scope);
        }
    }

    let check = state
        .inner
        .egress_policy
        .check_target(&handler.project_id, target);

    Ok(json!({
        "ok": true,
        "result": check,
        "allowed": check.allowed,
        "inScope": check.in_scope,
        "outOfScope": check.out_of_scope,
        "blockedImds": check.blocked_imds,
        "reason": check.reason,
    }))
}

fn tool_propose_send(
    state: &AppState,
    handler: &CachedMcpHandler,
    args: &Value,
) -> Result<Value, (i32, String)> {
    let connection = args
        .get("connection")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let tool = args
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if connection.is_empty() || tool.is_empty() {
        return Err((-32602, "connection and tool are required for propose_send".into()));
    }
    let send_args = args.get("args").cloned().unwrap_or_else(|| json!({}));
    let summary = args
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Approve external send via {connection}.{tool}"));
    let task_id = args
        .get("taskId")
        .or_else(|| args.get("task_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let decision = VisualDecision {
        id: format!("dec-send-{}", uuid::Uuid::new_v4().simple()),
        project_id: handler.project_id.clone(),
        from_id: handler.agent_id.clone(),
        task_id,
        title: format!("Send via {connection}: {tool}"),
        details: summary,
        waiting: true,
        owner_only: true,
        status: DecisionStatus::Open,
        payload: DecisionPayload::SendProposal {
            connection,
            tool,
            args: send_args,
            sent_at: None,
            error: None,
        },
        note: None,
        created_at: Utc::now().to_rfc3339(),
        closed_at: None,
    };

    let saved = state
        .inner
        .decisions
        .upsert(&decision)
        .map_err(|e| (-32000, e.to_string()))?;
    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::DecisionUpdated {
            decision: saved.clone(),
        });

    Ok(json!({
        "ok": true,
        "decision": saved,
        "ownerOnly": saved.owner_only,
    }))
}
