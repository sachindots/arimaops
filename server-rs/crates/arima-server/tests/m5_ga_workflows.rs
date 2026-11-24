// SPDX-License-Identifier: AGPL-3.0-or-later

//! Milestone 5 (`v2.0-GA`) integration & 20-agent concurrent load test suite:
//! 1. Factory metrics (current vs previous 14d), native rubric scorer, Owner-only nightly
//!    improvement proposal decide, and Replay Benchmark Harness.
//! 2. `ee/` Ed25519 Licensing (`ed25519-dalek`): valid key, tampered signature rejection,
//!    expired key rejection & runtime fallback to Community limits, and `maxSeats` on `POST /api/users`.
//! 3. Lossless `migrate-v1` dry-run + live migration + FTS5 search + symlink rejection +
//!    idempotent re-run + strictly untouched source directory.
//! 4. 20-Agent Concurrent Load Test over SQLite WAL + `OutboxRepo` + `UsageRepo` + `/mcp` + `WsHub`.

use std::fs;
use std::time::Instant;

use arima_auth::{SessionMeta, VaultKey, SESSION_COOKIE_NAME};
use arima_core::{OutboxMessageKind, ServerRole};
use arima_db::{
    migrate_v1_data, Db, DbError, MemoryRepo, MemoryStatusFilter, MigrateV1Options,
    ServerSettingsRepo, UsageEventInput,
};
use arima_server::license::{sign_license_payload, LicensePayload};
use arima_server::{router_with_state, AppState, ServerConfig};
use axum::body::Body;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, COOKIE, HOST, ORIGIN};
use axum::http::{Method, Request, StatusCode};
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

