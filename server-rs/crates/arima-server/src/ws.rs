// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use arima_auth::{
    authorize_command, effective_role, parse_cookie, record_audit, redact_json_value, AuditWrite,
    AuthContext, CommandVerdict, SESSION_COOKIE_NAME,
};
use arima_core::{
    DecisionPayload, DecisionStatus, FormAnswer, MeetingKind, MeetingMinutes, MeetingUrgency,
    OutboxMessageKind, QuestionAnswer, ServerRole, VoiceProvider, WsClientMessage, WsCommandAck,
    WsServerEvent,
};
use arima_db::{is_owner_only_gate, ResolveDecisionInput};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::meetings::{
    add_turn_and_refresh_minutes, commit_minutes_and_broadcast, handle_meeting_action,
    start_or_request_meeting, StartMeetingInput,
};
use crate::state::{AppState, PeerIp};

const CLIENT_QUEUE_CAP: usize = 256;

#[derive(Debug, Clone)]
pub enum WsOutbound {
    Text(String),
    CloseSessionExpired,
}

#[derive(Debug)]
struct ClientEntry {
    conn_id: u64,
    tx: mpsc::Sender<WsOutbound>,
    /// Canonical id of the project this socket shows; project frames only go to matching sockets.
    project: String,
    /// False for viewers: they get snapshots but not live terminal bytes, which can hold secrets.
    streams: bool,
}

/// Manages active WebSocket subscribers keyed by `device_id` with bounded backpressure queues
/// and immediate `4001` close propagation on session revocation/reset.
#[derive(Debug, Default)]
pub struct WsHub {
    seq: AtomicU64,
    clients: Mutex<HashMap<String, Vec<ClientEntry>>>,
    /// The latest serialized snapshot per project (or connect key), so a burst of new connections builds it once.
    /// Any event that is not itself a snapshot clears it, so a new connection never starts from older state than the last change.
    snapshots: Mutex<HashMap<String, CachedSnapshot>>,
}

#[derive(Debug, Clone)]
struct CachedSnapshot {
    at: Instant,
    project: String,
    payload: String,
}

/// A safety net: even if some change forgot to clear the cache, a snapshot is never older than this.
const SNAPSHOT_TTL: Duration = Duration::from_secs(5);

impl WsHub {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn register(&self, device_id: &str, tx: mpsc::Sender<WsOutbound>, project: &str, streams: bool) -> u64 {
        let conn_id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut guard) = self.clients.lock() {
            guard
                .entry(device_id.to_owned())
                .or_default()
                .push(ClientEntry { conn_id, tx, project: project.to_owned(), streams });
        }
        conn_id
    }

    fn unregister(&self, device_id: &str, conn_id: u64) {
        if let Ok(mut guard) = self.clients.lock() {
            if let Some(list) = guard.get_mut(device_id) {
                list.retain(|e| e.conn_id != conn_id);
                if list.is_empty() {
                    guard.remove(device_id);
                }
            }
        }
    }

    /// Immediately closes all open WebSockets associated with `device_ids` with code `4001`.
    pub fn close_device_sessions(&self, device_ids: &[String]) {
        if device_ids.is_empty() {
            return;
        }
        let Ok(guard) = self.clients.lock() else {
            return;
        };
        for id in device_ids {
            if let Some(entries) = guard.get(id) {
                for entry in entries {
                    let _ = entry.tx.try_send(WsOutbound::CloseSessionExpired);
                }
            }
        }
    }

    /// Serializes `event` once and enqueues it without blocking slow peers: to the sockets of the project it belongs
    /// to, or to every socket when it names no project.
    pub fn broadcast_event(&self, event: &WsServerEvent) {
        let Ok(payload) = serde_json::to_string(event) else {
            return;
        };
        let project = match event {
            WsServerEvent::DecisionUpdated { decision } => Some(&decision.project_id),
            WsServerEvent::FeedbackCreated { feedback } => Some(&feedback.project_id),
            WsServerEvent::MeetingUpdated { meeting } => Some(&meeting.project_id),
            _ => None,
        };
        match project {
            Some(pid) => self.broadcast_project(pid, &payload),
            None => self.broadcast_raw_json(&payload),
        }
    }

    /// Serializes `event` once and sends it only to sockets showing `project_id`, for events that don't name their
    /// project themselves (a meeting turn names only its meeting).
    pub fn broadcast_project_event(&self, project_id: &str, event: &WsServerEvent) {
        if let Ok(payload) = serde_json::to_string(event) {
            self.broadcast_project(project_id, &payload);
        }
    }

    /// Sends a frame only to sockets showing `project_id`. It describes a change, so the cached snapshot is dropped.
    pub fn broadcast_project(&self, project_id: &str, payload: &str) {
        self.forget_snapshots();
        self.send_where(payload, |e| e.project == project_id);
    }

    /// Sends a full snapshot to the project's sockets and keeps it for the next connection.
    pub fn broadcast_snapshot(&self, project_id: &str, snapshot: &Value) {
        let payload = snapshot.to_string();
        if let Ok(mut cache) = self.snapshots.lock() {
            cache.clear();
            cache.insert(project_id.to_owned(), CachedSnapshot { at: Instant::now(), project: project_id.to_owned(), payload: payload.clone() });
        }
        self.send_where(&payload, |e| e.project == project_id);
    }

    fn forget_snapshots(&self) {
        if let Ok(mut cache) = self.snapshots.lock() {
            cache.clear();
        }
    }

    /// The first frame for a new connection: the cached snapshot if there is a fresh one, else `build()` it (once, even if
    /// hundreds of connections arrive together) and keep it. Returns the project's canonical id and the serialized frame.
    fn snapshot_for_connect(&self, key: &str, build: impl FnOnce() -> Value) -> (String, String) {
        let Ok(mut cache) = self.snapshots.lock() else {
            let v = build();
            return (v["snapshot"]["config"]["project"]["id"].as_str().unwrap_or("").to_owned(), v.to_string());
        };
        if let Some(hit) = cache.get(key).filter(|c| c.at.elapsed() < SNAPSHOT_TTL) {
            return (hit.project.clone(), hit.payload.clone());
        }
        let v = build();
        let project = v["snapshot"]["config"]["project"]["id"].as_str().unwrap_or("").to_owned();
        let payload = v.to_string();
        cache.insert(key.to_owned(), CachedSnapshot { at: Instant::now(), project: project.clone(), payload: payload.clone() });
        (project, payload)
    }

    /// Like `broadcast_project`, but skips viewers: for live terminal output.
    pub fn broadcast_project_streams(&self, project_id: &str, payload: &str) {
        self.send_where(payload, |e| e.project == project_id && e.streams);
    }

    fn send_where(&self, payload: &str, keep: impl Fn(&ClientEntry) -> bool) {
        let Ok(guard) = self.clients.lock() else {
            return;
        };
        for entries in guard.values() {
            for entry in entries.iter().filter(|e| keep(e)) {
                let _ = entry.tx.try_send(WsOutbound::Text(payload.to_owned()));
            }
        }
    }

    /// Broadcasts an arbitrary pre-serialized JSON frame to every active subscriber, in every project.
    /// Only for frames that belong to no project (decisions and meetings carry their own ids).
    pub fn broadcast_raw_json(&self, payload: &str) {
        self.forget_snapshots();
        let Ok(guard) = self.clients.lock() else {
            return;
        };
        for entries in guard.values() {
            for entry in entries {
                let _ = entry.tx.try_send(WsOutbound::Text(payload.to_owned()));
            }
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub project: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    PeerIp(peer_ip): PeerIp,
) -> impl IntoResponse {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let host_hdr = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    if !state.is_allowed_origin(origin.as_deref(), host_hdr.as_deref()) {
        return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
    }

    let cookie_hdr = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let raw_cookie = match parse_cookie(cookie_hdr, SESSION_COOKIE_NAME) {
        Ok(val) => val,
        Err(_) => return (StatusCode::UNAUTHORIZED, "Invalid session cookie").into_response(),
    };

    // Only the device cookie signs a socket in: the start-up link is traded for one by POST /api/login first,
    // so the long-lived token never travels in a WebSocket URL.
    let session = raw_cookie.and_then(|tok| match state.inner.auth.verify_session(&tok, false) {
        Ok(Some(s)) => Some((tok, s)),
        _ => None,
    });

    let Some((session_token, verified)) = session else {
        return (StatusCode::UNAUTHORIZED, "Sign in").into_response();
    };

    let remote = !state.is_local_origin(origin.as_deref(), peer_ip, host_hdr.as_deref());
    let requested_project = query.project;

    // tungstenite keeps a 128 KiB read and a 128 KiB write buffer per socket by default. Snapshots are tens of KB, so
    // 16 KiB each is plenty and brings a connection from about 430 KB to a fraction of that (see docs/benchmarks.md).
    ws.read_buffer_size(16 * 1024)
        .write_buffer_size(16 * 1024)
        .max_write_buffer_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| {
        handle_socket(
            socket,
            state,
            session_token,
            verified.device_id,
            remote,
            requested_project,
        )
    })
    .into_response()
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    session_token: String,
    device_id: String,
    remote: bool,
    requested_project: Option<String>,
) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<WsOutbound>(CLIENT_QUEUE_CAP);

    // Send initial OfficeSnapshot including visualDecisions, meetings, meetingTurns, pullRequests.
    let (project, init_frame) = state.inner.ws_hub.snapshot_for_connect(requested_project.as_deref().unwrap_or(""), || build_initial_snapshot(&state, requested_project.as_deref()));
    let streams = state
        .inner
        .auth
        .verify_session(&session_token, false)
        .ok()
        .flatten()
        .is_some_and(|v| {
            let project_role = v.user.as_ref().and_then(|u| state.inner.auth.get_project_role(&project, &u.id).ok().flatten());
            !matches!(effective_role(v.role, project_role), ServerRole::Viewer)
        });
    let conn_id = state.inner.ws_hub.register(&device_id, tx.clone(), &project, streams);

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                WsOutbound::Text(text) => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                WsOutbound::CloseSessionExpired => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code: 4001,
                            reason: "session expired".into(),
                        })))
                        .await;
                    let _ = sink.close().await;
                    break;
                }
            }
        }
    });

    let _ = tx.try_send(WsOutbound::Text(init_frame));
    if streams {
        for (agent, data) in state.inner.runtime.scrollbacks(&project) {
            let event = json!({ "type": "terminal.output", "projectId": project, "agentId": agent, "data": data });
            let _ = tx.try_send(WsOutbound::Text(event.to_string()));
        }
    }

    while let Some(Ok(frame)) = stream.next().await {
        let Message::Text(raw_text) = frame else {
            if matches!(frame, Message::Close(_)) {
                break;
            }
            continue;
        };

        let Ok(client_msg) = serde_json::from_str::<WsClientMessage>(&raw_text) else {
            let Ok(v) = serde_json::from_str::<Value>(&raw_text) else {
                continue;
            };
            let legacy_cmd = v.get("cmd").and_then(Value::as_str).unwrap_or("").to_owned();
            let legacy_args = v
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            process_ws_command(
                &state,
                &session_token,
                remote,
                requested_project.as_deref(),
                &tx,
                WsClientMessage {
                    id: String::new(),
                    cmd: legacy_cmd,
                    args: legacy_args,
                },
            )
            .await;
            continue;
        };

        let keep_open = process_ws_command(
            &state,
            &session_token,
            remote,
            requested_project.as_deref(),
            &tx,
            client_msg,
        )
        .await;
        if !keep_open {
            break;
        }
    }

    state.inner.ws_hub.unregister(&device_id, conn_id);
    drop(tx);
    let _ = writer.await;
}

