// SPDX-License-Identifier: AGPL-3.0-or-later

//! Milestone 4 (`v2.0-beta`) end-to-end integration tests:
//! 1. Scope -> `arima-proxy` EgressPolicy live sync, unconditional IMDS/link-local blocking,
//!    CVSS 4.0 scoring, MCP `check_scope`/`report_finding`, and all 6 report export formats
//!    (including SARIF 2.1.0 schema & strict HTML XSS escaping).
//! 2. SQLite FTS5 Team Memory search (with punctuation sanitization), contradiction detection,
//!    30-day uncertified decay, Inbox `MemoryReview` certification, template lesson promotion,
//!    and `MeetingMinutes` -> FTS5 search round-trip.
//! 3. Upgraded Voice Adapter status & unconfigured-key `503` fallback + encrypted vault secrets.
//! 4. Full AES-256-GCM + Argon2id Encrypted Backup -> tamper rejection -> non-mutating verify ->
//!    atomic restore round-trip (DB, vault, `evidence/`, `feedback/`) + Owner-only RBAC.

use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;

use arima_auth::{SessionMeta, VaultKey, SESSION_COOKIE_NAME};
use arima_core::{
    MeetingAgendaItem, MeetingKind, MeetingMinutes, MeetingSession, MeetingStatus, MeetingUrgency,
    ProposedDecision, ServerRole, VoiceProvider,
};
use arima_db::{parse_and_score_cvss4, CreateMemoryInput, Db, DbError};
use arima_proxy::{EgressProxy, ProxyCredentials};
use arima_server::{router_with_state, AppState, ServerConfig};
use axum::body::Body;
use axum::http::header::{CONTENT_TYPE, COOKIE, HOST, ORIGIN};
use axum::http::{Method, Request, StatusCode};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;

async fn setup_users(state: &AppState) -> (String, String, String) {
    // Always create Owner first so first-user promotion applies only to Owner.
    let owner = state
        .inner
        .auth
        .create_user("OwnerM4".into(), "OwnerPass!2026".into(), ServerRole::Owner)
        .await
        .unwrap();
    let operator = state
        .inner
        .auth
        .create_user(
            "OpM4".into(),
            "OperatorPass!2026".into(),
            ServerRole::Operator,
        )
        .await
        .unwrap();
    let viewer = state
        .inner
        .auth
        .create_user("ViewM4".into(), "ViewerPass!2026".into(), ServerRole::Viewer)
        .await
        .unwrap();

    let meta = SessionMeta {
        client_ip: "127.0.0.1".into(),
        origin: Some("http://127.0.0.1:7420".into()),
        label: "m4-test".into(),
        remote: false,
    };

    let owner_tok = state
        .inner
        .auth
        .login_with_passkey(&owner.user.id, meta.clone())
        .unwrap()
        .raw_token;
    let op_tok = state
        .inner
        .auth
        .login_with_passkey(&operator.user.id, meta.clone())
        .unwrap()
        .raw_token;
    let view_tok = state
        .inner
        .auth
        .login_with_passkey(&viewer.user.id, meta)
        .unwrap()
        .raw_token;

    (owner_tok, op_tok, view_tok)
}

