// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::SocketAddr;

use arima_auth::VaultKey;
use arima_core::{
    AgentInstruction, DecisionStatus, MeetingMinutes, MeetingStatus, ProposedDecision,
    ProposedTask, QuestionAnswer, WsClientMessage,
};
use arima_db::{Db, UsageEventInput};
use arima_server::github::compute_github_signature;
use arima_server::{router_with_state, AppState, ServerConfig};
use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMsg;

const WEBHOOK_SECRET: &str = "test-github-webhook-secret-key";

async fn spawn_m2_server() -> (SocketAddr, AppState, TempDir) {
    let dir = TempDir::new().unwrap();
    let db = Db::open(&dir.path().join("arima.db")).unwrap();
    let vault = VaultKey::from_bytes([77u8; 32]);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let cfg = ServerConfig {
        port: addr.port(),
        preview_port: addr.port() + 1,
        bootstrap_token: "m2-boot-token".into(),
        local_origins: vec![
            format!("http://127.0.0.1:{}", addr.port()),
            format!("http://localhost:{}", addr.port()),
        ],
        allowed_origins: vec![],
        preview_origin: Some(format!("http://127.0.0.1:{}", addr.port() + 1)),
        trust_proxy: false,
        same_origin: false,
        data_root: Some(dir.path().to_path_buf()),
        allow_private_connections: false,
    };
    let state = AppState::new(db, vault, cfg);
    state
        .inner
        .github
        .set_webhook_secret(WEBHOOK_SECRET);
    state
        .ensure_default_project("Alpha", "alpha", "/tmp/alpha")
        .unwrap();

    let app =
        router_with_state(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, state, dir)
}

async fn http_req(
    addr: SocketAddr,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    origin: Option<&str>,
    extra_headers: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, Option<String>, Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    if let Some(c) = cookie {
        req.push_str(&format!("Cookie: hq_sid={c}\r\n"));
    }
    if let Some(o) = origin {
        req.push_str(&format!("Origin: {o}\r\n"));
    }
    for (k, v) in extra_headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if !payload.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    req.push_str("\r\n");
    req.push_str(&payload);
    stream.write_all(req.as_bytes()).await.unwrap();

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw);
    let (head, body_str) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.lines();
    let status_line = lines.next().unwrap();
    let code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let mut set_cookie = None;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            if k.eq_ignore_ascii_case("set-cookie") {
                if let Some(kv) = v.trim().split(';').next() {
                    if let Some(tok) = kv.strip_prefix("hq_sid=") {
                        set_cookie = Some(tok.to_owned());
                    }
                }
            }
        }
    }
    let json_val = serde_json::from_str(body_str).unwrap_or(Value::Null);
    (StatusCode::from_u16(code).unwrap(), set_cookie, json_val)
}