async fn process_ws_command(
    state: &AppState,
    session_token: &str,
    remote: bool,
    requested_project: Option<&str>,
    tx: &mpsc::Sender<WsOutbound>,
    msg: WsClientMessage,
) -> bool {
    let Ok(Some(verified)) = state.inner.auth.verify_session(session_token, false) else {
        let _ = tx.try_send(WsOutbound::CloseSessionExpired);
        return false;
    };

    let mut cmd = msg.cmd;
    let mut args = msg.args;

    if cmd == "elevate" {
        let code = args.first().and_then(Value::as_str).unwrap_or("");
        match state.inner.auth.verify_totp_step_up(&verified, code) {
            Ok(until) => {
                let _ = record_audit(
                    &state.inner.db,
                    AuditWrite {
                        actor_user_id: verified.user.as_ref().map(|u| u.id.as_str()),
                        actor_name: verified
                            .user
                            .as_ref()
                            .map_or("bootstrap", |u| u.name.as_str()),
                        actor_role: Some(verified.role),
                        project_id: requested_project,
                        action: "ws.elevate",
                        target: Some(&verified.device_id),
                        summary: "device elevated via TOTP".into(),
                        remote,
                        allowed: true,
                    },
                );
                let ev = json!({ "type": "remote.stepup", "status": "ok", "until": until });
                let _ = tx.try_send(WsOutbound::Text(ev.to_string()));
                if let Some(pending_cmd) = args.get(1).and_then(Value::as_str) {
                    if !pending_cmd.is_empty() && pending_cmd != "elevate" {
                        let pending_args = args
                            .get(2)
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        cmd = pending_cmd.to_owned();
                        args = pending_args;
                    } else {
                        send_ack(tx, &msg.id, true, None);
                        return true;
                    }
                } else {
                    send_ack(tx, &msg.id, true, None);
                    return true;
                }
            }
            Err(err) => {
                let _ = record_audit(
                    &state.inner.db,
                    AuditWrite {
                        actor_user_id: verified.user.as_ref().map(|u| u.id.as_str()),
                        actor_name: verified
                            .user
                            .as_ref()
                            .map_or("bootstrap", |u| u.name.as_str()),
                        actor_role: Some(verified.role),
                        project_id: requested_project,
                        action: "ws.elevate",
                        target: Some(&verified.device_id),
                        summary: format!("TOTP step-up failed: {err}"),
                        remote,
                        allowed: false,
                    },
                );
                let ev = json!({ "type": "remote.stepup", "status": "denied" });
                let _ = tx.try_send(WsOutbound::Text(ev.to_string()));
                send_ack(tx, &msg.id, false, Some(err.to_string()));
                return true;
            }
        }
    }

    let project_id = requested_project
        .map(str::to_owned)
        .or_else(|| state.default_project().map(|(id, _, _, _)| id));

    let project_role = match (&project_id, &verified.user) {
        (Some(pid), Some(u)) => state.inner.auth.get_project_role(pid, &u.id).ok().flatten(),
        _ => None,
    };

    let now_ms = Utc::now().timestamp_millis();
    let elevated = verified
        .elevated_until_ms
        .is_some_and(|until| until > now_ms);

    let (target_agent_local, decision_owner_only) =
        inspect_command_context(state, &cmd, &args, project_id.as_deref());

    let ctx = AuthContext {
        server_role: verified.role,
        project_role,
        remote,
        elevated,
        target_agent_local,
        decision_owner_only,
    };

    let actor_name = verified
        .user
        .as_ref()
        .map_or("bootstrap", |u| u.name.as_str());
    let actor_uid = verified.user.as_ref().map(|u| u.id.as_str());
    let eff_role = effective_role(verified.role, project_role);

    // Map `answerDecision` to `resolveDecision` for `authorize_command` so RBAC & remote step-up apply identically.
    let rbac_cmd = if cmd == "answerDecision" {
        "resolveDecision"
    } else {
        cmd.as_str()
    };

    match authorize_command(rbac_cmd, &ctx) {
        CommandVerdict::Denied(reason) => {
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: actor_uid,
                    actor_name,
                    actor_role: Some(eff_role),
                    project_id: project_id.as_deref(),
                    action: &format!("ws.{cmd}"),
                    target: project_id.as_deref(),
                    summary: format!("denied: {reason}"),
                    remote,
                    allowed: false,
                },
            );
            send_ack(tx, &msg.id, false, Some(reason.to_owned()));
            return true;
        }
        CommandVerdict::StepUpRequired => {
            let _ = record_audit(
                &state.inner.db,
                AuditWrite {
                    actor_user_id: actor_uid,
                    actor_name,
                    actor_role: Some(eff_role),
                    project_id: project_id.as_deref(),
                    action: &format!("ws.{cmd}"),
                    target: project_id.as_deref(),
                    summary: "step-up required".into(),
                    remote,
                    allowed: false,
                },
            );
            let ev = json!({
                "type": "remote.stepup",
                "status": "required",
                "cmd": cmd,
                "args": args
            });
            let _ = tx.try_send(WsOutbound::Text(ev.to_string()));
            send_ack(
                tx,
                &msg.id,
                false,
                Some("Authenticator step-up required.".into()),
            );
            return true;
        }
        CommandVerdict::Allowed => {}
    }

    let pid = project_id
        .clone()
        .unwrap_or_else(|| "proj-alpha".to_owned());

    let result = execute_ws_command(
        state,
        &pid,
        actor_uid,
        actor_name,
        eff_role,
        &cmd,
        &args,
    )
    .await;

    let redacted_args = audit_args(&cmd, &args);
    let _ = record_audit(
        &state.inner.db,
        AuditWrite {
            actor_user_id: actor_uid,
            actor_name,
            actor_role: Some(eff_role),
            project_id: Some(&pid),
            action: &format!("ws.{cmd}"),
            target: Some(&pid),
            summary: format!("args={redacted_args}"),
            remote,
            allowed: result.is_ok(),
        },
    );

    match result {
        Ok(()) => send_ack(tx, &msg.id, true, None),
        Err(err) => send_ack(tx, &msg.id, false, Some(err)),
    }
    true
}