async fn send_json(
    app: &axum::Router,
    method: Method,
    uri: &str,
    cookie_tok: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header(HOST, "127.0.0.1:7420")
        .header(ORIGIN, "http://127.0.0.1:7420")
        .header(COOKIE, format!("{SESSION_COOKIE_NAME}={cookie_tok}"));

    let payload = match body {
        Some(v) => {
            req = req.header(CONTENT_TYPE, "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };

    let resp = app.clone().oneshot(req.body(payload).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let json = serde_json::from_slice::<Value>(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    (status, json)
}

async fn send_raw(
    app: &axum::Router,
    method: Method,
    uri: &str,
    cookie_tok: &str,
) -> (StatusCode, String, Vec<u8>) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header(HOST, "127.0.0.1:7420")
        .header(ORIGIN, "http://127.0.0.1:7420")
        .header(COOKIE, format!("{SESSION_COOKIE_NAME}={cookie_tok}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let ct = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = axum::body::to_bytes(resp.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (status, ct, bytes)
}

async fn proxy_http_request(proxy_addr: SocketAddr, req_raw: &str) -> String {
    let mut stream = TcpStream::connect(proxy_addr).await.unwrap();
    stream.write_all(req_raw.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).into_owned()
}

#[tokio::test]
async fn m4_security_scope_proxy_sync_cvss4_and_six_export_formats() {
    // Verify canonical CVSS 4.0 scores first.
    let crit_all = parse_and_score_cvss4(
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
    )
    .unwrap();
    assert_eq!(crit_all.score, 10.0);
    assert_eq!(crit_all.severity, "critical");

    let crit_vuln = parse_and_score_cvss4(
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
    )
    .unwrap();
    assert_eq!(crit_vuln.score, 9.3);
    assert_eq!(crit_vuln.severity, "critical");

    let high_vec = parse_and_score_cvss4(
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N",
    )
    .unwrap();
    assert!(high_vec.score >= 7.0 && high_vec.score < 9.0);
    assert_eq!(high_vec.severity, "high");

    let med_xss = parse_and_score_cvss4(
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:P/VC:N/VI:N/VA:N/SC:L/SI:L/SA:N",
    )
    .unwrap();
    assert!(med_xss.score >= 4.0 && med_xss.score < 7.0);
    assert_eq!(med_xss.severity, "medium");

    let info_zero = parse_and_score_cvss4(
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N",
    )
    .unwrap();
    assert_eq!(info_zero.score, 0.0);
    assert_eq!(info_zero.severity, "info");
    assert!(parse_and_score_cvss4("CVSS:4.0/AV:Z/AC:L").is_err());

    let db = Db::open_in_memory().unwrap();
    let state = AppState::new(db, VaultKey::ephemeral(), ServerConfig::default());
    state
        .ensure_default_project("VAmPI Lab", "vampi-lab", "/tmp/vampi")
        .unwrap();
    let (project_id, _, _, _) = state.default_project().unwrap();
    let (owner_tok, op_tok, view_tok) = setup_users(&state).await;
    let app = router_with_state(state.clone());

    // Start a tiny local HTTP lab target that should be reachable ONLY once placed in scope.
    let lab_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lab_port = lab_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = lab_listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 10\r\nConnection: close\r\n\r\nlab-target",
                    )
                    .await;
            });
        }
    });

    // Start live EgressProxy backed by AppState's synchronized DynamicScopePolicyProvider.
    // No credential: the scope provider serves a loopback caller (this test) its project's scope.
    let proxy = EgressProxy::start(
        "127.0.0.1:0".parse().unwrap(),
        ProxyCredentials::new(),
        Arc::clone(&state.inner.egress_policy) as Arc<dyn arima_proxy::PolicyProvider>,
    )
    .await
    .unwrap();

    // Viewer & Operator cannot update scope (Owner-only).
    let (st_v, _) = send_json(
        &app,
        Method::PUT,
        &format!("/api/projects/{project_id}/scope"),
        &view_tok,
        Some(json!({ "inScope": [format!("127.0.0.1:{lab_port}")], "outOfScope": [], "notes": "" })),
    )
    .await;
    assert_eq!(st_v, StatusCode::FORBIDDEN);

    let (st_op, _) = send_json(
        &app,
        Method::PUT,
        &format!("/api/projects/{project_id}/scope"),
        &op_tok,
        Some(json!({ "inScope": [format!("127.0.0.1:{lab_port}")], "outOfScope": [], "notes": "" })),
    )
    .await;
    assert_eq!(st_op, StatusCode::FORBIDDEN);

    // Owner updates scope, attempting to include both valid targets AND cloud IMDS/link-local!
    let (st_ok, scope_resp) = send_json(
        &app,
        Method::PUT,
        &format!("/api/projects/{project_id}/scope"),
        &owner_tok,
        Some(json!({
            "inScope": [
                format!("127.0.0.1:{lab_port}"),
                "api.lab.internal",
                "169.254.169.254",
                "fe80::1"
            ],
            "outOfScope": ["admin.lab.internal"],
            "notes": "Authorized lab assessment <script>alert(1)</script>"
        })),
    )
    .await;
    assert_eq!(st_ok, StatusCode::OK);
    let blocked_imds = scope_resp["blockedImdsTargets"].as_array().unwrap();
    assert_eq!(blocked_imds.len(), 2);

    // Confirm GET /scope returns persisted scope.
    let (st_get_scope, got_scope) = send_json(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/scope"),
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_get_scope, StatusCode::OK);
    assert_eq!(got_scope["outOfScope"][0], "admin.lab.internal");

    // Live proxy check 1: In-scope local lab target is ALLOWED!
    let ok_proxy = proxy_http_request(
        proxy.addr(),
        &format!("GET http://127.0.0.1:{lab_port}/health HTTP/1.1\r\nHost: 127.0.0.1:{lab_port}\r\n\r\n"),
    )
    .await;
    assert!(ok_proxy.starts_with("HTTP/1.1 200 OK"), "got: {ok_proxy}");
    assert!(ok_proxy.contains("lab-target"));

    // Live proxy check 2: Cloud IMDS 169.254.169.254 MUST ALWAYS BE BLOCKED (403)!
    let imds_v4 = proxy_http_request(
        proxy.addr(),
        "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
    )
    .await;
    assert!(imds_v4.starts_with("HTTP/1.1 403 Forbidden"), "got: {imds_v4}");

    // Live proxy check 3: IPv6 link-local fe80::1 MUST ALWAYS BE BLOCKED (403)!
    let imds_v6 = proxy_http_request(
        proxy.addr(),
        "CONNECT [fe80::1]:80 HTTP/1.1\r\nHost: [fe80::1]:80\r\n\r\n",
    )
    .await;
    assert!(imds_v6.starts_with("HTTP/1.1 403 Forbidden"), "got: {imds_v6}");

    // Live proxy check 4: Out-of-scope target is BLOCKED (403)!
    let out_of_scope = proxy_http_request(
        proxy.addr(),
        "CONNECT admin.lab.internal:443 HTTP/1.1\r\nHost: admin.lab.internal:443\r\n\r\n",
    )
    .await;
    assert!(
        out_of_scope.starts_with("HTTP/1.1 403 Forbidden"),
        "got: {out_of_scope}"
    );

    // MCP `check_scope` and `report_finding` tools work via agent bearer token!
    let agent_tok = state.inner.mcp.issue_agent_token(&project_id, "cipher");
    let mcp_req = |method: &str, params: Value| {
        Request::builder()
            .method(Method::POST)
            .uri(format!("/api/projects/{project_id}/mcp"))
            .header(HOST, "127.0.0.1:7420")
            .header(ORIGIN, "http://127.0.0.1:7420")
            .header(CONTENT_TYPE, "application/json")
            .header("authorization", format!("Bearer {agent_tok}"))
            .body(Body::from(
                json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string(),
            ))
            .unwrap()
    };

    let resp_check = app
        .clone()
        .oneshot(mcp_req(
            "tools/call",
            json!({ "name": "check_scope", "arguments": { "target": "http://169.254.169.254/latest" } }),
        ))
        .await
        .unwrap();
    assert_eq!(resp_check.status(), StatusCode::OK);
    let check_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(resp_check.into_body(), 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(check_json["result"]["structuredContent"]["allowed"], false);
    assert_eq!(check_json["result"]["structuredContent"]["blockedImds"], true);

    let resp_report = app
        .clone()
        .oneshot(mcp_req(
            "tools/call",
            json!({
                "name": "report_finding",
                "arguments": {
                    "title": "SQL Injection <script>alert(\"xss\")</script>",
                    "target": "https://api.lab.internal/users?id=1",
                    "cwe": "CWE-89",
                    "cvssVector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
                    "descriptionMarkdown": "Unsanitized SQL query with <img src=x onerror=alert(1)>",
                    "reproductionMarkdown": "curl 'https://api.lab.internal/users?id=1%27'",
                    "remediationMarkdown": "Use parameterized queries.",
                    "evidenceRefs": ["evidence/vampi-lab/sqli.txt"]
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp_report.status(), StatusCode::OK);
    let rep_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(resp_report.into_body(), 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    let f1_id = rep_json["result"]["structuredContent"]["finding"]["id"].as_str().unwrap().to_owned();
    assert_eq!(rep_json["result"]["structuredContent"]["finding"]["cvssScore"], 9.3);
    assert_eq!(rep_json["result"]["structuredContent"]["finding"]["severity"], "critical");

    // Viewer blocked from POST/PATCH findings; Operator allowed!
    let (st_vf, _) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/findings"),
        &view_tok,
        Some(json!({ "title": "Nope", "target": "api.lab.internal" })),
    )
    .await;
    assert_eq!(st_vf, StatusCode::FORBIDDEN);

    let (st_patch, patched) = send_json(
        &app,
        Method::PATCH,
        &format!("/api/projects/{project_id}/findings/{f1_id}"),
        &op_tok,
        Some(json!({ "status": "confirmed", "verified": true })),
    )
    .await;
    assert_eq!(st_patch, StatusCode::OK);
    assert_eq!(patched["finding"]["status"], "confirmed");
    assert_eq!(patched["finding"]["verified"], true);

    // Export all 6 formats and validate headers, SARIF 2.1.0 schema, and zero XSS in HTML!
    let (st_html, ct_html, bytes_html) = send_raw(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/findings/export?format=html"),
        &view_tok,
    )
    .await;
    assert_eq!(st_html, StatusCode::OK);
    assert!(ct_html.starts_with("text/html"));
    let html_str = String::from_utf8(bytes_html).unwrap();
    assert!(!html_str.contains("<script>"), "raw <script> leaked in HTML export!");
    assert!(!html_str.contains("<img src=x"), "raw <img> XSS leaked in HTML export!");
    assert!(html_str.contains("&lt;script&gt;"));

    let (st_md, ct_md, bytes_md) = send_raw(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/findings/export?format=markdown"),
        &view_tok,
    )
    .await;
    assert_eq!(st_md, StatusCode::OK);
    assert!(ct_md.starts_with("text/markdown"));
    assert!(String::from_utf8(bytes_md).unwrap().contains("CVSS 4.0: **9.3**"));

    let (st_h1, ct_h1, bytes_h1) = send_raw(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/findings/export?format=hackerone"),
        &view_tok,
    )
    .await;
    assert_eq!(st_h1, StatusCode::OK);
    assert!(ct_h1.starts_with("text/markdown"));
    let h1_str = String::from_utf8(bytes_h1).unwrap();
    assert!(h1_str.contains("HackerOne Submission Bundle"));
    assert!(h1_str.contains("Steps To Reproduce"));

    let (st_bc, ct_bc, bytes_bc) = send_raw(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/findings/export?format=bugcrowd"),
        &view_tok,
    )
    .await;
    assert_eq!(st_bc, StatusCode::OK);
    assert!(ct_bc.starts_with("text/markdown"));
    let bc_str = String::from_utf8(bytes_bc).unwrap();
    assert!(bc_str.contains("P1"));
    assert!(bc_str.contains("Bugcrowd Report Export"));

    let (st_js, ct_js, bytes_js) = send_raw(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/findings/export?format=json"),
        &view_tok,
    )
    .await;
    assert_eq!(st_js, StatusCode::OK);
    assert!(ct_js.starts_with("application/json"));
    let exp_json: Value = serde_json::from_slice(&bytes_js).unwrap();
    assert_eq!(exp_json["summary"]["total"], 1);
    assert_eq!(exp_json["summary"]["bySeverity"]["critical"], 1);

    let (st_sarif, ct_sarif, bytes_sarif) = send_raw(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/findings/export?format=sarif"),
        &view_tok,
    )
    .await;
    assert_eq!(st_sarif, StatusCode::OK);
    assert!(ct_sarif.starts_with("application/sarif+json"));
    let sarif: Value = serde_json::from_slice(&bytes_sarif).unwrap();
    assert_eq!(sarif["version"], "2.1.0");
    assert_eq!(
        sarif["$schema"],
        "https://json.schemastore.org/sarif-2.1.0.json"
    );
    assert_eq!(sarif["runs"][0]["tool"]["driver"]["name"], "ArimaOps");
    assert_eq!(sarif["runs"][0]["results"][0]["ruleId"], "CWE-89");
    assert_eq!(sarif["runs"][0]["results"][0]["level"], "error");
    assert_eq!(
        sarif["runs"][0]["results"][0]["properties"]["cvssScore"],
        9.3
    );
}

#[tokio::test]
async fn m4_fts5_memory_contradiction_decay_promote_and_meeting_commit() {
    let db = Db::open_in_memory().unwrap();
    let state = AppState::new(db, VaultKey::ephemeral(), ServerConfig::default());
    state
        .ensure_default_project("Core App", "core-app", "/tmp/core-app")
        .unwrap();
    let (project_id, _, _, _) = state.default_project().unwrap();
    let (owner_tok, op_tok, view_tok) = setup_users(&state).await;
    let app = router_with_state(state.clone());

    // Configure keepOut via Owner-only settings endpoint (Operator blocked with 403).
    let (st_op_set, _) = send_json(
        &app,
        Method::PUT,
        &format!("/api/projects/{project_id}/memory/settings"),
        &op_tok,
        Some(json!({ "keepOut": ["AcmeCorp"] })),
    )
    .await;
    assert_eq!(st_op_set, StatusCode::FORBIDDEN);

    let (st_set, set_resp) = send_json(
        &app,
        Method::PUT,
        &format!("/api/projects/{project_id}/memory/settings"),
        &owner_tok,
        Some(json!({
            "extraction": { "enabled": true, "account": "default" },
            "keepOut": ["AcmeCorp"]
        })),
    )
    .await;
    assert_eq!(st_set, StatusCode::OK);
    assert_eq!(set_resp["keepOut"][0], "AcmeCorp");

    // Seed one certified memory on topic "sqlite" + one 35-day-old uncertified memory + one 45-day-old certified memory.
    let now_ms = Utc::now().timestamp_millis();
    let certified_base = state
        .inner
        .memory
        .insert(
            &project_id,
            CreateMemoryInput {
                id: Some("mem-base-sqlite".into()),
                mem_type: "Decision".into(),
                text: "Always keep WAL journaling enabled for sqlite databases.".into(),
                about: vec!["sqlite".into()],
                certified: true,
                created_at_ms: Some(now_ms - 45 * 86_400_000),
                last_used_at_ms: Some(now_ms - 45 * 86_400_000),
            },
        )
        .unwrap();
    assert!(certified_base.certified);

    state
        .inner
        .memory
        .insert(
            &project_id,
            CreateMemoryInput {
                id: Some("mem-stale-uncertified".into()),
                mem_type: "Lesson".into(),
                text: "Stale temporary note about old cache strategy.".into(),
                about: vec!["cache".into()],
                certified: false,
                created_at_ms: Some(now_ms - 35 * 86_400_000),
                last_used_at_ms: Some(now_ms - 35 * 86_400_000),
            },
        )
        .unwrap();

    // Run extraction with contradicting sqlite statement + keepOut & email PII!
    let (st_ext, ext_resp) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/memory/extract"),
        &op_tok,
        Some(json!({
            "text": "Decision: Never use WAL journaling for sqlite; switch to DELETE journal for AcmeCorp contact alice@example.com on core-app.",
            "about": ["sqlite"],
            "source": "lead"
        })),
    )
    .await;
    assert_eq!(st_ext, StatusCode::OK);
    let extracted_id = ext_resp["memories"][0]["id"].as_str().unwrap().to_owned();
    let extracted_text = ext_resp["memories"][0]["text"].as_str().unwrap();
    assert!(!extracted_text.contains("AcmeCorp"), "keepOut leaked: {extracted_text}");
    assert!(!extracted_text.contains("alice@example.com"), "email leaked: {extracted_text}");
    assert_eq!(
        ext_resp["memories"][0]["conflictId"].as_str(),
        Some("mem-base-sqlite"),
        "contradiction against certified sqlite memory must be flagged"
    );
    assert_eq!(ext_resp["decision"]["payload"]["kind"], "memory-review");
    assert_eq!(ext_resp["decision"]["ownerOnly"], true);

    // Search with nasty FTS5 punctuation characters: must NEVER throw SQLite syntax error,
    // and must also prune the 35-day-old uncertified memory while preserving the 45-day certified one!
    let (st_q_bad, _) = send_json(
        &app,
        Method::GET,
        &format!(
            "/api/projects/{project_id}/memory?q={}",
            url::form_urlencoded::byte_serialize(b"sqlite:((WAL) \"unterminated OR NOT ---")
                .collect::<String>()
        ),
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_q_bad, StatusCode::OK);

    let (st_q, q_resp) = send_json(
        &app,
        Method::GET,
        &format!(
            "/api/projects/{project_id}/memory?q={}",
            url::form_urlencoded::byte_serialize(b"sqlite:((WAL) \"---").collect::<String>()
        ),
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_q, StatusCode::OK);
    let hits = q_resp["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 2);

    // Confirm 35-day uncertified memory was decayed & pruned!
    let (st_all, all_resp) = send_json(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/memory"),
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_all, StatusCode::OK);
    let all_ids: Vec<&str> = all_resp["memories"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert!(!all_ids.contains(&"mem-stale-uncertified"));
    assert!(all_ids.contains(&"mem-base-sqlite"));
    assert!(all_ids.contains(&extracted_id.as_str()));

    // Operator cannot certify or promote (Owner-only).
    let (st_op_cert, _) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/memory/{extracted_id}/certify"),
        &op_tok,
        Some(json!({ "supersedeConflict": true })),
    )
    .await;
    assert_eq!(st_op_cert, StatusCode::FORBIDDEN);

    // Owner certifies contradicting memory, superseding mem-base-sqlite.
    let (st_cert, cert_resp) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/memory/{extracted_id}/certify"),
        &owner_tok,
        Some(json!({ "supersedeConflict": true })),
    )
    .await;
    assert_eq!(st_cert, StatusCode::OK);
    assert_eq!(cert_resp["memory"]["certified"], true);
    assert!(cert_resp["memory"]["conflictId"].is_null());

    let old_after = state
        .inner
        .memory
        .get(&project_id, "mem-base-sqlite")
        .unwrap()
        .unwrap();
    assert!(!old_after.certified);
    assert_eq!(old_after.superseded_by.as_deref(), Some(extracted_id.as_str()));

    // Owner promotes memory to template lesson (scrubbing project slug "core-app").
    let (st_prom, prom_resp) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/memory/{extracted_id}/promote"),
        &owner_tok,
        None,
    )
    .await;
    assert_eq!(st_prom, StatusCode::OK);
    assert_eq!(prom_resp["memory"]["promoted"], true);
    let lesson_text = prom_resp["lesson"]["text"].as_str().unwrap();
    assert!(!lesson_text.contains("core-app"), "project slug leaked into promoted lesson");

    // MeetingMinutes -> certified Team Memory -> immediate FTS5 search round-trip!
    let mtg = MeetingSession {
        id: "mtg-m4-fts".into(),
        project_id: project_id.clone(),
        kind: MeetingKind::Discussion,
        status: MeetingStatus::MinutesReview,
        urgency: MeetingUrgency::Normal,
        title: "Architecture Sync".into(),
        moderator_id: "lead".into(),
        participant_ids: vec!["lead".into(), "coder".into()],
        requested_by: "owner".into(),
        voice_enabled: false,
        voice_provider: VoiceProvider::BrowserWebSpeech,
        agenda: vec![MeetingAgendaItem {
            id: "a1".into(),
            title: "FTS5 Search".into(),
            status: "resolved".into(),
            owner_id: Some("lead".into()),
            recommendation_decision_id: None,
        }],
        minutes: Some(MeetingMinutes {
            summary_markdown: "Approved Porter FTS5".into(),
            decisions: vec![ProposedDecision {
                id: "mem-from-meeting".into(),
                title: "Porter Stemming Index".into(),
                rationale: "Use SQLite FTS5 porter tokenization for instant team recall.".into(),
                save_to_memory: true,
            }],
            proposed_tasks: vec![],
            agent_instructions: vec![],
            committed_at: None,
        }),
        created_at: Utc::now().to_rfc3339(),
        started_at: Some(Utc::now().to_rfc3339()),
        closed_at: None,
    };
    state.inner.meetings.upsert_session(&mtg).unwrap();
    let (_, summary) = state
        .inner
        .meetings
        .commit_minutes(&mtg.id, 1, None)
        .unwrap();
    assert_eq!(summary.memories_certified, 1);

    let (st_fts_mtg, fts_mtg_resp) = send_json(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/memory?q=tokenization&status=certified"),
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_fts_mtg, StatusCode::OK);
    let mtg_hits = fts_mtg_resp["memories"].as_array().unwrap();
    assert_eq!(mtg_hits.len(), 1);
    assert_eq!(mtg_hits[0]["id"], "mem-from-meeting");

    // Owner deletes memory and confirms it is removed from FTS5.
    let (st_del, _) = send_json(
        &app,
        Method::DELETE,
        &format!("/api/projects/{project_id}/memory/mem-from-meeting"),
        &owner_tok,
        None,
    )
    .await;
    assert_eq!(st_del, StatusCode::OK);
    let (st_after_del, after_del) = send_json(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/memory?q=tokenization"),
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_after_del, StatusCode::OK);
    assert_eq!(after_del["memories"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn m4_voice_status_and_unconfigured_key_fallback() {
    let db = Db::open_in_memory().unwrap();
    let state = AppState::new(db, VaultKey::ephemeral(), ServerConfig::default());
    let (owner_tok, op_tok, view_tok) = setup_users(&state).await;
    let app = router_with_state(state.clone());

    let (st_status, status_json) = send_json(
        &app,
        Method::GET,
        "/api/voice/status",
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_status, StatusCode::OK);
    assert_eq!(status_json["providers"]["browserWebSpeech"], true);
    assert_eq!(status_json["activeProvider"], "browser-web-speech");

    // Viewer blocked from paid TTS/STT endpoints.
    let (st_vt, _) = send_json(
        &app,
        Method::POST,
        "/api/voice/tts",
        &view_tok,
        Some(json!({ "text": "Hello team", "provider": "openai" })),
    )
    .await;
    assert_eq!(st_vt, StatusCode::FORBIDDEN);

    // Without vaulted keys (assuming env keys aren't set), TTS/STT return 503 with clear fallback.
    if std::env::var("OPENAI_API_KEY").is_err() {
        let (st_tts, tts_json) = send_json(
            &app,
            Method::POST,
            "/api/voice/tts",
            &op_tok,
            Some(json!({ "text": "Standup starting now", "provider": "openai" })),
        )
        .await;
        assert_eq!(st_tts, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(tts_json["fallback"], "browser-web-speech");
        assert!(tts_json["error"].as_str().unwrap().contains("OpenAI"));
    }

    if std::env::var("GEMINI_API_KEY").is_err() {
        let (st_stt, stt_json) = send_json(
            &app,
            Method::POST,
            "/api/voice/stt",
            &op_tok,
            Some(json!({
                "audioBase64": BASE64.encode(b"fake-audio-bytes"),
                "mimeType": "audio/webm",
                "provider": "gemini"
            })),
        )
        .await;
        assert_eq!(st_stt, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(stt_json["fallback"], "browser-web-speech");
        assert!(stt_json["error"].as_str().unwrap().contains("Gemini"));
    }

    // Operator cannot store vault secrets (Owner-only).
    let (st_op_sec, _) = send_json(
        &app,
        Method::POST,
        "/api/vault/secrets",
        &op_tok,
        Some(json!({ "provider": "openai", "label": "Voice", "secret": "sk-test-secret-123" })),
    )
    .await;
    assert_eq!(st_op_sec, StatusCode::FORBIDDEN);

    // Owner stores encrypted OpenAI secret; status flips to openai=true while metadata never leaks key!
    let (st_sec, sec_resp) = send_json(
        &app,
        Method::POST,
        "/api/vault/secrets",
        &owner_tok,
        Some(json!({ "provider": "openai", "label": "OpenAI Voice", "secret": "sk-test-vault-999" })),
    )
    .await;
    assert_eq!(st_sec, StatusCode::OK);
    assert!(!sec_resp.to_string().contains("sk-test-vault-999"));

    let (st_after, status_after) = send_json(
        &app,
        Method::GET,
        "/api/voice/status",
        &owner_tok,
        None,
    )
    .await;
    assert_eq!(st_after, StatusCode::OK);
    assert_eq!(status_after["providers"]["openai"], true);

    let (st_list_sec, list_sec) = send_json(
        &app,
        Method::GET,
        "/api/vault/secrets",
        &owner_tok,
        None,
    )
    .await;
    assert_eq!(st_list_sec, StatusCode::OK);
    assert!(!list_sec.to_string().contains("sk-test-vault-999"));
}

#[tokio::test]
async fn m4_encrypted_backup_tamper_verify_and_restore_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let data_root = tmp.path().join("arima-v2");
    fs::create_dir_all(&data_root).unwrap();

    let db = Db::open(&data_root.join("arima.db")).unwrap();
    let vault = VaultKey::load_or_create(Some(&data_root)).unwrap();
    let cfg = ServerConfig {
        data_root: Some(data_root.clone()),
        ..ServerConfig::default()
    };
    let state = AppState::new(db, vault, cfg);
    state
        .ensure_default_project("Backup Target", "bk-target", "/tmp/bk-target")
        .unwrap();
    let (project_id, _, _, _) = state.default_project().unwrap();
    let (owner_tok, op_tok, view_tok) = setup_users(&state).await;
    let app = router_with_state(state.clone());

    // Seed DB rows (memory, finding, encrypted vault secret) + evidence/ & feedback/ files!
    state
        .inner
        .memory
        .insert(
            &project_id,
            CreateMemoryInput {
                id: Some("mem-bk-1".into()),
                mem_type: "Decision".into(),
                text: "Original certified architecture decision before backup.".into(),
                about: vec!["backup".into()],
                certified: true,
                created_at_ms: None,
                last_used_at_ms: None,
            },
        )
        .unwrap();
    state
        .inner
        .findings
        .create_finding(
            &project_id,
            arima_db::CreateFindingInput {
                id: Some("F-BK-1".into()),
                title: "Pre-Backup SSRF Finding".into(),
                target: "https://api.bk-target.local".into(),
                cwe: Some("CWE-918".into()),
                cvss_vector: Some(
                    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:H/SI:N/SA:N".into(),
                ),
                ..Default::default()
            },
        )
        .unwrap();
    let sec_meta = state
        .store_vault_secret(
            Some("sec-bk-openai"),
            "global",
            "openai",
            "Vault Voice Key",
            "sk-survives-restore-42",
        )
        .unwrap();
    assert_eq!(sec_meta.id, "sec-bk-openai");

    let ev_file = data_root.join("evidence/bk-target/poc.txt");
    fs::create_dir_all(ev_file.parent().unwrap()).unwrap();
    fs::write(&ev_file, b"original-evidence-proof").unwrap();

    let fb_file = data_root.join("feedback/bk-target/fb-1/annotated.png");
    fs::create_dir_all(fb_file.parent().unwrap()).unwrap();
    fs::write(&fb_file, b"\x89PNG\r\n\x1a\nfake-png-body").unwrap();

    // Viewer and Operator MUST be blocked with 403 on all backup endpoints!
    for tok in [&view_tok, &op_tok] {
        assert_eq!(
            send_json(&app, Method::GET, "/api/backups", tok, None)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            send_json(&app, Method::POST, "/api/backups", tok, None)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            send_json(
                &app,
                Method::POST,
                "/api/backups/verify",
                tok,
                Some(json!({ "id": "none.arimabak" })),
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            send_json(
                &app,
                Method::POST,
                "/api/backups/restore",
                tok,
                Some(json!({ "id": "none.arimabak", "confirm": "RESTORE" })),
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }

    // Owner creates encrypted backup!
    let (st_create, create_json) = send_json(&app, Method::POST, "/api/backups", &owner_tok, None).await;
    assert_eq!(st_create, StatusCode::OK);
    let backup_id = create_json["backup"]["id"].as_str().unwrap().to_owned();
    assert!(backup_id.ends_with(".arimabak"));
    assert_eq!(create_json["manifest"]["valid"], true);
    assert_eq!(create_json["manifest"]["integrityOk"], true);
    assert_eq!(create_json["manifest"]["evidenceFiles"], 1);
    assert_eq!(create_json["manifest"]["feedbackFiles"], 1);
    assert_eq!(create_json["manifest"]["findingsCount"], 1);
    assert_eq!(create_json["manifest"]["memoriesCount"], 1);
    assert_eq!(create_json["manifest"]["vaultSecretsCount"], 1);

    // Check 0600 permissions & encrypted envelope on disk (no plaintext SQLite or secret leakage!).
    let archive_path = data_root.join("backups").join(&backup_id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&archive_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    let (st_dl, _, archive_bytes) = send_raw(
        &app,
        Method::GET,
        &format!("/api/backups/{backup_id}/download"),
        &owner_tok,
    )
    .await;
    assert_eq!(st_dl, StatusCode::OK);
    assert_eq!(&archive_bytes[..8], b"ARIMABK2");
    assert!(
        !archive_bytes
            .windows(15)
            .any(|w| w == b"SQLite format 3"),
        "backup archive must be encrypted, not plaintext SQLite"
    );
    assert!(
        !String::from_utf8_lossy(&archive_bytes).contains("Pre-Backup SSRF Finding"),
        "plaintext finding title leaked into encrypted backup"
    );

    // Tamper test: flipping ANY byte in ciphertext or header MUST be rejected!
    let mut tampered_ct = archive_bytes.clone();
    let last_idx = tampered_ct.len() - 1;
    tampered_ct[last_idx] ^= 0xFF;
    let (st_t1, _) = send_json(
        &app,
        Method::POST,
        "/api/backups/verify",
        &owner_tok,
        Some(json!({ "archiveBase64": BASE64.encode(&tampered_ct) })),
    )
    .await;
    assert_eq!(st_t1, StatusCode::BAD_REQUEST);

    let mut tampered_hdr = archive_bytes.clone();
    tampered_hdr[12] ^= 0x01; // flip salt byte covered by AAD
    let (st_t2, _) = send_json(
        &app,
        Method::POST,
        "/api/backups/restore",
        &owner_tok,
        Some(json!({
            "archiveBase64": BASE64.encode(&tampered_hdr),
            "confirm": "RESTORE"
        })),
    )
    .await;
    assert_eq!(st_t2, StatusCode::BAD_REQUEST);

    // Mutate live DB and delete disk artifacts AFTER backup!
    state.inner.memory.delete(&project_id, "mem-bk-1").unwrap();
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute(
                "DELETE FROM findings WHERE project_id = ?1 AND id = 'F-BK-1'",
                [&project_id],
            )?;
            conn.execute("DELETE FROM vault_secrets WHERE id = 'sec-bk-openai'", [])?;
            Ok::<_, DbError>(())
        })
        .unwrap();
    fs::remove_file(&ev_file).unwrap();
    fs::remove_file(&fb_file).unwrap();

    // Verify endpoint MUST validate archive WITHOUT mutating live state!
    let (st_ver, ver_json) = send_json(
        &app,
        Method::POST,
        "/api/backups/verify",
        &owner_tok,
        Some(json!({ "id": backup_id })),
    )
    .await;
    assert_eq!(st_ver, StatusCode::OK);
    assert_eq!(ver_json["manifest"]["integrityOk"], true);
    assert!(
        state
            .inner
            .memory
            .get(&project_id, "mem-bk-1")
            .unwrap()
            .is_none(),
        "verify must NOT mutate live database"
    );
    assert!(!ev_file.exists(), "verify must NOT mutate live files");

    // Restore without exact `confirm: "RESTORE"` MUST fail (400)!
    let (st_bad_conf, _) = send_json(
        &app,
        Method::POST,
        "/api/backups/restore",
        &owner_tok,
        Some(json!({ "id": backup_id, "confirm": "restore" })),
    )
    .await;
    assert_eq!(st_bad_conf, StatusCode::BAD_REQUEST);

    // Execute full atomic restore!
    let (st_res, res_json) = send_json(
        &app,
        Method::POST,
        "/api/backups/restore",
        &owner_tok,
        Some(json!({ "id": backup_id, "confirm": "RESTORE" })),
    )
    .await;
    assert_eq!(st_res, StatusCode::OK);
    assert!(res_json["preRestoreBackup"]["filename"]
        .as_str()
        .unwrap()
        .starts_with("pre-restore-"));

    // Confirm DB rows, encrypted vault secret, evidence/, and feedback/ all survived intact!
    let restored_mem = state
        .inner
        .memory
        .get(&project_id, "mem-bk-1")
        .unwrap()
        .expect("memory restored");
    assert_eq!(
        restored_mem.text,
        "Original certified architecture decision before backup."
    );

    let restored_finding = state
        .inner
        .findings
        .get_finding(&project_id, "F-BK-1")
        .unwrap()
        .expect("finding restored");
    assert_eq!(restored_finding.title, "Pre-Backup SSRF Finding");

    let restored_secret = arima_server::voice::resolve_provider_api_key(&state, "openai")
        .expect("vault secret decrypts cleanly after restore");
    assert_eq!(restored_secret, "sk-survives-restore-42");

    assert_eq!(fs::read(&ev_file).unwrap(), b"original-evidence-proof");
    assert_eq!(fs::read(&fb_file).unwrap(), b"\x89PNG\r\n\x1a\nfake-png-body");
}