async fn connect_ws(
    addr: SocketAddr,
    cookie: &str,
    origin: &str,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Value,
) {
    let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
    req.headers_mut()
        .insert("Cookie", format!("hq_sid={cookie}").parse().unwrap());
    req.headers_mut().insert("Origin", origin.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    let first = ws.next().await.unwrap().unwrap();
    let snap: Value = serde_json::from_str(first.to_text().unwrap()).unwrap();
    assert_eq!(snap["type"], "snapshot");
    (ws, snap)
}

async fn recv_until_ack(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    expected_id: &str,
) -> Value {
    loop {
        let frame = ws.next().await.unwrap().unwrap();
        if let WsMsg::Text(t) = frame {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["type"] == "command-ack" && v["id"] == expected_id {
                return v;
            }
        }
    }
}

#[tokio::test]
async fn m2_end_to_end_mcp_decisions_meetings_minutes_commit_gates_usage_and_github_webhook() {
    let (addr, state, dir) = spawn_m2_server().await;
    let origin = format!("http://127.0.0.1:{}", addr.port());

    // 1. Setup Owner, Operator, and Viewer sessions.
    let (s, boot_cookie, _) = http_req(
        addr,
        "POST",
        "/api/login",
        None,
        Some(&origin),
        &[],
        Some(json!({ "token": "m2-boot-token" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let owner_cookie = boot_cookie.unwrap();

    for (name, pw, role) in [
        ("OwnerM2", "owner-password-1234", "owner"),
        ("OpM2", "operator-password-123", "operator"),
        ("ViewM2", "viewer-password-123", "viewer"),
    ] {
        let (st, _, _) = http_req(
            addr,
            "POST",
            "/api/users",
            Some(&owner_cookie),
            Some(&origin),
            &[],
            Some(json!({ "name": name, "password": pw, "role": role })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }

    let (_, op_cookie, _) = http_req(
        addr,
        "POST",
        "/api/auth/login",
        None,
        Some(&origin),
        &[],
        Some(json!({ "name": "OpM2", "password": "operator-password-123" })),
    )
    .await;
    let op_cookie = op_cookie.unwrap();

    let (_, viewer_cookie, _) = http_req(
        addr,
        "POST",
        "/api/auth/login",
        None,
        Some(&origin),
        &[],
        Some(json!({ "name": "ViewM2", "password": "viewer-password-123" })),
    )
    .await;
    let viewer_cookie = viewer_cookie.unwrap();

    let (mut owner_ws, _) = connect_ws(addr, &owner_cookie, &origin).await;
    let (mut op_ws, _) = connect_ws(addr, &op_cookie, &origin).await;
    let (mut viewer_ws, _) = connect_ws(addr, &viewer_cookie, &origin).await;

    // 2. Issue MCP bearer token for ("proj-alpha", "lead") and invoke `ask_user`.
    let lead_mcp_token = state.inner.mcp.issue_agent_token("proj-alpha", "lead");
    let auth_header = format!("Bearer {lead_mcp_token}");

    let (st, _, ask_rpc) = http_req(
        addr,
        "POST",
        "/mcp",
        None,
        None,
        &[("Authorization", &auth_header)],
        Some(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "ask_user",
                "arguments": {
                    "title": "Database Strategy",
                    "details": "Choose our persistence engine",
                    "taskId": "T01",
                    "questions": [
                        {
                            "id": "q-db",
                            "prompt": "Which engine should we use?",
                            "multiSelect": false,
                            "allowOther": true,
                            "options": [
                                { "id": "sqlite", "label": "SQLite WAL (Recommended)", "recommended": true },
                                { "id": "postgres", "label": "PostgreSQL", "recommended": false }
                            ]
                        }
                    ]
                }
            }
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let q_decision_id = ask_rpc["result"]["structuredContent"]["decisionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Viewer must be blocked from answering the decision via BOTH WS and REST.
    viewer_ws
        .send(WsMsg::Text(
            serde_json::to_string(&WsClientMessage {
                id: "v-ans-1".into(),
                cmd: "answerDecision".into(),
                args: vec![
                    json!(q_decision_id),
                    json!({ "status": "resolved", "note": "viewer attempt" }),
                ],
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let v_ack = recv_until_ack(&mut viewer_ws, "v-ans-1").await;
    assert_eq!(v_ack["ok"], false, "viewer must not resolve decisions over WS");

    let (v_rest_st, _, _) = http_req(
        addr,
        "POST",
        &format!("/api/projects/proj-alpha/decisions/{q_decision_id}/resolve"),
        Some(&viewer_cookie),
        Some(&origin),
        &[],
        Some(json!({ "status": "resolved" })),
    )
    .await;
    assert_eq!(v_rest_st, StatusCode::FORBIDDEN);

    // Operator can answer a non-owner_only Question card via WS `answerDecision`.
    let answers = vec![QuestionAnswer {
        question_id: "q-db".into(),
        selected_option_ids: vec!["sqlite".into()],
        other_text: None,
    }];
    op_ws
        .send(WsMsg::Text(
            serde_json::to_string(&WsClientMessage {
                id: "op-ans-1".into(),
                cmd: "answerDecision".into(),
                args: vec![
                    json!(q_decision_id),
                    json!({
                        "status": "resolved",
                        "answers": answers,
                        "note": "Use SQLite WAL"
                    }),
                ],
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let op_ack = recv_until_ack(&mut op_ws, "op-ans-1").await;
    assert_eq!(op_ack["ok"], true);

    let resolved_q = state.inner.decisions.get(&q_decision_id).unwrap().unwrap();
    assert_eq!(resolved_q.status, DecisionStatus::Resolved);
    assert_eq!(
        state.inner.outbox.pending_count("proj-alpha", "lead").unwrap(),
        1,
        "answering decision must enqueue DecisionAnswer into lead's outbox"
    );

    // 3. Agent calls `report_disagreement` with `canWaiveGate: true` (marks decision `owner_only: true`).
    let (st, _, dis_rpc) = http_req(
        addr,
        "POST",
        "/mcp",
        None,
        None,
        &[("Authorization", &auth_header)],
        Some(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "report_disagreement",
                "arguments": {
                    "title": "Auth token TTL disagreement",
                    "details": "Lead vs Reviewer on session expiry",
                    "taskId": "T01",
                    "gateId": "review",
                    "canWaiveGate": true,
                    "optionA": {
                        "label": "24h Rolling Cookie",
                        "authorId": "lead",
                        "summary": "Balanced UX and security",
                        "rationaleMarkdown": "## Option A\nFull markdown rationale with code block.",
                        "risks": ["Longer window"]
                    },
                    "optionB": {
                        "label": "1h Strict Cookie",
                        "authorId": "reviewer",
                        "summary": "Short session",
                        "rationaleMarkdown": "## Option B\nFrequent re-auth required.",
                        "risks": ["Interrupts deep work"]
                    }
                }
            }
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let dis_id = dis_rpc["result"]["structuredContent"]["decisionId"].as_str().unwrap().to_owned();

    // Operator MUST be blocked from resolving `owner_only` disagreement or waiving gate!
    op_ws
        .send(WsMsg::Text(
            serde_json::to_string(&WsClientMessage {
                id: "op-dis-1".into(),
                cmd: "answerDecision".into(),
                args: vec![
                    json!(dis_id),
                    json!({ "chosenSide": "waive-gate", "note": "op forge attempt" }),
                ],
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let op_dis_ack = recv_until_ack(&mut op_ws, "op-dis-1").await;
    assert_eq!(
        op_dis_ack["ok"], false,
        "operator must be blocked from owner_only decision / gate waiver"
    );

    // Agent token MUST also be blocked from forging an owner gate waiver via MCP `record_gate`!
    let (_, _, forged_gate_rpc) = http_req(
        addr,
        "POST",
        "/mcp",
        None,
        None,
        &[("Authorization", &auth_header)],
        Some(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "record_gate",
                "arguments": {
                    "taskId": "T01",
                    "gateId": "merge",
                    "state": "waived",
                    "note": "forged waiver"
                }
            }
        })),
    )
    .await;
    assert_eq!(forged_gate_rpc["error"]["code"], -32003);

    // Agent CAN record a standard `verify` gate pass with unlimited rationale.
    let long_rationale = "Verified all 53 checks.\n".repeat(40);
    let (_, _, valid_gate_rpc) = http_req(
        addr,
        "POST",
        "/mcp",
        None,
        None,
        &[("Authorization", &auth_header)],
        Some(json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "record_gate",
                "arguments": {
                    "taskId": "T01",
                    "gateId": "verify",
                    "state": "passed",
                    "note": long_rationale
                }
            }
        })),
    )
    .await;
    assert_eq!(valid_gate_rpc["result"]["structuredContent"]["ok"], true);

    // Owner resolves the `owner_only` disagreement with `waive-gate` -> succeeds and records gate waiver!
    owner_ws
        .send(WsMsg::Text(
            serde_json::to_string(&WsClientMessage {
                id: "own-dis-1".into(),
                cmd: "answerDecision".into(),
                args: vec![
                    json!(dis_id),
                    json!({ "chosenSide": "waive-gate", "note": "Owner approved Option A and waived gate" }),
                ],
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let own_dis_ack = recv_until_ack(&mut owner_ws, "own-dis-1").await;
    assert_eq!(own_dis_ack["ok"], true);

    let t01_gates = state
        .inner
        .gates
        .list_for_task("proj-alpha", "T01")
        .unwrap();
    assert_eq!(t01_gates.len(), 2);

    // 4. Agent calls MCP `request_meeting` -> Join -> Turns -> 1-Click `MeetingMinutes` Atomic Commit.
    let (_, _, mtg_rpc) = http_req(
        addr,
        "POST",
        "/mcp",
        None,
        None,
        &[("Authorization", &auth_header)],
        Some(json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "request_meeting",
                "arguments": {
                    "title": "Architecture Alignment Standup",
                    "kind": "standup",
                    "urgency": "high",
                    "participantIds": ["lead", "coder", "verifier"],
                    "agenda": ["Finalize M2 contracts", "Unblock coder on outbox"]
                }
            }
        })),
    )
    .await;
    let meeting_id = mtg_rpc["result"]["structuredContent"]["meetingId"].as_str().unwrap().to_owned();
    let mtg_dec_id = mtg_rpc["result"]["structuredContent"]["decisionId"].as_str().unwrap().to_owned();

    // Owner joins the requested meeting via WS `joinMeeting`.
    owner_ws
        .send(WsMsg::Text(
            serde_json::to_string(&WsClientMessage {
                id: "own-join-1".into(),
                cmd: "joinMeeting".into(),
                args: vec![json!(meeting_id), json!("join"), json!(true)],
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let join_ack = recv_until_ack(&mut owner_ws, "own-join-1").await;
    assert_eq!(join_ack["ok"], true);

    let live_session = state
        .inner
        .meetings
        .get_session(&meeting_id)
        .unwrap()
        .unwrap();
    assert_eq!(live_session.status, MeetingStatus::Live);
    assert!(live_session.voice_enabled);
    // Linked MeetingRequest VisualDecision is automatically resolved on join.
    let linked_dec = state.inner.decisions.get(&mtg_dec_id).unwrap().unwrap();
    assert_eq!(linked_dec.status, DecisionStatus::Resolved);

    // Add moderated turn via WS `addMeetingTurn`.
    owner_ws
        .send(WsMsg::Text(
            serde_json::to_string(&WsClientMessage {
                id: "own-turn-1".into(),
                cmd: "addMeetingTurn".into(),
                args: vec![
                    json!(meeting_id),
                    json!("Ship the SQLite outbox and certify the epoch invariant."),
                    json!("you"),
                    Value::Null,
                ],
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let turn_ack = recv_until_ack(&mut owner_ws, "own-turn-1").await;
    assert_eq!(turn_ack["ok"], true);

    let turns = state.inner.meetings.list_turns(&meeting_id).unwrap();
    assert_eq!(turns.len(), 2); // Lead opening turn + owner turn

    // Commit 1-click MeetingMinutes via WS `commitMeetingMinutes`.
    let minutes_to_commit = MeetingMinutes {
        summary_markdown: "### Standup Decisions\nProceed with epoch-keyed outbox.".into(),
        decisions: vec![ProposedDecision {
            id: "mem-mtg-epoch".into(),
            title: "Epoch-keyed outbox".into(),
            rationale: "Eliminates post-restart message drop".into(),
            save_to_memory: true,
        }],
        proposed_tasks: vec![ProposedTask {
            id: "T-OUTBOX-99".into(),
            title: "Verify epoch bump integration".into(),
            board_id: Some("B1".into()),
            assignee_id: Some("coder".into()),
            stage_id: Some("build".into()),
            description: "Run crash-restart shim test".into(),
            approved: true,
        }],
        agent_instructions: vec![AgentInstruction {
            agent_id: "coder".into(),
            instruction: "Start T-OUTBOX-99 immediately".into(),
            approved: true,
        }],
        committed_at: None,
    };

    owner_ws
        .send(WsMsg::Text(
            serde_json::to_string(&WsClientMessage {
                id: "own-commit-1".into(),
                cmd: "commitMeetingMinutes".into(),
                args: vec![
                    json!(meeting_id),
                    serde_json::to_value(&minutes_to_commit).unwrap(),
                ],
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let commit_ack = recv_until_ack(&mut owner_ws, "own-commit-1").await;
    assert_eq!(commit_ack["ok"], true);

    // Verify atomic SAVEPOINT commit persisted task, certified memory + FTS, and agent_outbox instruction!
    let closed_session = state
        .inner
        .meetings
        .get_session(&meeting_id)
        .unwrap()
        .unwrap();
    assert_eq!(closed_session.status, MeetingStatus::Closed);
    assert!(closed_session
        .minutes
        .unwrap()
        .committed_at
        .is_some());

    let coder_outbox_msg = state
        .inner
        .outbox
        .next_pending("proj-alpha", "coder", 1, 1, 0)
        .unwrap()
        .unwrap();
    assert!(coder_outbox_msg
        .payload_json
        .contains("Start T-OUTBOX-99 immediately"));

    let (task_count, mem_count): (i64, i64) = state
        .inner
        .db
        .read(|conn| {
            let tc: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id = 'proj-alpha' AND id = 'T-OUTBOX-99'",
                [],
                |r| r.get(0),
            )?;
            let mc: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE project_id = 'proj-alpha' AND id = 'mem-mtg-epoch' AND certified = 1",
                [],
                |r| r.get(0),
            )?;
            Ok::<_, arima_db::DbError>((tc, mc))
        })
        .unwrap();
    assert_eq!(task_count, 1);
    assert_eq!(mem_count, 1);

    // Scheduled 09:00 standup triggers once per slot and deduplicates repeat checks.
    let sched_first = state
        .inner
        .standups
        .check_and_trigger(&state, "proj-alpha", "2026-11-21", 9, 5, true)
        .unwrap();
    assert!(sched_first.is_some());
    let sched_dup = state
        .inner
        .standups
        .check_and_trigger(&state, "proj-alpha", "2026-11-21", 9, 10, true)
        .unwrap();
    assert!(sched_dup.is_none());

    // 5. Usage aggregation endpoint `GET /api/projects/proj-alpha/usage?days=7`.
    state
        .inner
        .usage
        .record_usage(&UsageEventInput {
            project_id: "proj-alpha".into(),
            agent_id: "lead".into(),
            task_id: Some("T01".into()),
            account_id: None,
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            input_tokens: 15_000,
            output_tokens: 3_000,
            cache_read_tokens: 25_000,
            cost_usd: 0.0975,
            at_ms: None,
        })
        .unwrap();

    let (u_st, _, usage_json) = http_req(
        addr,
        "GET",
        "/api/projects/proj-alpha/usage?days=7",
        Some(&owner_cookie),
        Some(&origin),
        &[],
        None,
    )
    .await;
    assert_eq!(u_st, StatusCode::OK);
    assert_eq!(usage_json["days"], 7);
    let agents_arr = usage_json["agents"].as_array().unwrap();
    assert_eq!(agents_arr.len(), 1);
    assert_eq!(agents_arr[0]["agentId"], "lead");
    assert_eq!(agents_arr[0]["input"], 15_000);
    assert_eq!(agents_arr[0]["cached"], 25_000);
    assert_eq!(agents_arr[0]["output"], 3_000);
    assert_eq!(agents_arr[0]["series"].as_array().unwrap().len(), 24);

    // 6. GitHub Webhook constant-time HMAC-SHA256 verification & persisted PR sync cursor.
    let webhook_payload = json!({
        "action": "opened",
        "number": 42,
        "pull_request": {
            "number": 42,
            "title": "feat(v2): epoch-keyed outbox and visual decisions",
            "state": "open",
            "merged": false,
            "html_url": "https://github.com/sachindots/arimaops/pull/42",
            "user": { "login": "coder" },
            "head": { "ref": "feat/m2-outbox", "sha": "abc1234def" }
        }
    });
    let payload_bytes = webhook_payload.to_string();

    // Invalid signature must return 401 UNAUTHORIZED.
    let (bad_wh_st, _, _) = http_req(
        addr,
        "POST",
        "/api/projects/proj-alpha/github/webhook",
        None,
        None,
        &[
            ("X-Hub-Signature-256", "sha256=deadbeef"),
            ("X-GitHub-Event", "pull_request"),
            ("X-GitHub-Delivery", "deliv-bad"),
        ],
        Some(webhook_payload.clone()),
    )
    .await;
    assert_eq!(bad_wh_st, StatusCode::UNAUTHORIZED);

    // Valid HMAC-SHA256 signature succeeds and persists PR + cursor in SQLite.
    let valid_sig = compute_github_signature(WEBHOOK_SECRET.as_bytes(), payload_bytes.as_bytes());
    let (ok_wh_st, _, wh_res) = http_req(
        addr,
        "POST",
        "/api/projects/proj-alpha/github/webhook",
        None,
        None,
        &[
            ("X-Hub-Signature-256", &valid_sig),
            ("X-GitHub-Event", "pull_request"),
            ("X-GitHub-Delivery", "deliv-42"),
        ],
        Some(webhook_payload),
    )
    .await;
    assert_eq!(ok_wh_st, StatusCode::OK);
    assert_eq!(wh_res["cursor"], "pr-42-abc1234def");
    assert_eq!(wh_res["lastDeliveryId"], "deliv-42");

    // Re-open SQLite DB from disk and verify persisted sync cursor and initial WS snapshot include PR #42, decisions, meetings, and turns!
    let (_, fresh_snap) = connect_ws(addr, &owner_cookie, &origin).await;
    assert!(
        !fresh_snap["snapshot"]["visualDecisions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        !fresh_snap["snapshot"]["meetings"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fresh_snap["snapshot"]["pullRequests"][0]["number"],
        42
    );

    let reopened_db = Db::open(&dir.path().join("arima.db")).unwrap();
    let reopened_gh = arima_server::github::GithubSyncService::new(reopened_db);
    let persisted_gh = reopened_gh.load_state("proj-alpha").unwrap();
    assert_eq!(persisted_gh.cursor.as_deref(), Some("pr-42-abc1234def"));
    assert_eq!(persisted_gh.pull_requests.len(), 1);
}