/// Arguments as the audit log may keep them. Commands that carry secret values log only who and what, never the value.
fn audit_args(cmd: &str, args: &[Value]) -> Value {
    match cmd {
        "setEnvVar" | "setSecret" => json!([args.first(), args.get(1), "[REDACTED]"]),
        "testAccountKey" => json!([args.first(), "[REDACTED]", args.get(2)]),
        "saveAccount" => json!([{ "id": args.first().and_then(|a| a.get("id")), "provider": args.first().and_then(|a| a.get("provider")) }]),
        _ => redact_json_value(&Value::Array(args.to_vec())),
    }
}

fn send_ack(tx: &mpsc::Sender<WsOutbound>, id: &str, ok: bool, error: Option<String>) {
    if id.is_empty() && ok {
        return;
    }
    let ack = WsServerEvent::CommandAck(WsCommandAck {
        id: id.to_owned(),
        ok,
        error,
    });
    if let Ok(payload) = serde_json::to_string(&ack) {
        let _ = tx.try_send(WsOutbound::Text(payload));
    }
}

async fn execute_ws_command(
    state: &AppState,
    project_id: &str,
    actor_uid: Option<&str>,
    actor_name: &str,
    actor_role: ServerRole,
    cmd: &str,
    args: &[Value],
) -> Result<(), String> {
    match cmd {
        "recheckSetup" => {
            state.inner.runtime.refresh().await;
            refresh(state, project_id);
            Ok(())
        }
        "ping" | "refreshSbx" => Ok(()),
        "refreshMcp" => crate::integrations::refresh_mcp(state, project_id, args).await,
        "completeWelcome" => crate::team::complete_welcome(state, project_id, args).inspect(|()| {
            crate::skills::pin_role_skills_in_background(state, project_id);
            crate::packs::install_template_packs_in_background(state, project_id);
        }),
        "updateAgent" => crate::team_edit::update_agent(state, project_id, args),
        "addAgent" => crate::team_edit::add_agent(state, project_id, args),
        "removeAgent" => crate::team_edit::remove_agent(state, project_id, args).await,
        "setEnvVar" => crate::secrets::set_env_var(state, project_id, args),
        "removeEnvVar" => crate::secrets::remove_env_var(state, project_id, args),
        "setSecret" => crate::secrets::set_secret(state, project_id, args),
        "removeSecret" => crate::secrets::remove_secret(state, project_id, args),
        "openEnvFile" => crate::secrets::open_env_file(),
        "saveAccount" => crate::secrets::save_account(state, project_id, args),
        "testAccountKey" => crate::key_test::run(state, project_id, args).await,
        "removeAccount" => crate::secrets::remove_account(state, project_id, args),
        "setEgressMode" => {
            crate::egress::set_mode(state, project_id, args)?;
            state.inner.runtime.release_network(state, project_id, false).await;
            Ok(())
        }
        "allowEgressHost" => crate::egress::allow_host(state, project_id, args),
        "ignoreEgressHost" => crate::egress::ignore_host(state, project_id, args),
        "removeEgressRule" => crate::egress::remove_rule(state, project_id, args),
        "resolveAccess" => crate::egress::resolve_access(state, project_id, args),
        "updateSandbox" => crate::integrations::update_sandbox(state, project_id, args),
        "setLabMode" => crate::integrations::set_lab_mode(state, project_id, args),
        "setToolsAsCode" => crate::codemode::set_switch(state, project_id, args),
        "addMcp" => {
            crate::integrations::add_mcp(state, project_id, args)?;
            crate::integrations::refresh_mcp(state, project_id, &[args.first().map_or(Value::Null, |a| a["name"].clone())]).await
        }
        "removeMcp" => crate::integrations::remove_mcp(state, project_id, args),
        "copyMcp" => {
            // The caller is Owner here (RBAC); copying a key out of another project needs Owner there too (owner decision Q4).
            let from = args.first().and_then(Value::as_str).unwrap_or("");
            if !is_owner_in(state, actor_uid, from) {
                return Err("Copying a tool server needs the Owner role in the project it comes from.".into());
            }
            crate::integrations::copy_mcp(state, project_id, args)
        }
        "setToolServerKey" => crate::integrations::set_tool_server_key(state, project_id, args),
        "addPack" => crate::packs::add_pack(state, project_id, args).await,
        "checkPackUpdates" => crate::packs::check_updates(state, project_id, args).await,
        "removePack" => crate::packs::remove_pack(state, project_id, args),
        "setAgentMcp" => crate::integrations::set_agent_mcp(state, project_id, args),
        "exportTemplate" => crate::integrations::export_template(state, project_id),
        "importTemplate" => crate::integrations::import_template(state, project_id, args),
        "setTeamMode" => crate::team_edit::set_team_mode(state, project_id, args),
        "updateWorkflow" => crate::team_edit::update_workflow(state, project_id, args),
        "updateProject" => crate::team_edit::update_project(state, project_id, args),
        "assignTask" => crate::team_edit::assign_task(state, project_id, args),
        "keepOutOfMemory" => crate::memory_cmds::keep_out_of_memory(state, project_id, args),
        "setMemoryExtraction" => crate::memory_cmds::set_memory_extraction(state, project_id, args),
        "decideMemories" => crate::memory_cmds::decide_memories(state, project_id, args),
        "promoteLessons" => crate::memory_cmds::promote_lessons(state, project_id),
        "removeLesson" => crate::memory_cmds::remove_lesson(state, project_id, args),
        "setLessonPromotion" => crate::memory_cmds::set_lesson_promotion(state, project_id, args),
        "updateFinding" => crate::memory_cmds::update_finding(state, project_id, args),
        "updateRole" => {
            if actor_role != ServerRole::Owner {
                crate::skills::check_operator_refs(state, project_id, &args.get(1).map_or(Value::Null, |p| p["skills"].clone()))?;
            }
            crate::team_edit::update_role(state, project_id, args).inspect(|()| crate::skills::pin_role_skills_in_background(state, project_id))
        }
        "updateProjectTemplate" => crate::team_edit::update_project_template(state, project_id, args)
            .inspect(|()| crate::skills::pin_role_skills_in_background(state, project_id)),
        "addGoal" => crate::planning::add_goal(state, project_id, args),
        "updateGoal" => crate::planning::update_goal(state, project_id, args),
        "setTaskGoal" => crate::planning::set_task_goal(state, project_id, args),
        "updateBoard" => crate::planning::update_board(state, project_id, args),
        "setTaskRunsOn" => crate::planning::set_task_runs_on(state, project_id, args),
        "setSpendCaps" => crate::planning::set_spend_caps(state, project_id, args),
        "setCompany" => crate::planning::set_company(state, project_id, args),
        "updateStack" => crate::planning::update_stack(state, project_id, args),
        "answerDecision" | "resolveDecision" | "resolveActionItem" => {
            exec_answer_decision(state, project_id, args, actor_role)
        }
        "recordGate" => exec_record_gate(state, project_id, actor_name, actor_role, args),
        "startMeeting" => exec_start_meeting(state, project_id, actor_name, args),
        "joinMeeting" => exec_join_meeting(state, args, actor_role),
        "addMeetingTurn" => exec_add_meeting_turn(state, actor_name, args),
        "commitMeetingMinutes" => exec_commit_meeting_minutes(state, args),
        "submitVisualFeedback" => {
            exec_submit_visual_feedback(state, project_id, actor_uid.unwrap_or(actor_name), args)
        }
        "startAgent" => {
            let agent_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| "missing agentId".to_owned())?;
            if let Some(blocked) = crate::usage_watch::cap_message(state, project_id) {
                return Err(blocked);
            }
            state
                .inner
                .supervisor
                .start_agent(project_id, agent_id, None)
                .await
                .map_err(|e| e.to_string())?;
            if let Err(e) = state.inner.runtime.start(state, project_id, agent_id).await {
                let _ = state.inner.supervisor.stop_agent(project_id, agent_id).await;
                return Err(e);
            }
            state.inner.ws_hub.broadcast_project(project_id, &json!({ "type": "agent-status", "projectId": project_id, "agentId": agent_id, "state": "running", "note": null }).to_string());
            refresh(state, project_id);
            crate::delivery::kick_after_start(state, project_id, agent_id);
            crate::usage_watch::watch(state, project_id, agent_id);
            Ok(())
        }
        "sendTerminalInput" => {
            let id = args.first().and_then(Value::as_str).unwrap_or("");
            let data = args.get(1).and_then(Value::as_str).unwrap_or("");
            state.inner.runtime.send_input(project_id, id, data).await
        }
        "resizeTerminal" => {
            let id = args.first().and_then(Value::as_str).unwrap_or("");
            let dim = |i: usize| args.get(i).and_then(Value::as_u64).and_then(|n| u16::try_from(n).ok()).unwrap_or(0);
            state.inner.runtime.resize(project_id, id, dim(1), dim(2)).await
        }
        "stopAgent" => {
            let agent_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| "missing agentId".to_owned())?;
            state
                .inner
                .supervisor
                .stop_agent(project_id, agent_id)
                .await
                .map_err(|e| e.to_string())?;
            let stopped = state.inner.runtime.stop(state, project_id, agent_id).await;
            state.inner.ws_hub.broadcast_project(project_id, &json!({ "type": "agent-status", "projectId": project_id, "agentId": agent_id, "state": "stopped", "note": null }).to_string());
            refresh(state, project_id);
            stopped
        }
        "createBoard" => crate::planning::create_board(state, project_id, args.first().and_then(Value::as_str).unwrap_or("")).map(drop),
        "sendMessage" | "askTeam" => {
            let (to_id, text) = if cmd == "askTeam" {
                ("lead", args.first().and_then(Value::as_str).unwrap_or(""))
            } else {
                (args.first().and_then(Value::as_str).unwrap_or("lead"), args.get(1).and_then(Value::as_str).unwrap_or(""))
            };
            crate::delivery::send_from_owner(state, project_id, to_id, text).await
        }
        other => Err(crate::integrations::unsupported(other).map_or_else(|| format!("Unknown command '{other}'."), str::to_owned)),
    }
}

