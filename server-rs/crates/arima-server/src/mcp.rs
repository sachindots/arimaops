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
use arima_db::{is_owner_only_gate, CreateFindingInput, CreateMemoryInput, Db, DbError, MemoryStatusFilter};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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

/// Registry of cached per-`(project_id, agent_id)` MCP handlers. Bearer tokens live in `mcp_tokens` as SHA-256 digests.
#[derive(Debug)]
pub struct McpRegistry {
    db: Db,
    handlers: Mutex<HashMap<(String, String), Arc<CachedMcpHandler>>>,
}

fn token_digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

impl McpRegistry {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db, handlers: Mutex::default() }
    }

    /// Issues (or replaces) the bearer token for `(project_id, agent_id)`; only its digest is stored.
    pub fn issue_agent_token(&self, project_id: &str, agent_id: &str) -> String {
        let token = format!("mcp_{}", uuid::Uuid::new_v4().simple());
        let stored = self.db.transaction(|conn| {
            conn.execute(
                "INSERT INTO mcp_tokens (project_id, agent_id, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(project_id, agent_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at",
                rusqlite::params![project_id, agent_id, token_digest(&token), Utc::now().timestamp_millis()],
            )?;
            Ok::<_, DbError>(())
        });
        if let Err(e) = stored {
            tracing::warn!(project_id, agent_id, "couldn't store the agent's MCP token: {e}");
        }
        token
    }

    /// Revokes the bearer token for `(project_id, agent_id)` and drops its cached handler.
    pub fn revoke_agent_token(&self, project_id: &str, agent_id: &str) {
        let _ = self.db.transaction(|conn| {
            conn.execute("DELETE FROM mcp_tokens WHERE project_id = ?1 AND agent_id = ?2", rusqlite::params![project_id, agent_id])?;
            Ok::<_, DbError>(())
        });
        if let Ok(mut guard) = self.handlers.lock() {
            guard.remove(&(project_id.to_owned(), agent_id.to_owned()));
        }
    }

    /// Verifies a bearer token against every stored digest in constant time and returns `(project_id, agent_id)`.
    #[must_use]
    pub fn verify_bearer_token(&self, candidate: &str) -> Option<(String, String)> {
        let cand = token_digest(candidate);
        let rows = self
            .db
            .read(|conn| {
                let mut stmt = conn.prepare("SELECT project_id, agent_id, token_hash FROM mcp_tokens")?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
            })
            .ok()?;
        let mut matched = None;
        for (project_id, agent_id, hash) in rows {
            if bool::from(hash.as_bytes().ct_eq(cand.as_bytes())) {
                matched = Some((project_id, agent_id));
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

/// The only MCP revision this server implements: Streamable HTTP with JSON responses, no batching, no sessions.
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Caller identity executing an MCP request: always an agent authenticated by its bearer token.
#[derive(Debug, Clone)]
pub struct McpCaller {
    pub project_id: String,
    pub agent_id: String,
    pub remote: bool,
}

type ToolResult = Result<Value, (i32, String)>;

/// One HQ tool: what `tools/list` advertises and what `tools/call` runs, kept together so they can't drift.
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: fn() -> Value,
    run: fn(&AppState, &McpCaller, &CachedMcpHandler, &Value) -> ToolResult,
}

fn str_prop(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn opinion_side_schema(who: &str) -> Value {
    json!({
        "type": "object",
        "description": format!("{who}'s side of the comparison."),
        "properties": {
            "label": str_prop("Short name of this option."),
            "authorId": str_prop("Agent id that holds this view."),
            "summary": str_prop("One-line summary."),
            "rationaleMarkdown": str_prop("Full rationale, Markdown."),
            "risks": { "type": "array", "items": { "type": "string" } }
        }
    })
}

fn second_opinion_schema() -> Value {
    object(
        json!({
            "title": str_prop("Card title."),
            "details": str_prop("Context for the owner."),
            "taskId": str_prop("Task this is about."),
            "gateId": str_prop("Gate this could waive, if any."),
            "recommendation": str_prop("Which option you recommend and why."),
            "confidence": str_prop("How sure you are, e.g. low, medium, high."),
            "canWaiveGate": { "type": "boolean", "description": "Whether choosing a side may waive the gate. Defaults to true when gateId is set." },
            "ownerOnly": { "type": "boolean", "description": "Only the owner may answer. Defaults to canWaiveGate." },
            "optionA": opinion_side_schema("Option A"),
            "optionB": opinion_side_schema("Option B")
        }),
        &[],
    )
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "ask_user",
        description: "Ask the owner structured multiple-choice questions; mark the recommended option. Answers arrive as a message.",
        input_schema: || {
            object(
                json!({
                    "title": str_prop("The question, as the card's title."),
                    "details": str_prop("Context the owner needs to answer."),
                    "taskId": str_prop("Task this is about."),
                    "ownerOnly": { "type": "boolean", "description": "Only the owner may answer (not operators)." },
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": str_prop("Question id, e.g. q1."),
                                "prompt": str_prop("The question text."),
                                "multiSelect": { "type": "boolean" },
                                "allowOther": { "type": "boolean", "description": "Allow a free-text answer. Defaults to true." },
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "anyOf": [
                                            { "type": "string" },
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "id": { "type": "string" },
                                                    "label": { "type": "string" },
                                                    "description": { "type": "string" },
                                                    "recommended": { "type": "boolean" }
                                                },
                                                "required": ["label"]
                                            }
                                        ]
                                    }
                                }
                            },
                            "required": ["prompt"]
                        }
                    }
                }),
                &["title"],
            )
        },
        run: tool_ask_user,
    },
    ToolDef {
        name: "propose_second_opinion",
        description: "Put Option A and Option B side by side for the owner to choose.",
        input_schema: second_opinion_schema,
        run: |s, c, h, a| tool_second_opinion(s, c, h, a, false),
    },
    ToolDef {
        name: "report_disagreement",
        description: "Escalate a disagreement between agents with each side's rationale.",
        input_schema: second_opinion_schema,
        run: |s, c, h, a| tool_second_opinion(s, c, h, a, true),
    },
    ToolDef {
        name: "request_meeting",
        description: "Request a standup, kickoff, review or discussion with the team and the owner.",
        input_schema: || {
            object(
                json!({
                    "title": str_prop("Meeting topic."),
                    "kind": { "type": "string", "enum": ["standup", "kickoff", "review", "discussion"] },
                    "urgency": { "type": "string", "enum": ["low", "normal", "high"] },
                    "participantIds": { "type": "array", "items": { "type": "string" }, "description": "Agent ids. Defaults to the lead and you." },
                    "agenda": { "type": "array", "items": { "type": "string" } },
                    "moderatorId": str_prop("Agent id that moderates. Defaults to lead.")
                }),
                &[],
            )
        },
        run: tool_request_meeting,
    },
    ToolDef {
        name: "record_gate",
        description: "Record a task gate result with its rationale. Owner-only gates (merge waivers) are refused.",
        input_schema: || {
            object(
                json!({
                    "taskId": str_prop("Task id."),
                    "gateId": str_prop("Gate id, e.g. verify, review, second-opinion, detected, checked, edited."),
                    "state": { "type": "string", "enum": ["passed", "failed", "reset", "waived"], "description": "Defaults to passed." },
                    "note": str_prop("Rationale, Markdown: what you checked, or each problem."),
                    "url": str_prop("Link to the evidence, e.g. a PR."),
                    "byId": str_prop("Who recorded it. Defaults to you.")
                }),
                &["taskId", "gateId"],
            )
        },
        run: tool_record_gate,
    },
    ToolDef {
        name: "request_access",
        description: "Ask the owner to allow a tool, command, path or domain.",
        input_schema: || {
            object(
                json!({
                    "toolName": str_prop("What needs access, e.g. network-egress."),
                    "commandOrPath": str_prop("The command, path or domain."),
                    "reason": str_prop("Why you need it."),
                    "scopeHint": str_prop("How narrow the grant can be."),
                    "taskId": str_prop("Task this is for.")
                }),
                &["reason"],
            )
        },
        run: tool_request_access,
    },
    ToolDef {
        name: "attach_evidence",
        description: "Attach verification evidence to a task: the commit, the steps you took and labelled screenshots.",
        input_schema: || {
            object(
                json!({
                    "taskId": str_prop("Task id."),
                    "sha": str_prop("Commit checked. Defaults to HEAD."),
                    "steps": { "type": "array", "description": "One entry per step: what you opened, did and saw." },
                    "shots": { "type": "array", "description": "Screenshot files, each with a label." }
                }),
                &["taskId"],
            )
        },
        run: tool_attach_evidence,
    },
    ToolDef {
        name: "get_visual_feedback",
        description: "List the visual feedback the owner left on this project's preview.",
        input_schema: || object(json!({}), &[]),
        run: |s, _, h, _| tool_get_visual_feedback(s, h),
    },
    ToolDef {
        name: "list_tasks",
        description: "List this project's board tasks.",
        input_schema: || object(json!({}), &[]),
        run: |s, _, h, _| tool_list_tasks(s, h),
    },
    ToolDef {
        name: "update_task",
        description: "Create a board task, or update one with the same id.",
        input_schema: || {
            object(
                json!({
                    "id": str_prop("Task id, e.g. T-12. Reusing an id updates that task."),
                    "title": str_prop("Task title, with its done-when."),
                    "boardId": str_prop("Board id. Defaults to B1."),
                    "stageId": str_prop("Stage, e.g. build, review, verify, or recon, threat, vuln, exploit, post, report. Defaults to build."),
                    "status": str_prop("e.g. todo, doing, done. Defaults to doing."),
                    "ownerId": str_prop("Owning agent id. Defaults to you.")
                }),
                &["id", "title"],
            )
        },
        run: |s, _, h, a| tool_update_task(s, h, a),
    },
    ToolDef {
        name: "assign_task",
        description: "Give a task to an agent on this project's team.",
        input_schema: || object(json!({ "taskId": str_prop("Task id."), "agentId": str_prop("Agent id.") }), &["taskId", "agentId"]),
        run: |s, _, h, a| {
            crate::team_edit::assign_task(s, &h.project_id, &[json!(arg_str(a, "taskId")), json!(arg_str(a, "agentId"))]).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        },
    },
    ToolDef {
        name: "create_board",
        description: "Create a board for a body of work; returns its id.",
        input_schema: || object(json!({ "title": str_prop("Board title.") }), &["title"]),
        run: |s, _, h, a| {
            let id = crate::planning::create_board(s, &h.project_id, arg_str(a, "title")).map_err(invalid)?;
            Ok(json!({ "ok": true, "boardId": id }))
        },
    },
    ToolDef {
        name: "write_spec",
        description: "Write or replace a board's spec, one numbered requirement per line (S1., S2.…).",
        input_schema: || {
            object(json!({ "boardId": str_prop("Board id."), "specMarkdown": str_prop("The spec, Markdown.") }), &["boardId", "specMarkdown"])
        },
        run: |s, _, h, a| {
            let version = crate::planning::write_spec(s, &h.project_id, arg_str(a, "boardId"), arg_str(a, "specMarkdown")).map_err(invalid)?;
            Ok(json!({ "ok": true, "specVersion": version }))
        },
    },
    ToolDef {
        name: "list_goals",
        description: "List this project's goals with their progress.",
        input_schema: || object(json!({}), &[]),
        run: |s, _, h, _| Ok(json!({ "goals": crate::planning::goals_for(s, &h.project_id) })),
    },
    ToolDef {
        name: "update_goal",
        description: "Update a goal's numbers or status.",
        input_schema: || {
            object(
                json!({
                    "id": str_prop("Goal id, e.g. G1."),
                    "title": str_prop("New title."),
                    "metric": str_prop("What is measured."),
                    "target": str_prop("Target value, e.g. $5k."),
                    "current": str_prop("Current value."),
                    "status": { "type": "string", "enum": ["active", "done", "dropped"] }
                }),
                &["id"],
            )
        },
        run: |s, _, h, a| {
            crate::planning::update_goal(s, &h.project_id, &[json!(arg_str(a, "id")), a.clone()]).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        },
    },
    ToolDef {
        name: "send_message",
        description: "Send a chat message to a teammate, to the lead, or to the owner (\"you\").",
        input_schema: || object(json!({ "to": str_prop("Agent id, \"lead\", or \"you\" for the owner."), "text": str_prop("The message.") }), &["to", "text"]),
        run: |s, _, h, a| {
            crate::delivery::send_from_agent(s, &h.project_id, &h.agent_id, arg_str(a, "to"), arg_str(a, "text")).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        },
    },
    ToolDef {
        name: "report_finding",
        description: "Record a security finding with its CVSS 4.0 vector, reproduction and evidence.",
        input_schema: || {
            object(
                json!({
                    "title": str_prop("Finding title."),
                    "target": str_prop("Affected asset, host or URL."),
                    "id": str_prop("Finding id. Generated when omitted."),
                    "cwe": str_prop("e.g. CWE-89."),
                    "cvssVector": str_prop("CVSS:4.0/… vector; the score and severity are computed from it."),
                    "cvssScore": { "type": "number" },
                    "severity": { "type": "string", "enum": ["critical", "high", "medium", "low", "info"] },
                    "status": str_prop("Finding status."),
                    "descriptionMarkdown": str_prop("What it is and its impact."),
                    "reproductionMarkdown": str_prop("Exact steps to reproduce."),
                    "remediationMarkdown": str_prop("The fix."),
                    "evidenceRefs": { "type": "array", "items": { "type": "string" }, "description": "Evidence file paths." },
                    "verified": { "type": "boolean" }
                }),
                &["title", "target"],
            )
        },
        run: |s, _, h, a| tool_report_finding(s, h, a),
    },
    ToolDef {
        name: "update_finding",
        description: "Update a finding: confirm it (verified), change its severity, status or CVSS vector, or add remediation.",
        input_schema: || {
            object(
                json!({
                    "id": str_prop("Finding id."),
                    "title": str_prop("New title."),
                    "severity": { "type": "string", "enum": ["critical", "high", "medium", "low", "info"] },
                    "status": str_prop("Finding status."),
                    "verified": { "type": "boolean", "description": "You reproduced it from its evidence." },
                    "cvssVector": str_prop("CVSS:4.0/… vector."),
                    "remediationMarkdown": str_prop("Remediation, Markdown (replaces the current text).")
                }),
                &["id"],
            )
        },
        run: |s, _, h, a| {
            crate::memory_cmds::update_finding(s, &h.project_id, &[json!(arg_str(a, "id")), a.clone()]).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        },
    },
    ToolDef {
        name: "check_scope",
        description: "Check whether a host or URL is inside the engagement scope and allowed by the egress proxy.",
        input_schema: || object(json!({ "target": str_prop("Host or URL.") }), &["target"]),
        run: |s, _, h, a| tool_check_scope(s, h, a),
    },
    ToolDef {
        name: "propose_send",
        description: "Propose an external send (mail, post, CRM write) through a tool connection; the owner approves it in Inbox.",
        input_schema: || {
            object(
                json!({
                    "connection": str_prop("Tool connection name."),
                    "tool": str_prop("Tool on that connection."),
                    "args": { "type": "object", "description": "Arguments for that tool." },
                    "summary": str_prop("What will be sent, for the owner."),
                    "taskId": str_prop("Task this is for.")
                }),
                &["connection", "tool"],
            )
        },
        run: |s, _, h, a| tool_propose_send(s, h, a),
    },
    ToolDef {
        name: "recall",
        description: "Search the team's memory (decisions, dead ends, lessons), certified first.",
        input_schema: || {
            object(
                json!({ "query": str_prop("Words to search for."), "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Defaults to 12." } }),
                &["query"],
            )
        },
        run: |s, _, h, a| {
            let limit = a.get("limit").and_then(Value::as_u64).map_or(12, |n| n.clamp(1, 50));
            let mut found = s.inner.memory.search(&h.project_id, Some(arg_str(a, "query")), MemoryStatusFilter::All).map_err(server)?;
            found.truncate(usize::try_from(limit).unwrap_or(12));
            Ok(json!({ "memories": found }))
        },
    },
    ToolDef {
        name: "related",
        description: "Memories about a task, a file path, or the same topics as another memory.",
        input_schema: || {
            json!({
                "type": "object",
                "properties": { "taskId": str_prop("Task id."), "path": str_prop("File path."), "memoryId": str_prop("Memory id.") },
                "oneOf": [{ "required": ["taskId"] }, { "required": ["path"] }, { "required": ["memoryId"] }]
            })
        },
        run: tool_related,
    },
    ToolDef {
        name: "remember",
        description: "Save a memory for the team. It stays uncertified until the owner or an operator certifies it.",
        input_schema: || {
            object(
                json!({
                    "type": { "type": "string", "enum": ["Decision", "DeadEnd", "Lesson"] },
                    "text": str_prop("The memory, without secrets or people's names."),
                    "about": { "type": "array", "items": { "type": "string" }, "description": "Files or components it is about." },
                    "taskId": str_prop("Task it came from; it is added to about.")
                }),
                &["type", "text"],
            )
        },
        run: tool_remember,
    },
    ToolDef {
        name: "keep_out_of_memory",
        description: "Add a person's name to the project's keep-out list; it is masked in every memory, now and later.",
        input_schema: || object(json!({ "name": str_prop("The name, at least 2 characters.") }), &["name"]),
        run: |s, _, h, a| {
            crate::memory_cmds::keep_out_of_memory(s, &h.project_id, &[json!(arg_str(a, "name"))]).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        },
    },
];

