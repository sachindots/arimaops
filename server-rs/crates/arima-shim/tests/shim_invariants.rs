// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;

use arima_core::{DecisionPayload, DecisionStatus, OutboxMessageKind, ServerRole};
use arima_db::{Db, DbError, DecisionsRepo, OutboxRepo};
use arima_shim::{
    validate_safe_argv, PendingPermissionPrompt, PermissionHookRequest, PermissionInterceptor,
    PermissionVerdict, PtyControlMessage, PtyMultiplexer, PtyOutboundFrame, ShimStateStore,
    StreamJsonRunner,
};
use tempfile::TempDir;
use tokio::sync::mpsc;

#[test]
fn crash_restart_epoch_bump_delivers_all_messages_despite_stale_ack() {
    let dir = TempDir::new().unwrap();
    let state_path = dir.path().join("shim-state.json");
    let db = Db::open(&dir.path().join("arima.db")).unwrap();

    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('proj-alpha', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
            [],
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();

    let outbox = OutboxRepo::new(db);

    // Epoch 1: HQ enqueues 5 messages; shim delivers all 5 and persists (epoch=1, ack=5).
    for i in 1..=5 {
        outbox
            .enqueue(
                "proj-alpha",
                "coder",
                1,
                OutboxMessageKind::Text,
                &format!("{{\"step\":{i}}}"),
            )
            .unwrap();
    }

    let mut runner = StreamJsonRunner::open("proj-alpha", "coder", &state_path).unwrap();
    let mut delivered_e1 = Vec::new();
    let batch1 = runner
        .drain_pending(&outbox, 1, |env| {
            delivered_e1.push((env.epoch, env.seq));
            Ok(())
        })
        .unwrap();
    assert_eq!(batch1.len(), 5);
    assert_eq!(runner.cursor().epoch, 1);
    assert_eq!(runner.cursor().ack, 5);

    // Verify atomic state file on disk has (epoch=1, ack=5).
    let persisted = ShimStateStore::load_or_default(&state_path).unwrap();
    assert_eq!((persisted.epoch, persisted.ack), (1, 5));

    // Simulate HQ crash/restart: server epoch bumps to 2 and enqueues seq 1..=3
    // while surviving shim restarts and reloads stale (epoch=1, ack=5) from disk!
    for i in 1..=3 {
        outbox
            .enqueue(
                "proj-alpha",
                "coder",
                2,
                OutboxMessageKind::DecisionAnswer,
                &format!("{{\"answer\":{i}}}"),
            )
            .unwrap();
    }

    let mut surviving_runner = StreamJsonRunner::open("proj-alpha", "coder", &state_path).unwrap();
    assert_eq!((surviving_runner.cursor().epoch, surviving_runner.cursor().ack), (1, 5));

    let mut delivered_e2 = Vec::new();
    let batch2 = surviving_runner
        .drain_pending(&outbox, 2, |env| {
            delivered_e2.push((env.epoch, env.seq, env.kind.clone()));
            Ok(())
        })
        .unwrap();

    // ZERO dropped messages: seq 1, 2, and 3 in epoch 2 must all be delivered in order!
    assert_eq!(batch2.len(), 3);
    assert_eq!(
        delivered_e2,
        vec![
            (2, 1, "decision-answer".into()),
            (2, 2, "decision-answer".into()),
            (2, 3, "decision-answer".into()),
        ]
    );
    assert_eq!((surviving_runner.cursor().epoch, surviving_runner.cursor().ack), (2, 3));
    assert_eq!(outbox.pending_count("proj-alpha", "coder").unwrap(), 0);
}

#[tokio::test]
async fn pty_multiplexer_streams_only_when_viewers_attached_and_guards_argv() {
    // 1. Strict argv validation blocks secrets/tokens on argv.
    assert!(validate_safe_argv("claude", &["--print".into()]).is_ok());
    assert!(validate_safe_argv("claude", &["--api-key=sk-ant-123".into()]).is_err());
    assert!(validate_safe_argv("codex", &["OPENAI_API_KEY=sk-proj-secret".into()]).is_err());
    assert!(validate_safe_argv("agy", &["--token".into(), "secret".into()]).is_err());

    // 2. On-demand streaming gate: 0 viewers -> buffered in scrollback only, 0 frames emitted.
    let (tx, mut rx) = mpsc::channel(64);
    let mux = PtyMultiplexer::new("coder", Some(32), tx);

    assert_eq!(mux.attached_viewers(), 0);
    mux.ingest_output(b"boot-line-1\n");
    mux.ingest_output(b"boot-line-2\n");
    assert_eq!(mux.emitted_output_frames(), 0);
    assert!(rx.try_recv().is_err(), "must not stream output when 0 viewers attached");
    assert!(mux.scrollback_snapshot().contains("boot-line-2"));

    // 3. Attach viewer-1 -> emits ViewerCount(1) + scrollback snapshot, then streams live chunks.
    mux.handle_control(PtyControlMessage::Attach {
        viewer_id: "viewer-1".into(),
    });
    assert_eq!(mux.attached_viewers(), 1);

    let ev1 = rx.recv().await.unwrap();
    assert_eq!(
        ev1,
        PtyOutboundFrame::ViewerCount {
            agent_id: "coder".into(),
            viewers: 1
        }
    );
    let ev2 = rx.recv().await.unwrap();
    match ev2 {
        PtyOutboundFrame::TerminalOutput { agent_id, data } => {
            assert_eq!(agent_id, "coder");
            assert!(data.contains("boot-line-2"));
        }
        other => panic!("expected scrollback TerminalOutput, got {other:?}"),
    }

    mux.ingest_output(b"live-chunk-3\n");
    let ev3 = rx.recv().await.unwrap();
    assert_eq!(
        ev3,
        PtyOutboundFrame::TerminalOutput {
            agent_id: "coder".into(),
            data: "live-chunk-3\n".into(),
        }
    );

    // 4. Detach viewer-1 -> drops viewers to 0 and halts upstream output frames immediately.
    mux.handle_control(PtyControlMessage::Detach {
        viewer_id: "viewer-1".into(),
    });
    assert_eq!(mux.attached_viewers(), 0);
    let ev4 = rx.recv().await.unwrap();
    assert_eq!(
        ev4,
        PtyOutboundFrame::ViewerCount {
            agent_id: "coder".into(),
            viewers: 0
        }
    );

    let emitted_before = mux.emitted_output_frames();
    mux.ingest_output(b"silent-chunk-4\n");
    assert_eq!(mux.emitted_output_frames(), emitted_before);
    assert!(rx.try_recv().is_err());

    // 5. Real subprocess execution with safe argv array (`echo`) captures output cleanly.
    let exit_code = mux
        .spawn_process(
            "/bin/echo",
            &["shim-subprocess-ok".into()],
            &HashMap::new(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(exit_code, Some(0));
    assert!(mux.scrollback_snapshot().contains("shim-subprocess-ok"));
}

#[tokio::test]
async fn permission_interceptor_round_trip_and_allow_for_task_cache() {
    let db = Db::open_in_memory().unwrap();
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('proj-alpha', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
            [],
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();
    let decisions_repo = DecisionsRepo::new(db);

    let interceptor =
        PermissionInterceptor::new("proj-alpha", "coder", Some("T01".into()));

    let (prompt_tx, mut prompt_rx) = mpsc::channel::<PendingPermissionPrompt>(8);

    // Spawn simulated HQ handler that persists the VisualDecision and replies AllowForTask.
    let repo_clone = decisions_repo.clone();
    tokio::spawn(async move {
        if let Some(pending) = prompt_rx.recv().await {
            repo_clone.upsert(&pending.decision).unwrap();
            let _ = pending
                .responder
                .send((PermissionVerdict::AllowForTask, Some("approved for T01".into())));
        }
        if let Some(pending2) = prompt_rx.recv().await {
            repo_clone.upsert(&pending2.decision).unwrap();
            let _ = pending2
                .responder
                .send((PermissionVerdict::Deny, Some("blocked rm -rf".into())));
        }
    });

    let req1 = PermissionHookRequest {
        tool_name: "bash".into(),
        command_or_path: "cargo test".into(),
        reason: "Run test suite".into(),
        scope_hint: Some("cargo test".into()),
    };

    // First request blocks on HQ and returns AllowForTask.
    let res1 = interceptor
        .request_permission(req1.clone(), &prompt_tx)
        .await
        .unwrap();
    assert!(res1.allow);
    assert_eq!(res1.decision, PermissionVerdict::AllowForTask);

    // Second identical request hits AllowForTask session cache immediately without prompting HQ!
    let res_cached = interceptor
        .request_permission(req1, &prompt_tx)
        .await
        .unwrap();
    assert!(res_cached.allow);
    assert_eq!(res_cached.decision_id, "cached-task-allow");

    // Different dangerous command prompts HQ and receives Deny.
    let req2 = PermissionHookRequest {
        tool_name: "bash".into(),
        command_or_path: "rm -rf /".into(),
        reason: "Clean disk".into(),
        scope_hint: None,
    };
    let res2 = interceptor
        .request_permission(req2.clone(), &prompt_tx)
        .await
        .unwrap();
    assert!(!res2.allow);
    assert_eq!(res2.decision, PermissionVerdict::Deny);

    // Verify DecisionsRepo integration helper persists & resolves PermissionPayload cleanly.
    let (resolved_dec, hook_resp) = interceptor
        .persist_and_resolve_with_repo(
            &decisions_repo,
            &req2,
            PermissionVerdict::AllowOnce,
            ServerRole::Operator,
            Some("allowed once in sandbox".into()),
        )
        .unwrap();
    assert_eq!(resolved_dec.status, DecisionStatus::Resolved);
    assert!(hook_resp.allow);
    match resolved_dec.payload {
        DecisionPayload::Permission(p) => {
            assert_eq!(p.resolution.as_deref(), Some("allow-once"));
        }
        other => panic!("expected Permission payload, got {other:?}"),
    }
}