async fn setup_users(state: &AppState) -> (String, String, String) {
    let owner = state
        .inner
        .auth
        .create_user("OwnerM5".into(), "OwnerPass!2026".into(), ServerRole::Owner)
        .await
        .unwrap();
    let operator = state
        .inner
        .auth
        .create_user(
            "OpM5".into(),
            "OperatorPass!2026".into(),
            ServerRole::Operator,
        )
        .await
        .unwrap();
    let viewer = state
        .inner
        .auth
        .create_user("ViewM5".into(), "ViewerPass!2026".into(), ServerRole::Viewer)
        .await
        .unwrap();

    let meta = SessionMeta {
        client_ip: "127.0.0.1".into(),
        origin: Some("http://127.0.0.1:7420".into()),
        label: "m5-test".into(),
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
    let val = serde_json::from_slice::<Value>(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    (status, val)
}

#[tokio::test]
async fn m5_factory_metrics_scorer_owner_proposals_and_replay_benchmark() {
    let db = Db::open_in_memory().unwrap();
    let state = AppState::new(db, VaultKey::ephemeral(), ServerConfig::default());
    state
        .ensure_default_project("Factory App", "factory-app", "/tmp/factory-app")
        .unwrap();
    let (project_id, _, _, _) = state.default_project().unwrap();
    let (owner_tok, op_tok, view_tok) = setup_users(&state).await;
    let app = router_with_state(state.clone());

    // Viewer blocked from scoring, running proposals, or benchmarks.
    assert_eq!(
        send_json(
            &app,
            Method::POST,
            &format!("/api/projects/{project_id}/factory/score"),
            &view_tok,
            Some(json!({ "taskId": "T-1" })),
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // Operator scores a task via deterministic rubric scorer.
    let (st_sc, sc_json) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/factory/score"),
        &op_tok,
        Some(json!({
            "taskId": "T-101",
            "rubric": "Verify strict passing tests and clean architecture",
            "useLlm": false
        })),
    )
    .await;
    assert_eq!(st_sc, StatusCode::OK);
    assert_eq!(sc_json["score"]["taskId"], "T-101");
    assert_eq!(sc_json["score"]["pass"], true);
    assert!(sc_json["score"]["score"].as_f64().unwrap() >= 0.7);

    // Operator triggers nightly proposal run.
    let (st_pr, pr_json) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/factory/proposals/run"),
        &op_tok,
        None,
    )
    .await;
    assert_eq!(st_pr, StatusCode::OK);
    let prop_id = pr_json["created"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(pr_json["created"][0]["status"], "open");

    // Operator is BLOCKED (403) from deciding a proposal (Owner-only)!
    let (st_op_dec, _) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/factory/proposals/{prop_id}/decide"),
        &op_tok,
        Some(json!({ "decision": "accept" })),
    )
    .await;
    assert_eq!(st_op_dec, StatusCode::FORBIDDEN);

    // Owner accepts proposal cleanly.
    let (st_own_dec, dec_json) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/factory/proposals/{prop_id}/decide"),
        &owner_tok,
        Some(json!({ "decision": "accept", "note": "Ship to template" })),
    )
    .await;
    assert_eq!(st_own_dec, StatusCode::OK);
    assert_eq!(dec_json["proposal"]["status"], "accepted");

    // Operator runs Replay Benchmark Harness with explicit cases.
    let (st_bm, bm_json) = send_json(
        &app,
        Method::POST,
        &format!("/api/projects/{project_id}/factory/benchmark"),
        &op_tok,
        Some(json!({
            "name": "GA Security & WAL Suite",
            "cases": [
                {
                    "id": "c1",
                    "prompt": "Ensure SQLite WAL and SAVEPOINT invariants hold.",
                    "expectedKeywords": ["sqlite", "wal", "savepoint"]
                },
                {
                    "id": "c2",
                    "prompt": "Check nonexistent quantum flux capacitor keyword.",
                    "expectedKeywords": ["quantum", "missing-term-xyz"]
                }
            ]
        })),
    )
    .await;
    assert_eq!(st_bm, StatusCode::OK);
    assert_eq!(bm_json["benchmark"]["name"], "GA Security & WAL Suite");
    assert_eq!(bm_json["benchmark"]["cases"].as_array().unwrap().len(), 2);
    assert_eq!(bm_json["benchmark"]["cases"][0]["passed"], true);
    assert_eq!(bm_json["benchmark"]["cases"][1]["passed"], false);
    assert_eq!(bm_json["benchmark"]["passRate"], 0.5);

    // GET /factory/metrics aggregates current vs previous window + scores + proposals + benchmarks.
    let (st_m, m_json) = send_json(
        &app,
        Method::GET,
        &format!("/api/projects/{project_id}/factory/metrics?days=14"),
        &view_tok,
        None,
    )
    .await;
    assert_eq!(st_m, StatusCode::OK);
    assert_eq!(m_json["days"], 14);
    assert_eq!(m_json["scores"].as_array().unwrap().len(), 1);
    assert_eq!(m_json["proposals"].as_array().unwrap().len(), 1);
    assert_eq!(m_json["benchmarks"].as_array().unwrap().len(), 1);
    assert!(m_json["current"]["avgScore"].as_f64().unwrap() >= 0.7);
}

#[tokio::test]
async fn m5_ed25519_license_verify_tamper_expiry_and_seat_cap_enforcement() {
    let db = Db::open_in_memory().unwrap();
    let state = AppState::new(db.clone(), VaultKey::ephemeral(), ServerConfig::default());

    // Configure deterministic Ed25519 signing/verifying keypair for the test.
    let signing_key = SigningKey::from_bytes(&[19u8; 32]);
    state.inner.license.set_verifying_key(signing_key.verifying_key());

    let (owner_tok, op_tok, view_tok) = setup_users(&state).await;
    let app = router_with_state(state.clone());

    // Initial state: Community plan (maxSeats = 5, activeSeats = 3).
    let (st_init, init_lic) = send_json(&app, Method::GET, "/api/license", &view_tok, None).await;
    assert_eq!(st_init, StatusCode::OK);
    assert_eq!(init_lic["tier"], "community");
    assert_eq!(init_lic["status"], "community");
    assert_eq!(init_lic["maxSeats"], 5);
    assert_eq!(init_lic["activeSeats"], 3);

    // Create 2 more users -> hits Community 5/5 seat cap; 6th user MUST be blocked (403)!
    for idx in 4..=5 {
        let (st_u, _) = send_json(
            &app,
            Method::POST,
            "/api/users",
            &owner_tok,
            Some(json!({ "name": format!("User{idx}"), "password": "StrongPass!2026", "role": "operator" })),
        )
        .await;
        assert_eq!(st_u, StatusCode::OK);
    }
    let (st_capped, cap_err) = send_json(
        &app,
        Method::POST,
        "/api/users",
        &owner_tok,
        Some(json!({ "name": "User6Blocked", "password": "StrongPass!2026", "role": "operator" })),
    )
    .await;
    assert_eq!(st_capped, StatusCode::FORBIDDEN);
    assert!(cap_err["error"].as_str().unwrap().contains("seat limit"));

    // Operator cannot activate license (Owner-only).
    let valid_payload = LicensePayload {
        licensee: "Arima Enterprise Test".into(),
        tier: "enterprise".into(),
        max_seats: 12,
        max_projects: 50,
        expires_at: (Utc::now() + Duration::days(365)).to_rfc3339(),
        features: vec!["core".into(), "sso".into(), "factory-ee".into()],
    };
    let valid_key = sign_license_payload(&signing_key, &valid_payload).unwrap();
    assert_eq!(
        send_json(
            &app,
            Method::POST,
            "/api/license",
            &op_tok,
            Some(json!({ "licenseKey": valid_key })),
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // Tampered signature MUST be rejected (400)!
    let mut tampered = valid_key.clone();
    let last_ch = tampered.pop().unwrap();
    tampered.push(if last_ch == 'A' { 'B' } else { 'A' });
    let (st_tamper, _) = send_json(
        &app,
        Method::POST,
        "/api/license",
        &owner_tok,
        Some(json!({ "licenseKey": tampered })),
    )
    .await;
    assert_eq!(st_tamper, StatusCode::BAD_REQUEST);

    // Expired license key MUST be rejected (400) on activation!
    let expired_payload = LicensePayload {
        licensee: "Expired Corp".into(),
        tier: "enterprise".into(),
        max_seats: 50,
        max_projects: 100,
        expires_at: (Utc::now() - Duration::days(2)).to_rfc3339(),
        features: vec!["core".into(), "factory-ee".into()],
    };
    let expired_key = sign_license_payload(&signing_key, &expired_payload).unwrap();
    let (st_exp, _) = send_json(
        &app,
        Method::POST,
        "/api/license",
        &owner_tok,
        Some(json!({ "licenseKey": expired_key })),
    )
    .await;
    assert_eq!(st_exp, StatusCode::BAD_REQUEST);

    // Activate valid Ed25519 Enterprise key -> lifts seat cap to 12 and 6th user succeeds!
    let (st_act, act_json) = send_json(
        &app,
        Method::POST,
        "/api/license",
        &owner_tok,
        Some(json!({ "licenseKey": valid_key })),
    )
    .await;
    assert_eq!(st_act, StatusCode::OK);
    assert_eq!(act_json["license"]["status"], "active");
    assert_eq!(act_json["license"]["tier"], "enterprise");
    assert_eq!(act_json["license"]["maxSeats"], 12);

    let (st_u6, _) = send_json(
        &app,
        Method::POST,
        "/api/users",
        &owner_tok,
        Some(json!({ "name": "User6Allowed", "password": "StrongPass!2026", "role": "operator" })),
    )
    .await;
    assert_eq!(st_u6, StatusCode::OK);

    // Simulate runtime expiry of a previously persisted license key: status must report "expired"
    // AND fall back cleanly to Community maxSeats = 5!
    ServerSettingsRepo::new(db)
        .set("ee_license_key", &json!(expired_key))
        .unwrap();
    let (st_after_exp, exp_lic) = send_json(&app, Method::GET, "/api/license", &view_tok, None).await;
    assert_eq!(st_after_exp, StatusCode::OK);
    assert_eq!(exp_lic["status"], "expired");
    assert_eq!(exp_lic["tier"], "community");
    assert_eq!(exp_lic["maxSeats"], 5);
}

#[test]
fn m5_migrate_v1_dry_run_lossless_import_fts5_symlink_guard_and_idempotency() {
    let tmp = TempDir::new().unwrap();
    let v1_home = tmp.path().join("legacy-v1");
    let v2_home = tmp.path().join("target-v2");
    fs::create_dir_all(&v1_home).unwrap();

    // Seed legacy v1 projects.json, users.json, vault.enc, hq.db, per-project memory.db, and evidence/!
    fs::write(
        v1_home.join("projects.json"),
        json!([
            { "id": "proj-v1alpha", "slug": "v1alpha", "name": "Legacy Alpha", "path": "/tmp/v1alpha", "templateId": "software" }
        ])
        .to_string(),
    )
    .unwrap();
    fs::write(
        v1_home.join("users.json"),
        json!([
            { "id": "u-sachin", "name": "SachinV1", "passwordHash": "$argon2id$legacy", "role": "owner" }
        ])
        .to_string(),
    )
    .unwrap();
    fs::write(v1_home.join("vault.enc"), b"encrypted-v1-vault-blob").unwrap();

    // Legacy central hq.db with findings & tasks.
    {
        let conn = Connection::open(v1_home.join("hq.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT, project_id TEXT, status TEXT, title TEXT, created_at INTEGER);
             CREATE TABLE findings (id TEXT, project_id TEXT, title TEXT, severity TEXT, cvss_score REAL, asset TEXT, status TEXT, verified INTEGER, created_at INTEGER);
             INSERT INTO tasks VALUES ('T-V1-1', 'proj-v1alpha', 'done', 'Ship v1 migration', 1700000000000);
             INSERT INTO findings VALUES ('F-V1-1', 'proj-v1alpha', 'Legacy SSRF Check', 'high', 8.2, 'api.v1alpha.local', 'open', 1, 1700000000000);",
        )
        .unwrap();
    }

    // Legacy per-project memory.db.
    let proj_dir = v1_home.join("v1alpha");
    fs::create_dir_all(&proj_dir).unwrap();
    {
        let conn = Connection::open(proj_dir.join("memory.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE memories (id TEXT, mem_type TEXT, text TEXT, certified INTEGER, created_at INTEGER, last_used_at INTEGER);
             INSERT INTO memories VALUES ('M-V1-1', 'Decision', 'Always enforce deterministic rustls TLS for egress.', 1, 1700000000000, 1700000000000);",
        )
        .unwrap();
    }

    // Evidence file + malicious symlink escape attempt!
    let ev_dir = v1_home.join("evidence/v1alpha");
    fs::create_dir_all(&ev_dir).unwrap();
    fs::write(ev_dir.join("proof.txt"), b"legacy-evidence-data").unwrap();
    let outside_secret = tmp.path().join("outside-secret.txt");
    fs::write(&outside_secret, b"MUST-NOT-BE-COPIED").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside_secret, ev_dir.join("escape-link.txt")).unwrap();

    // Capture source snapshot mtime/files before migration to prove --from is untouched.
    let src_projects_before = fs::read(v1_home.join("projects.json")).unwrap();

    // 1. Dry-run MUST NOT create v2_home!
    let dry_report = migrate_v1_data(&MigrateV1Options {
        from: v1_home.clone(),
        to: v2_home.clone(),
        dry_run: true,
    })
    .unwrap();
    assert!(dry_report.dry_run);
    assert_eq!(dry_report.projects, 1);
    assert_eq!(dry_report.users, 1);
    assert_eq!(dry_report.tasks, 1);
    assert_eq!(dry_report.memories, 1);
    assert_eq!(dry_report.findings, 1);
    assert_eq!(dry_report.evidence_files, 1);
    assert!(dry_report.vault_found);
    #[cfg(unix)]
    assert!(
        dry_report
            .warnings
            .iter()
            .any(|w| w.contains("symlink")),
        "expected symlink warning, got {:?}",
        dry_report.warnings
    );
    assert!(!v2_home.exists(), "dry-run must NOT write to destination");

    // 2. Live migration run.
    let live_report = migrate_v1_data(&MigrateV1Options {
        from: v1_home.clone(),
        to: v2_home.clone(),
        dry_run: false,
    })
    .unwrap();
    assert!(!live_report.dry_run);
    assert_eq!(live_report.memories, 1);
    assert!(v2_home.join("arima.db").is_file());
    assert_eq!(
        fs::read(v2_home.join("v1-vault.enc")).unwrap(),
        b"encrypted-v1-vault-blob"
    );
    assert_eq!(
        fs::read(v2_home.join("evidence/v1alpha/proof.txt")).unwrap(),
        b"legacy-evidence-data"
    );
    assert!(
        !v2_home.join("evidence/v1alpha/escape-link.txt").exists(),
        "symlink escape must never be copied"
    );

    // 3. Idempotent second run produces zero errors and zero duplicate FTS5 rows!
    let second_report = migrate_v1_data(&MigrateV1Options {
        from: v1_home.clone(),
        to: v2_home.clone(),
        dry_run: false,
    })
    .unwrap();
    assert_eq!(second_report.projects, 1);

    let v2_db = Db::open(&v2_home.join("arima.db")).unwrap();
    let mem_repo = MemoryRepo::new(v2_db.clone());
    let hits = mem_repo
        .search("proj-v1alpha", Some("rustls"), MemoryStatusFilter::Certified)
        .unwrap();
    assert_eq!(hits.len(), 1, "expected exactly 1 FTS5 hit after idempotent re-run");
    assert_eq!(hits[0].id, "M-V1-1");

    // Source directory strictly unchanged.
    assert_eq!(
        fs::read(v1_home.join("projects.json")).unwrap(),
        src_projects_before
    );
}

#[tokio::test]
async fn m5_twenty_agent_concurrent_load_test_zero_errors_zero_drops() {
    let tmp = TempDir::new().unwrap();
    let db = Db::open(&tmp.path().join("load.db")).unwrap();
    let state = AppState::new(db, VaultKey::ephemeral(), ServerConfig::default());
    state
        .ensure_default_project("Load Project", "load-proj", "/tmp/load-proj")
        .unwrap();
    let (project_id, _, _, _) = state.default_project().unwrap();
    let app = router_with_state(state.clone());

    const AGENTS: usize = 20;
    const MSGS_PER_AGENT: usize = 10;

    let started = Instant::now();
    let mut handles = Vec::with_capacity(AGENTS);

    for idx in 0..AGENTS {
        let st = state.clone();
        let router = app.clone();
        let pid = project_id.clone();
        let agent_id = format!("agent-{idx:02}");
        let tok = st.inner.mcp.issue_agent_token(&pid, &agent_id);

        handles.push(tokio::spawn(async move {
            // 1. Enqueue 10 outbox messages concurrently into SQLite WAL.
            for m in 0..MSGS_PER_AGENT {
                st.inner
                    .outbox
                    .enqueue(
                        &pid,
                        &agent_id,
                        1,
                        OutboxMessageKind::Text,
                        &format!("{{\"agent\":\"{agent_id}\",\"n\":{m}}}"),
                    )
                    .expect("outbox enqueue under 20-agent load");
            }

            // 2. Record concurrent usage events.
            st.inner
                .usage
                .record_usage(&UsageEventInput {
                    project_id: pid.clone(),
                    agent_id: agent_id.clone(),
                    task_id: Some(format!("T-LOAD-{idx:02}")),
                    account_id: None,
                    provider: "anthropic".into(),
                    model: "claude-sonnet".into(),
                    input_tokens: 1200,
                    output_tokens: 450,
                    cache_read_tokens: 300,
                    cost_usd: 0.015,
                    at_ms: None,
                })
                .expect("usage write under 20-agent load");

            // 3. Call `/mcp` `update_task` concurrently via HTTP router.
            let req = Request::builder()
                .method(Method::POST)
                .uri(format!("/api/projects/{pid}/mcp"))
                .header(HOST, "127.0.0.1:7420")
                .header(ORIGIN, "http://127.0.0.1:7420")
                .header(CONTENT_TYPE, "application/json")
                .header(AUTHORIZATION, format!("Bearer {tok}"))
                .body(Body::from(
                    json!({
                        "jsonrpc": "2.0",
                        "id": idx,
                        "method": "tools/call",
                        "params": {
                            "name": "update_task",
                            "arguments": {
                                "id": format!("T-LOAD-{idx:02}"),
                                "title": format!("Concurrent task {idx:02}"),
                                "status": "done",
                                "stageId": "verify"
                            }
                        }
                    })
                    .to_string(),
                ))
                .unwrap();
            let resp = router.oneshot(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);

            // 4. Broadcast status event through `WsHub`.
            st.inner.ws_hub.broadcast_raw_json(
                &json!({ "type": "agent.status", "agentId": agent_id, "state": "done" })
                    .to_string(),
            );
        }));
    }

    for h in handles {
        h.await.expect("concurrent agent task must not panic");
    }

    let elapsed = started.elapsed();
    assert!(
        elapsed.as_secs() < 15,
        "20-agent concurrent load test took too long: {elapsed:?}"
    );

    // Verify ZERO dropped outbox messages (exact 20 * 10 = 200 messages) & exact 20 tasks & 20 usage rows!
    let mut total_pending = 0usize;
    for idx in 0..AGENTS {
        let aid = format!("agent-{idx:02}");
        let pending = state.inner.outbox.pending_count(&project_id, &aid).unwrap() as usize;
        assert_eq!(pending, MSGS_PER_AGENT, "dropped outbox messages for {aid}");
        total_pending += pending;
    }
    assert_eq!(total_pending, AGENTS * MSGS_PER_AGENT);

    let task_count: i64 = state
        .inner
        .db
        .read(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND id LIKE 'T-LOAD-%'",
                [&project_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)
        })
        .unwrap();
    assert_eq!(task_count as usize, AGENTS);

    let usage_report = state
        .inner
        .usage
        .aggregate_project_usage(&project_id, 1, None)
        .unwrap();
    assert_eq!(usage_report.agents.len(), AGENTS);
}