fn arg_str<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

fn invalid(msg: String) -> (i32, String) {
    (-32602, msg)
}

fn server(e: DbError) -> (i32, String) {
    (-32000, e.to_string())
}

/// Processes one JSON-RPC 2.0 message. Notifications (no `id`) get no response.
pub fn handle_mcp_rpc(state: &AppState, caller: &McpCaller, req: McpJsonRpcRequest) -> Option<McpJsonRpcResponse> {
    let _ = req.jsonrpc;
    let rpc_id = req.id?;
    let handler = state.inner.mcp.get_or_create_handler(&caller.project_id, &caller.agent_id);

    Some(match req.method.as_str() {
        "initialize" => McpJsonRpcResponse::ok(
            rpc_id,
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "serverInfo": { "name": "arimaops-mcp", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} }
            }),
        ),
        "ping" => McpJsonRpcResponse::ok(rpc_id, json!({})),
        "tools/list" => McpJsonRpcResponse::ok(
            rpc_id,
            json!({
                "tools": TOOLS.iter().map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.input_schema)() })).collect::<Vec<_>>()
            }),
        ),
        "tools/call" => {
            let tool_name = req.params.get("name").and_then(Value::as_str).unwrap_or("").to_owned();
            let args = req.params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let res = match TOOLS.iter().find(|t| t.name == tool_name) {
                Some(tool) => (tool.run)(state, caller, &handler, &args),
                None => Err((-32602, format!("Unknown tool: {tool_name}"))),
            };
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: None,
                    actor_name: &caller.agent_id,
                    actor_role: Some(ServerRole::Operator),
                    project_id: Some(&caller.project_id),
                    action: &format!("mcp.{tool_name}"),
                    target: Some(&caller.project_id),
                    summary: format!("args={}", redact_json_value(&args)),
                    remote: caller.remote,
                    allowed: res.is_ok(),
                },
            );
            match res {
                Ok(val) => McpJsonRpcResponse::ok(
                    rpc_id,
                    json!({ "content": [{ "type": "text", "text": val.to_string() }], "structuredContent": val }),
                ),
                Err((code, msg)) => McpJsonRpcResponse::err(rpc_id, code, msg),
            }
        }
        other => McpJsonRpcResponse::err(rpc_id, -32601, format!("Method not found: {other}")),
    })
}