/// Resolves a [`VisualDecision`] from WS `answerDecision` / `resolveDecision` / `resolveActionItem`
/// or REST `POST /api/projects/{id}/decisions/{decision_id}/resolve`, enqueues an outbox response
/// to the requesting agent, and broadcasts `WsServerEvent::DecisionUpdated`.
pub fn exec_answer_decision(
    state: &AppState,
    project_id: &str,
    args: &[Value],
    actor_role: ServerRole,
) -> Result<(), String> {
    if matches!(actor_role, ServerRole::Viewer) {
        return Err("viewer role is strictly read-only".into());
    }

    // Parse `[decisionId, inputObjOrStatus, note?]` or `[{ decisionId, ... }]`.
    let (decision_id, input_val, note_arg) = if let Some(first_str) = args.first().and_then(Value::as_str) {
        (
            first_str.to_owned(),
            args.get(1).cloned().unwrap_or(Value::Null),
            args.get(2).and_then(Value::as_str).map(str::to_owned),
        )
    } else if let Some(obj) = args.first().filter(|v| v.is_object()) {
        let id = obj
            .get("decisionId")
            .or_else(|| obj.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "missing decisionId".to_owned())?
            .to_owned();
        (id, obj.clone(), None)
    } else {
        return Err("missing decisionId".into());
    };
    // The caller's role was worked out for `project_id`, so only that project's cards may be answered with it.
    if !state.inner.decisions.get(&decision_id).map_err(|e| e.to_string())?.is_some_and(|d| d.project_id == project_id) {
        return Err("Decision not found.".into());
    }

    let mut status = Some(DecisionStatus::Resolved);
    let mut answers: Option<Vec<QuestionAnswer>> = None;
    let mut form_answer: Option<FormAnswer> = None;
    let mut chosen_side: Option<String> = None;
    let mut permission_resolution: Option<String> = None;
    let mut meeting_action: Option<String> = None;
    let mut note = note_arg;

    if let Some(s) = input_val.as_str() {
        match s {
            "dismissed" | "dismiss" | "deny" | "decline" => {
                status = Some(DecisionStatus::Dismissed);
                permission_resolution = Some(s.to_owned());
                meeting_action = Some(s.to_owned());
            }
            "allow-once" | "allow-for-task" => {
                permission_resolution = Some(s.to_owned());
            }
            "optionA" | "optionB" | "revise" | "waive-gate" => {
                chosen_side = Some(s.to_owned());
            }
            _ => {}
        }
    } else if input_val.is_object() {
        if let Some(st) = input_val.get("status").and_then(Value::as_str) {
            status = Some(match st {
                "dismissed" | "dismiss" => DecisionStatus::Dismissed,
                _ => DecisionStatus::Resolved,
            });
        }
        if let Some(n) = input_val.get("note").and_then(Value::as_str) {
            note = Some(n.to_owned());
        }
        if let Some(ans_val) = input_val.get("answers") {
            if let Ok(parsed) = serde_json::from_value::<Vec<QuestionAnswer>>(ans_val.clone()) {
                answers = Some(parsed);
            }
        }
        if let Some(fa) = input_val.get("formAnswer") {
            if fa.to_string().len() > arima_core::form::MAX_BYTES {
                return Err("form answer is larger than 32 KiB".into());
            }
            let parsed: FormAnswer = serde_json::from_value(fa.clone()).map_err(|e| format!("invalid formAnswer: {e}"))?;
            let action = parsed.action.as_str();
            if input_val.get("status").is_none() && matches!(action, "deny" | "decline" | "revise" | "reject") {
                status = Some(DecisionStatus::Dismissed);
            }
            if chosen_side.is_none() && matches!(action, "optionA" | "optionB" | "revise" | "waive" | "waive-gate") {
                chosen_side = Some(action.to_owned());
            }
            if meeting_action.is_none() && matches!(action, "join" | "snooze" | "decline") {
                meeting_action = Some(action.to_owned());
            }
            if permission_resolution.is_none() && matches!(action, "allow-once" | "allow-task" | "allow-for-task" | "deny") {
                permission_resolution = Some(action.to_owned());
            }
            form_answer = Some(parsed);
        }
        if let Some(cs) = input_val
            .get("chosenSide")
            .or_else(|| input_val.get("chosen_side"))
            .and_then(Value::as_str)
        {
            chosen_side = Some(cs.to_owned());
        }
        if let Some(res) = input_val
            .get("resolution")
            .or_else(|| input_val.get("permissionResolution"))
            .and_then(Value::as_str)
        {
            if res.eq_ignore_ascii_case("deny") {
                status = Some(DecisionStatus::Dismissed);
            }
            permission_resolution = Some(res.to_owned());
        }
        if let Some(ma) = input_val
            .get("meetingAction")
            .or_else(|| input_val.get("action"))
            .and_then(Value::as_str)
        {
            if ma.eq_ignore_ascii_case("decline") {
                status = Some(DecisionStatus::Dismissed);
            }
            meeting_action = Some(ma.to_owned());
        }
    }

    let resolved = state
        .inner
        .decisions
        .resolve(
            &decision_id,
            ResolveDecisionInput {
                status,
                answers,
                form_answer,
                chosen_side: chosen_side.clone(),
                permission_resolution,
                note: note.clone(),
            },
            actor_role,
        )
        .map_err(|e| e.to_string())?;

    // If this was a MeetingRequest card and the user clicked Join / Snooze / Decline, update the MeetingSession.
    if let DecisionPayload::MeetingRequest { ref meeting_id, .. } = resolved.payload {
        let act = meeting_action.as_deref().unwrap_or(
            if matches!(resolved.status, DecisionStatus::Dismissed) {
                "decline"
            } else {
                "join"
            },
        );
        let _ = handle_meeting_action(state, meeting_id, Some(act), None, actor_role);
    }

    crate::skills::on_decision(state, &resolved);
    crate::packs::on_decision(state, &resolved);

    // If this was a SecondOpinion / Disagreement card and the owner chose "waive-gate", record the gate waiver.
    if let DecisionPayload::SecondOpinion(ref so) | DecisionPayload::Disagreement(ref so) =
        resolved.payload
    {
        if chosen_side
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("waive-gate") || s.eq_ignore_ascii_case("waive"))
        {
            if let (Some(ref tid), Some(ref gid)) = (&so.task_id, &so.gate_id) {
                let _ = state.inner.gates.record_gate(
                    &resolved.project_id,
                    tid,
                    gid,
                    "waived",
                    "owner",
                    note.as_deref(),
                    None,
                );
            }
        }
    }

    // Deliver the user's structured decision answer to the agent's durable outbox.
    let answer_payload = json!({
        "decisionId": resolved.id,
        "status": resolved.status,
        "payload": resolved.payload,
        "answer": resolved.answer,
        "note": resolved.note,
    })
    .to_string();
    let _ = state.inner.supervisor.enqueue_outbox(
        &resolved.project_id,
        &resolved.from_id,
        OutboxMessageKind::DecisionAnswer,
        &answer_payload,
    );
    crate::delivery::kick(state, &resolved.project_id, &resolved.from_id);

    state
        .inner
        .ws_hub
        .broadcast_event(&WsServerEvent::DecisionUpdated { decision: resolved });

    Ok(())
}