fn tool_related(state: &AppState, _caller: &McpCaller, handler: &CachedMcpHandler, args: &Value) -> ToolResult {
    let all = state.inner.memory.search(&handler.project_id, None, MemoryStatusFilter::All).map_err(server)?;
    let memory_id = arg_str(args, "memoryId");
    let topics: Vec<String> = if memory_id.is_empty() {
        // The memory store keeps `about` trimmed and lower-cased.
        [arg_str(args, "taskId"), arg_str(args, "path")].into_iter().map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect()
    } else {
        all.iter().find(|m| m.id == memory_id).map(|m| m.about.clone()).ok_or_else(|| invalid(format!("No memory \"{memory_id}\".")))?
    };
    if topics.is_empty() && memory_id.is_empty() {
        return Err(invalid("Give a taskId, path or memoryId.".into()));
    }
    let related: Vec<_> = all.into_iter().filter(|m| m.id != memory_id && m.about.iter().any(|a| topics.contains(a))).collect();
    Ok(json!({ "memories": related }))
}

fn tool_remember(state: &AppState, _caller: &McpCaller, handler: &CachedMcpHandler, args: &Value) -> ToolResult {
    let mut about: Vec<String> = args
        .get("about")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    if let Some(task) = args.get("taskId").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        about.push(task.to_owned());
    }
    let memory = state
        .inner
        .memory
        .insert(
            &handler.project_id,
            CreateMemoryInput {
                id: None,
                mem_type: arg_str(args, "type").to_owned(),
                text: arg_str(args, "text").to_owned(),
                about,
                certified: false,
                created_at_ms: None,
                last_used_at_ms: None,
            },
        )
        .map_err(|e| match e {
            DbError::InvalidInput(msg) => invalid(msg),
            other => server(other),
        })?;
    let snapshot = crate::ws::build_initial_snapshot(state, Some(&handler.project_id));
    state.inner.ws_hub.broadcast_snapshot(&handler.project_id, &snapshot);
    Ok(json!({ "ok": true, "memory": memory }))
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
    _caller: &McpCaller,
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

    // Agents can never record an owner-only gate (a merge waiver); only the owner can, from the UI.
    if is_owner_only_gate(gate_id, gate_state, by_id) {
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