fn exec_record_gate(
    state: &AppState,
    project_id: &str,
    actor_name: &str,
    actor_role: ServerRole,
    args: &[Value],
) -> Result<(), String> {
    if matches!(actor_role, ServerRole::Viewer) {
        return Err("viewer role is strictly read-only".into());
    }

    let (task_id, gate_id, gate_state, note, url) =
        if let Some(first_str) = args.first().and_then(Value::as_str) {
            (
                first_str,
                args.get(1).and_then(Value::as_str).unwrap_or("review"),
                args.get(2).and_then(Value::as_str).unwrap_or("passed"),
                args.get(3).and_then(Value::as_str),
                args.get(4).and_then(Value::as_str),
            )
        } else if let Some(obj) = args.first().filter(|v| v.is_object()) {
            (
                obj.get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "missing taskId".to_owned())?,
                obj.get("gateId").and_then(Value::as_str).unwrap_or("review"),
                obj.get("state").and_then(Value::as_str).unwrap_or("passed"),
                obj.get("note").and_then(Value::as_str),
                obj.get("url").and_then(Value::as_str),
            )
        } else {
            return Err("missing taskId".into());
        };

    if is_owner_only_gate(gate_id, gate_state, "you") && !matches!(actor_role, ServerRole::Owner) {
        return Err("this gate or waiver is restricted to the owner".into());
    }

    state
        .inner
        .gates
        .record_gate(
            project_id,
            task_id,
            gate_id,
            gate_state,
            actor_name,
            note,
            url,
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn exec_start_meeting(
    state: &AppState,
    project_id: &str,
    actor_name: &str,
    args: &[Value],
) -> Result<(), String> {
    let first = args.first().cloned().unwrap_or_else(|| json!({}));
    let (kind, title, urgency, participant_ids, agenda_titles, voice_enabled) =
        if let Some(title_str) = first.as_str() {
            (
                MeetingKind::Standup,
                title_str.to_owned(),
                MeetingUrgency::Normal,
                vec!["lead".into(), "coder".into(), "verifier".into()],
                vec![],
                false,
            )
        } else {
            let kind = match first
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("standup")
            {
                "discussion" => MeetingKind::Discussion,
                "kickoff" => MeetingKind::Kickoff,
                "review" => MeetingKind::Review,
                _ => MeetingKind::Standup,
            };
            let title = first
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Team Standup")
                .to_owned();
            let urgency = match first
                .get("urgency")
                .and_then(Value::as_str)
                .unwrap_or("normal")
            {
                "low" => MeetingUrgency::Low,
                "high" => MeetingUrgency::High,
                _ => MeetingUrgency::Normal,
            };
            let participants = first
                .get("participantIds")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_else(|| vec!["lead".into(), "coder".into(), "verifier".into()]);
            let agenda = first
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
            let voice = first
                .get("voiceEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            (kind, title, urgency, participants, agenda, voice)
        };

    start_or_request_meeting(
        state,
        StartMeetingInput {
            project_id: project_id.to_owned(),
            kind,
            title,
            urgency,
            moderator_id: "lead".into(),
            participant_ids,
            requested_by: actor_name.to_owned(),
            agenda_titles,
            voice_enabled,
            voice_provider: VoiceProvider::BrowserWebSpeech,
        },
        true,
    )?;
    Ok(())
}

fn exec_join_meeting(
    state: &AppState,
    args: &[Value],
    actor_role: ServerRole,
) -> Result<(), String> {
    let (meeting_id, action, voice_enabled) =
        if let Some(mid) = args.first().and_then(Value::as_str) {
            let act = args.get(1).and_then(Value::as_str);
            let voice = args
                .get(2)
                .and_then(Value::as_bool)
                .or_else(|| args.get(1).and_then(|v| v.get("voiceEnabled")).and_then(Value::as_bool));
            (mid.to_owned(), act.map(str::to_owned), voice)
        } else if let Some(obj) = args.first().filter(|v| v.is_object()) {
            let mid = obj
                .get("meetingId")
                .or_else(|| obj.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| "missing meetingId".to_owned())?
                .to_owned();
            let act = obj
                .get("action")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let voice = obj.get("voiceEnabled").and_then(Value::as_bool);
            (mid, act, voice)
        } else {
            return Err("missing meetingId".into());
        };

    handle_meeting_action(
        state,
        &meeting_id,
        action.as_deref(),
        voice_enabled,
        actor_role,
    )?;
    Ok(())
}

fn exec_add_meeting_turn(
    state: &AppState,
    actor_name: &str,
    args: &[Value],
) -> Result<(), String> {
    let (meeting_id, body_markdown, speaker_id, decision_id) =
        if let Some(mid) = args.first().and_then(Value::as_str) {
            let body = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| "missing turn bodyMarkdown".to_owned())?
                .to_owned();
            let speaker = args
                .get(2)
                .and_then(Value::as_str)
                .unwrap_or("you")
                .to_owned();
            let dec_id = args
                .get(3)
                .and_then(Value::as_str)
                .map(str::to_owned);
            (mid.to_owned(), body, speaker, dec_id)
        } else if let Some(obj) = args.first().filter(|v| v.is_object()) {
            let mid = obj
                .get("meetingId")
                .and_then(Value::as_str)
                .ok_or_else(|| "missing meetingId".to_owned())?
                .to_owned();
            let body = obj
                .get("bodyMarkdown")
                .or_else(|| obj.get("text"))
                .and_then(Value::as_str)
                .ok_or_else(|| "missing bodyMarkdown".to_owned())?
                .to_owned();
            let speaker = obj
                .get("speakerId")
                .and_then(Value::as_str)
                .unwrap_or(actor_name)
                .to_owned();
            let dec_id = obj
                .get("decisionId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            (mid, body, speaker, dec_id)
        } else {
            return Err("missing meetingId".into());
        };

    add_turn_and_refresh_minutes(
        state,
        &meeting_id,
        &speaker_id,
        None,
        None,
        &body_markdown,
        decision_id,
        None,
    )?;
    Ok(())
}

fn exec_commit_meeting_minutes(state: &AppState, args: &[Value]) -> Result<(), String> {
    let (meeting_id, minutes_override) =
        if let Some(mid) = args.first().and_then(Value::as_str) {
            let mins = args
                .get(1)
                .cloned()
                .and_then(|v| serde_json::from_value::<MeetingMinutes>(v).ok());
            (mid.to_owned(), mins)
        } else if let Some(obj) = args.first().filter(|v| v.is_object()) {
            let mid = obj
                .get("meetingId")
                .or_else(|| obj.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| "missing meetingId".to_owned())?
                .to_owned();
            let mins = obj
                .get("minutes")
                .cloned()
                .and_then(|v| serde_json::from_value::<MeetingMinutes>(v).ok());
            (mid, mins)
        } else {
            return Err("missing meetingId".into());
        };

    commit_minutes_and_broadcast(state, &meeting_id, minutes_override)?;
    Ok(())
}

fn exec_submit_visual_feedback(
    state: &AppState,
    project_id: &str,
    author_user_id: &str,
    args: &[Value],
) -> Result<(), String> {
    let input_val = args
        .first()
        .ok_or_else(|| "missing feedback input".to_owned())?;
    let input = crate::preview::parse_ws_feedback_input(input_val)?;
    crate::preview::create_and_route_feedback(state, project_id, author_user_id, input)?;
    Ok(())
}

fn inspect_command_context(
    state: &AppState,
    cmd: &str,
    args: &[Value],
    project_id: Option<&str>,
) -> (bool, bool) {
    let mut target_agent_local = false;
    let mut decision_owner_only = false;

    if matches!(
        cmd,
        "setEnvVar" | "removeEnvVar" | "openEnvFile" | "sendTerminalInput" | "updateAgent"
    ) {
        if let Some(first) = args.first() {
            if first.is_null() {
                target_agent_local = true;
            } else if let Some(agent_or_term) = first.as_str() {
                if agent_or_term.starts_with("shell:") {
                    target_agent_local = true;
                } else if let Some(pid) = project_id {
                    target_agent_local = is_agent_local_in_project(state, pid, agent_or_term);
                }
            }
        }
        if cmd == "updateAgent" {
            if let Some(patch) = args.get(1).and_then(Value::as_object) {
                if patch.get("mode").and_then(Value::as_str) == Some("local")
                    || patch.contains_key("workspacePath")
                {
                    target_agent_local = true;
                }
            }
        }
    }

    if matches!(cmd, "addAgent" | "setTeamMode") {
        let mode = args
            .first()
            .and_then(|v| v.as_str().or_else(|| v.get("mode").and_then(Value::as_str)));
        if mode == Some("local") {
            target_agent_local = true;
        }
    }

    if matches!(
        cmd,
        "resolveActionItem" | "resolveDecision" | "answerDecision"
    ) {
        let dec_id = args
            .first()
            .and_then(|v| {
                v.as_str()
                    .or_else(|| v.get("decisionId").and_then(Value::as_str))
                    .or_else(|| v.get("id").and_then(Value::as_str))
            });
        if let Some(id) = dec_id {
            decision_owner_only = is_decision_owner_only(state, id);
        }
        if let Some(second) = args.get(1) {
            let side = second.as_str().or_else(|| {
                second
                    .get("chosenSide")
                    .or_else(|| second.get("chosen_side"))
                    .and_then(Value::as_str)
            });
            if side.is_some_and(|s| {
                s.eq_ignore_ascii_case("waive-gate") || s.eq_ignore_ascii_case("waive")
            }) {
                decision_owner_only = true;
            }
        }
    } else if cmd == "recordGate" {
        decision_owner_only = true;
    }

    (target_agent_local, decision_owner_only)
}

/// Whether the signed-in user (none: the bootstrap session, which is the owner) is Owner of the project.
fn is_owner_in(state: &AppState, user_id: Option<&str>, project_id: &str) -> bool {
    let Some(uid) = user_id else { return true };
    let Some(user) = state.inner.auth.get_user_by_id(uid).ok().flatten().filter(|u| !u.disabled) else { return false };
    let project_role = state.inner.auth.get_project_role(project_id, uid).ok().flatten();
    effective_role(user.role, project_role) == ServerRole::Owner
}

fn is_agent_local_in_project(state: &AppState, project_id: &str, agent_id: &str) -> bool {
    let Ok(Some(cfg_raw)) = state.inner.db.read(|conn| {
        use rusqlite::OptionalExtension;
        conn.query_row(
            "SELECT config_json FROM projects WHERE id = ?1",
            [project_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(arima_db::DbError::from)
    }) else {
        return false;
    };

    let Ok(cfg) = serde_json::from_str::<Value>(&cfg_raw) else {
        return false;
    };
    cfg.get("team")
        .and_then(Value::as_array)
        .is_some_and(|team| {
            team.iter().any(|a| {
                a.get("id").and_then(Value::as_str) == Some(agent_id)
                    && a.get("mode").and_then(Value::as_str) == Some("local")
            })
        })
}

fn is_decision_owner_only(state: &AppState, decision_id: &str) -> bool {
    state
        .inner
        .decisions
        .get(decision_id)
        .ok()
        .flatten()
        .is_some_and(|d| d.owner_only)
}

/// Rebuilds `project_id`'s snapshot and pushes it to every socket watching that project.
pub(crate) fn refresh(state: &AppState, project_id: &str) {
    let snapshot = build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
}

#[must_use]
pub fn build_initial_snapshot(state: &AppState, requested_project: Option<&str>) -> Value {
    let proj = requested_project
        .and_then(|req| {
            state
                .inner
                .db
                .read(|conn| {
                    use rusqlite::OptionalExtension;
                    conn.query_row(
                        "SELECT id, slug, name, root_path FROM projects WHERE id = ?1 OR slug = ?1 LIMIT 1",
                        [req],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
                    )
                    .optional()
                    .map_err(arima_db::DbError::from)
                })
                .ok()
                .flatten()
        })
        .or_else(|| state.default_project())
        .unwrap_or_else(|| {
            (
                "repo".into(),
                "repo".into(),
                "ArimaOps".into(),
                ".".into(),
            )
        });

    let project_id = &proj.0;
    let visual_decisions = state
        .inner
        .decisions
        .list_by_project(project_id, None)
        .unwrap_or_default();
    let meetings = state
        .inner
        .meetings
        .list_sessions(project_id)
        .unwrap_or_default();
    let meeting_turns = state
        .inner
        .meetings
        .list_turns_by_project(project_id)
        .unwrap_or_default();
    let github_sync = state
        .inner
        .github
        .load_state(project_id)
        .unwrap_or_default();

    let boards = crate::team::boards_for(state, project_id);
    let tasks = crate::team::tasks_for(state, project_id);

    let preview_targets = state
        .inner
        .preview_registry
        .list_registered(project_id, &state.preview_origin());
    let scope = state.inner.findings.get_scope(project_id).ok();
    let findings = state
        .inner
        .findings
        .list_findings(project_id)
        .unwrap_or_default();
    let mem_settings = state
        .inner
        .memory
        .get_settings(project_id)
        .unwrap_or_default();
    let promoted_lessons = state
        .inner
        .memory
        .list_promoted_lessons(project_id)
        .unwrap_or_default();
    let backup_names: Vec<String> = crate::backups::list_stored_backups(state)
        .unwrap_or_default()
        .into_iter()
        .map(|b| b.filename)
        .collect();

    let now = Utc::now().to_rfc3339();
    let team_model = crate::team::load(state, project_id);
    let team: Vec<Value> = team_model.as_ref().map(|m| m.team.clone()).unwrap_or_default();
    let agent_ids: Vec<String> = team.iter().filter_map(|a| a["id"].as_str().map(str::to_owned)).collect();
    let agents: Vec<Value> = team
        .iter()
        .filter_map(|a| a["id"].as_str())
        .map(|id| {
            let mut status = crate::team::fresh_status(id);
            status["session"] = state.inner.runtime.session_info(project_id, id);
            if state.inner.runtime.is_running(project_id, id) {
                status["note"] = json!("Session running");
            }
            status
        })
        .collect();
    let rules = team_model.as_ref().map_or_else(
        || json!({
            "findings": !findings.is_empty(),
            "scope": scope.as_ref().is_some_and(|s| !s.in_scope.is_empty()),
            "plans": false,
            "outbound": "drafts-only"
        }),
        |m| m.rules.clone(),
    );
    let workflow = team_model.as_ref().map_or_else(
        || json!({
            "mode": "github-pr",
            "review": { "enabled": true, "tool": "human", "command": "" },
            "merge": { "by": "human" },
            "deploy": { "enabled": false, "tool": "custom", "command": "", "perAgentEnvironments": false }
        }),
        |m| m.workflow.clone(),
    );
    let mut project = json!({
        "id": proj.0,
        "name": proj.2,
        "repo": proj.1,
        "path": proj.3,
        "hqPort": state.inner.config.port,
        "scope": scope.as_ref().filter(|s| !s.in_scope.is_empty() || !s.out_of_scope.is_empty() || !s.notes.is_empty())
    });
    if let (Some(extras), Some(base)) = (team_model.as_ref().and_then(|m| m.project.as_object()), project.as_object_mut()) {
        base.extend(extras.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    json!({
        "type": "snapshot",
        "snapshot": {
            "welcome": team_model.is_none(),
            "templateLibrary": crate::integrations::template_library(state),
            "skillPacks": crate::skills::pack_views(state, project_id),
            "packs": crate::packs::snapshot(state, project_id),
            "mcp": crate::integrations::mcp_state(state, project_id, &team, &now),
            "setup": crate::integrations::setup_state(state, &now),
            "features": { "shell": false, "sandboxTab": false },
            "sbx": crate::secrets::sbx_state(state, project_id, &agent_ids, &now),
            "accessRequests": crate::egress::access_requests(state, project_id),
            "accounts": crate::secrets::accounts_state(state),
            "config": {
                "project": project,
                "team": team,
                "template": team_model.as_ref().map(|m| m.template.clone()),
                "rules": rules,
                "workflow": workflow,
                "stack": team_model.as_ref().and_then(|m| m.stack.clone())
            },
            "agents": agents,
            "goals": crate::planning::goals_for(state, project_id),
            "spend": crate::planning::spend_state(state, project_id, project.get("spendCaps")),
            "company": crate::planning::company(state),
            "boards": boards,
            "tasks": tasks,
            "pullRequests": github_sync.pull_requests,
            "environments": [],
            "messages": crate::delivery::messages_for(state, &proj.0),
            "activity": [],
            "findings": findings,
            "memory": {
                "extraction": mem_settings.extraction,
                "keepOut": mem_settings.keep_out,
                "backups": backup_names
            },
            "lessons": {
                "templateId": "default",
                "enabled": project.get("lessonsEnabled").and_then(Value::as_bool).unwrap_or(true),
                "running": false,
                "pending": 0,
                "approved": promoted_lessons.iter().map(|l| json!({
                    "id": l.id,
                    "type": l.mem_type,
                    "text": l.text,
                })).collect::<Vec<_>>()
            },
            "visualDecisions": visual_decisions,
            "meetings": meetings,
            "meetingTurns": meeting_turns,
            "previewTargets": preview_targets
        }
    })
}

pub fn role_can_operate(role: ServerRole) -> bool {
    matches!(role, ServerRole::Owner | ServerRole::Operator)
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    #[test]
    fn secret_values_never_reach_the_audit_log() {
        let a = audit_args("setEnvVar", &[json!("cipher"), json!("TOKEN"), json!("s3cret-value")]);
        assert!(!a.to_string().contains("s3cret"));
        assert_eq!(a[1], "TOKEN");
        let b = audit_args("setSecret", &[Value::Null, json!("github"), json!("ghp_abc")]);
        assert!(!b.to_string().contains("ghp_"));
        let c = audit_args("saveAccount", &[json!({ "id": "work", "provider": "anthropic", "secret": "sk-ant-zzz", "fields": { "region": "x" } })]);
        assert!(!c.to_string().contains("sk-ant") && c.to_string().contains("work"));
        let d = audit_args("testAccountKey", &[json!("anthropic"), json!("sk-ant-secret-value"), json!("req-1")]);
        assert!(!d.to_string().contains("sk-ant") && d.to_string().contains("anthropic"));
    }
}

#[cfg(test)]
mod project_scope_tests {
    use super::*;
    use arima_core::{DecisionPayload, DecisionStatus, VisualDecision};

    fn card(project_id: &str) -> VisualDecision {
        VisualDecision {
            id: format!("dec-{project_id}"),
            project_id: project_id.to_owned(),
            from_id: "lead".into(),
            task_id: None,
            title: "Which way?".into(),
            details: String::new(),
            waiting: true,
            owner_only: false,
            status: DecisionStatus::Open,
            payload: DecisionPayload::Info { markdown: "x".into() },
            form: None,
            answer: None,
            note: None,
            created_at: Utc::now().to_rfc3339(),
            closed_at: None,
        }
    }

    #[tokio::test]
    async fn a_card_is_answered_only_from_its_own_project() {
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([4u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("A", "a", "/w/a").unwrap();
        let a = state.default_project().unwrap().0;
        state.inner.db.transaction(|c| c.execute("INSERT INTO projects (id, slug, name, root_path, created_at, updated_at) VALUES ('proj-b', 'b', 'B', '/w/b', 9, 9)", []).map_err(arima_db::DbError::from)).unwrap();
        let b_card = state.inner.decisions.upsert(&card("proj-b")).unwrap();

        let err = exec_answer_decision(&state, &a, &[json!(b_card.id), json!("optionA")], ServerRole::Owner).unwrap_err();
        assert_eq!(err, "Decision not found.");
        assert_eq!(state.inner.decisions.get(&b_card.id).unwrap().unwrap().status, DecisionStatus::Open, "B's card is untouched");
        exec_answer_decision(&state, "proj-b", &[json!(b_card.id), json!("optionA")], ServerRole::Operator).unwrap();
        assert_eq!(state.inner.decisions.get(&b_card.id).unwrap().unwrap().status, DecisionStatus::Resolved);
    }

    #[tokio::test]
    async fn an_operator_cannot_add_a_new_skill_ref_to_a_role() {
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([4u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("A", "a", "/w/a").unwrap();
        let pid = state.default_project().unwrap().0;
        crate::team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
        let role = crate::team::load(&state, &pid).unwrap().template["roles"][0].clone();
        let args = [role["id"].clone(), json!({ "skills": ["evil/repo@exfil"] })];
        let err = execute_ws_command(&state, &pid, None, "op", ServerRole::Operator, "updateRole", &args).await.unwrap_err();
        assert!(err.contains("Only the owner"), "{err}");
        assert_eq!(crate::team::load(&state, &pid).unwrap().template["roles"][0], role, "the role is unchanged");
    }

    #[tokio::test]
    async fn copying_a_tool_server_needs_owner_in_both_projects() {
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([4u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("A", "a", "/w/a").unwrap();
        let a = state.default_project().unwrap().0;
        state.inner.db.transaction(|c| {
            c.execute("INSERT INTO projects (id, slug, name, root_path, created_at, updated_at) VALUES ('proj-b', 'b', 'B', '/w/b', 9, 9)", [])?;
            c.execute("INSERT INTO users (id, name, password_hash, role, created_at) VALUES ('u-op', 'op', 'h', 'operator', 1)", [])
        }.map_err(arima_db::DbError::from)).unwrap();
        crate::integrations::add_mcp(&state, &a, &[json!({ "name": "docs", "url": "https://docs.example/mcp", "apiKey": "a-key" })]).unwrap();
        state.inner.auth.set_project_role("proj-b", "u-op", ServerRole::Owner).unwrap();
        let copy = [json!(a), json!("docs")];

        let err = execute_ws_command(&state, "proj-b", Some("u-op"), "op", ServerRole::Owner, "copyMcp", &copy).await.unwrap_err();
        assert!(err.contains("Owner role in the project it comes from"), "{err}");
        assert!(crate::integrations::tool_servers(&state, "proj-b").is_empty(), "Owner of B only: A's key stays in A");

        state.inner.auth.set_project_role(&a, "u-op", ServerRole::Owner).unwrap();
        execute_ws_command(&state, "proj-b", Some("u-op"), "op", ServerRole::Owner, "copyMcp", &copy).await.unwrap();
        assert!(crate::integrations::tool_servers(&state, "proj-b")[0].has_key);
    }

    #[test]
    fn decision_events_reach_only_their_projects_sockets() {
        let hub = WsHub::default();
        let (tx_a, mut rx_a) = mpsc::channel(8);
        let (tx_b, mut rx_b) = mpsc::channel(8);
        hub.register("dev-a", tx_a, "proj-a", true);
        hub.register("dev-b", tx_b, "proj-b", true);
        hub.broadcast_event(&WsServerEvent::DecisionUpdated { decision: card("proj-a") });
        assert!(matches!(rx_a.try_recv(), Ok(WsOutbound::Text(t)) if t.contains("dec-proj-a")));
        assert!(rx_b.try_recv().is_err(), "project B's sockets never see A's card");
    }

    #[test]
    fn meeting_turns_reach_only_their_projects_sockets() {
        use arima_core::{MeetingKind, MeetingUrgency, VoiceProvider};
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([4u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("A", "a", "/w/a").unwrap();
        let a = state.default_project().unwrap().0;
        let (tx_b, mut rx_b) = mpsc::channel(64);
        state.inner.ws_hub.register("dev-b", tx_b, "proj-b", true);
        let input = crate::meetings::StartMeetingInput {
            project_id: a.clone(),
            kind: MeetingKind::Standup,
            title: "Standup".into(),
            urgency: MeetingUrgency::Normal,
            moderator_id: "lead".into(),
            participant_ids: vec!["lead".into()],
            requested_by: "lead".into(),
            agenda_titles: vec!["Plans".into()],
            voice_enabled: false,
            voice_provider: VoiceProvider::BrowserWebSpeech,
        };
        let (meeting, _, _) = crate::meetings::start_or_request_meeting(&state, input, true).unwrap();
        crate::meetings::add_turn_and_refresh_minutes(&state, &meeting.id, "lead", None, None, "secret plan", None, None).unwrap();
        while let Ok(WsOutbound::Text(t)) = rx_b.try_recv() {
            assert!(!t.contains("secret plan") && !t.contains(&meeting.id), "project B saw A's meeting: {t}");
        }
    }
}
