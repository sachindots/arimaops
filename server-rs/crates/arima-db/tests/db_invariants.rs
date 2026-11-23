// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::path::Path;

use arima_core::OutboxMessageKind;
use arima_db::{backup_sqlite_to, forget_project, Db, DbError, OutboxRepo};
use tempfile::TempDir;

#[test]
fn opens_with_wal_foreign_keys_and_0600_permissions() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("state").join("arima.db");
    let db = Db::open(&db_path).unwrap();

    db.read(|conn| {
        let fk: i64 = conn.query_row("PRAGMA foreign_keys;", [], |r| r.get(0))?;
        let journal: String = conn.query_row("PRAGMA journal_mode;", [], |r| r.get(0))?;
        let schema_version: i64 =
            conn.query_row("SELECT MAX(version) FROM schema_migrations;", [], |r| {
                r.get(0)
            })?;
        assert_eq!(fk, 1);
        assert_eq!(journal.to_lowercase(), "wal");
        assert_eq!(schema_version, 9);
        Ok::<_, DbError>(())
    })
    .unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir_mode = fs::metadata(db_path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(&db_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }

    db.checkpoint_and_close().unwrap();
}

#[test]
fn nested_savepoints_rollback_inner_only_or_all() {
    let db = Db::open_in_memory().unwrap();

    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('p1', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
            [],
        )?;

        let inner_err: Result<(), DbError> = db.savepoint(conn, |c| {
            c.execute(
                "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
                 VALUES ('p2', 'beta', 'Beta', '/tmp/beta', 1, 1)",
                [],
            )?;
            Err(DbError::InvalidInput("abort inner".into()))
        });
        assert!(inner_err.is_err());

        db.savepoint(conn, |c| {
            c.execute(
                "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
                 VALUES ('p3', 'gamma', 'Gamma', '/tmp/gamma', 1, 1)",
                [],
            )?;
            Ok::<_, DbError>(())
        })?;

        Ok::<_, DbError>(())
    })
    .unwrap();

    let count: i64 = db
        .read(|c| {
            c.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
                .map_err(DbError::from)
        })
        .unwrap();
    assert_eq!(count, 2); // p1 and p3 survived; p2 rolled back

    // Outer rollback reverts everything inside the outer transaction.
    let outer_err: Result<(), DbError> = db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('p4', 'delta', 'Delta', '/tmp/delta', 1, 1)",
            [],
        )?;
        Err(DbError::InvalidInput("abort outer".into()))
    });
    assert!(outer_err.is_err());

    let after: i64 = db
        .read(|c| {
            c.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
                .map_err(DbError::from)
        })
        .unwrap();
    assert_eq!(after, 2);
}

#[test]
fn outbox_survives_epoch_restart_without_dropping_messages() {
    let db = Db::open_in_memory().unwrap();
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('p1', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
            [],
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();

    let outbox = OutboxRepo::new(db.clone());
    for i in 1..=5 {
        outbox
            .enqueue(
                "p1",
                "coder",
                1,
                OutboxMessageKind::Text,
                &format!("{{\"n\":{i}}}"),
            )
            .unwrap();
    }
    // Client acks up to seq=4 in epoch=1 (seq=5 still unacked when HQ restarts).
    let next_before = outbox.next_pending("p1", "coder", 1, 1, 4).unwrap().unwrap();
    assert_eq!((next_before.epoch, next_before.seq), (1, 5));
    // Client processes seq=5 and acks 5.
    assert!(outbox.next_pending("p1", "coder", 1, 1, 5).unwrap().is_none());

    // HQ restarts -> epoch becomes 2 and queues 3 new messages.
    for i in 1..=3 {
        outbox
            .enqueue(
                "p1",
                "coder",
                2,
                OutboxMessageKind::VisualFeedback,
                &format!("{{\"fb\":{i}}}"),
            )
            .unwrap();
    }
    assert_eq!(outbox.pending_count("p1", "coder").unwrap(), 3);

    // Surviving shim polls with stale (client_epoch=1, client_ack=5).
    // Must still receive (epoch=2, seq=1) instead of silently dropping seq 1..3!
    let first_new = outbox.next_pending("p1", "coder", 2, 1, 5).unwrap().unwrap();
    assert_eq!((first_new.epoch, first_new.seq), (2, 1));
    assert_eq!(first_new.kind, OutboxMessageKind::VisualFeedback);

    let second = outbox.next_pending("p1", "coder", 2, 2, 1).unwrap().unwrap();
    assert_eq!((second.epoch, second.seq), (2, 2));

    let third = outbox.next_pending("p1", "coder", 2, 2, 2).unwrap().unwrap();
    assert_eq!((third.epoch, third.seq), (2, 3));

    assert!(outbox.next_pending("p1", "coder", 2, 2, 3).unwrap().is_none());
    assert_eq!(outbox.pending_count("p1", "coder").unwrap(), 0);
}

#[test]
fn forget_project_purges_all_tables_and_disk_artifacts_cleanly() {
    let dir = TempDir::new().unwrap();
    let data_root = dir.path().join("arima-home");
    let db = Db::open(&data_root.join("arima.db")).unwrap();

    // Seed two projects ("target" and "keeper") with rows in EVERY project-scoped table.
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO users (id, name, password_hash, role, created_at)
             VALUES ('u1', 'sachin', 'hash', 'owner', 1)",
            [],
        )?;
        for (pid, slug) in [("p-target", "target"), ("p-keep", "keeper")] {
            conn.execute(
                "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
                 VALUES (?1, ?2, ?2, '/tmp/x', 1, 1)",
                [pid, slug],
            )?;
            conn.execute(
                "INSERT INTO user_project_roles (user_id, project_id, role, created_at)
                 VALUES ('u1', ?1, 'owner', 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO boards (id, project_id, name, status, created_at, updated_at)
                 VALUES ('B1', ?1, 'Main', 'active', 1, 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO goals (id, project_id, title, metric, target_value, status, created_at)
                 VALUES ('G1', ?1, 'Ship', 'prs', 5.0, 'active', 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO tasks (id, project_id, board_id, goal_id, stage_id, status, title, created_at, updated_at)
                 VALUES ('T01', ?1, 'B1', 'G1', 'build', 'doing', 'Task 1', 1, 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO task_events (project_id, task_id, status, stage_id, owner_id, at)
                 VALUES (?1, 'T01', 'doing', 'build', 'coder', 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO gate_events (project_id, task_id, gate_id, state, by_id, at)
                 VALUES (?1, 'T01', 'review', 'passed', 'rev', 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO scores (project_id, task_id, scorer, pass, reason, cost_usd, at)
                 VALUES (?1, 'T01', 'files', 1, 'clean', 0.01, 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO action_answers (project_id, id, kind, decision, at)
                 VALUES (?1, 'ai1', 'spec', 'done', 1)",
                [pid],
            )?;
            let dec_id = format!("dec-{pid}");
            let fb_id = format!("fb-{pid}");
            let msg_id = format!("msg-{pid}");
            conn.execute(
                "INSERT INTO visual_decisions (id, project_id, from_id, task_id, title, details, status, payload_json, created_at)
                 VALUES (?1, ?2, 'lead', 'T01', 'Q', 'Details', 'open', '{}', 1)",
                [&dec_id, pid],
            )?;
            conn.execute(
                "INSERT INTO visual_feedback (id, project_id, author_user_id, source_kind, page_url, viewport_width, viewport_height, note, image_path, workspace_rel_dir, route_json, created_at)
                 VALUES (?1, ?2, 'u1', 'preview', 'http://localhost', 1024, 768, 'Fix', 'img.png', '.arima/feedback/1', '{}', 1)",
                [&fb_id, pid],
            )?;
            conn.execute(
                "INSERT INTO messages (id, project_id, from_id, to_id, task_id, body, decision_id, feedback_id, created_at)
                 VALUES (?1, ?2, 'lead', 'you', 'T01', 'hi', ?3, ?4, 1)",
                [&msg_id, pid, &dec_id, &fb_id],
            )?;
            conn.execute(
                "INSERT INTO agent_outbox (project_id, agent_id, epoch, seq, kind, payload_json, created_at)
                 VALUES (?1, 'coder', 1, 1, 'text', '{}', 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO usage_events (project_id, agent_id, provider, model, input_tokens, output_tokens, cost_usd, at)
                 VALUES (?1, 'coder', 'anthropic', 'sonnet', 100, 50, 0.01, 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO memories (id, project_id, mem_type, text, created_at, last_used_at)
                 VALUES ('M1', ?1, 'Lesson', 'Always test FKs', 1, 1)",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO memory_about (project_id, memory_id, about)
                 VALUES (?1, 'M1', 'sqlite')",
                [pid],
            )?;
            conn.execute(
                "INSERT INTO memory_fts (id, project_id, text)
                 VALUES ('M1', ?1, 'Always test FKs')",
                [pid],
            )?;
            let les_id = format!("les-{pid}");
            conn.execute(
                "INSERT INTO promoted_lessons (id, project_id, source_memory_id, template_id, mem_type, text, created_at)
                 VALUES (?1, ?2, 'M1', 'software', 'Lesson', 'Always test FKs', 1)",
                [&les_id, pid],
            )?;
            conn.execute(
                "INSERT INTO findings (id, project_id, title, severity, status, created_at, updated_at)
                 VALUES ('F1', ?1, 'SSRF', 'critical', 'open', 1, 1)",
                [pid],
            )?;
            let mtg_id = format!("mtg-{pid}");
            let turn_id = format!("turn-{pid}");
            conn.execute(
                "INSERT INTO meetings (id, project_id, kind, status, urgency, title, moderator_id, participant_ids_json, requested_by, created_at)
                 VALUES (?1, ?2, 'standup', 'live', 'normal', 'Daily Standup', 'lead', '[\"lead\",\"coder\"]', 'lead', 1)",
                [&mtg_id, pid],
            )?;
            conn.execute(
                "INSERT INTO meeting_turns (id, project_id, meeting_id, speaker_id, speaker_role, kind, body_markdown, decision_id, created_at)
                 VALUES (?1, ?2, ?3, 'lead', 'Lead', 'recommendation', 'Proceed with A', ?4, 1)",
                [&turn_id, pid, &mtg_id, &dec_id],
            )?;
            let prop_id = format!("prop-{pid}");
            let bench_id = format!("bench-{pid}");
            conn.execute(
                "INSERT INTO improvement_proposals (id, project_id, title, rationale, category, diff_hint, status, created_at)
                 VALUES (?1, ?2, 'Tighten prompt', 'Reduce retries', 'prompt', '', 'open', 1)",
                [&prop_id, pid],
            )?;
            conn.execute(
                "INSERT INTO benchmark_runs (id, project_id, name, pass_rate, avg_score, avg_latency_ms, cases_json, created_at)
                 VALUES (?1, ?2, 'Smoke', 1.0, 0.95, 12.0, '[]', 1)",
                [&bench_id, pid],
            )?;
        }
        Ok::<_, DbError>(())
    })
    .unwrap();

    // Seed on-disk folders for both projects.
    for slug in ["target", "keeper"] {
        for sub in ["evidence", "feedback", "secrets"] {
            let p = data_root.join(sub).join(slug);
            fs::create_dir_all(&p).unwrap();
            fs::write(p.join("artifact.txt"), "secret").unwrap();
        }
        let usage = data_root.join("usage").join(format!("hq-{slug}-coder"));
        fs::create_dir_all(&usage).unwrap();
        fs::write(usage.join("transcript.jsonl"), "{}").unwrap();
    }

    // Reject path-traversal slug.
    assert!(forget_project(&db, "p-target", "../target", Some(&data_root)).is_err());

    let summary = forget_project(&db, "p-target", "target", Some(&data_root)).unwrap();
    assert_eq!(summary.projects_deleted, 1);
    assert_eq!(summary.fts_deleted, 1);
    assert_eq!(summary.dirs_removed, 4);

    let tables = [
        "boards",
        "tasks",
        "task_events",
        "gate_events",
        "goals",
        "scores",
        "action_answers",
        "visual_decisions",
        "visual_feedback",
        "messages",
        "agent_outbox",
        "usage_events",
        "memories",
        "memory_about",
        "memory_fts",
        "promoted_lessons",
        "findings",
        "meetings",
        "meeting_turns",
        "improvement_proposals",
        "benchmark_runs",
        "user_project_roles",
    ];
    db.read(|conn| {
        for table in tables {
            let target_rows: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id = 'p-target'"),
                [],
                |r| r.get(0),
            )?;
            let keeper_rows: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id = 'p-keep'"),
                [],
                |r| r.get(0),
            )?;
            assert_eq!(target_rows, 0, "leaked row in {table} for p-target");
            assert_eq!(keeper_rows, 1, "expected row preserved in {table} for p-keep");
        }
        Ok::<_, DbError>(())
    })
    .unwrap();

    assert!(!data_root.join("evidence/target").exists());
    assert!(!data_root.join("feedback/target").exists());
    assert!(!data_root.join("secrets/target").exists());
    assert!(!data_root.join("usage/hq-target-coder").exists());

    assert!(data_root.join("evidence/keeper/artifact.txt").exists());
    assert!(data_root.join("feedback/keeper/artifact.txt").exists());
    assert!(data_root.join("secrets/keeper/artifact.txt").exists());
    assert!(data_root.join("usage/hq-keeper-coder/transcript.jsonl").exists());
}

#[test]
fn backup_sqlite_creates_independent_consistent_snapshot() {
    let dir = TempDir::new().unwrap();
    let db = Db::open(&dir.path().join("live/arima.db")).unwrap();
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('p1', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
            [],
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();

    let backup_path = dir.path().join("backups/arima-snap.db");
    backup_sqlite_to(&db, &backup_path).unwrap();
    assert!(Path::new(&backup_path).exists());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&backup_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    let restored = Db::open(&backup_path).unwrap();
    let count: i64 = restored
        .read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM projects WHERE id = 'p1'", [], |r| {
                r.get(0)
            })
            .map_err(DbError::from)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn decisions_repo_enforces_owner_only_and_excludes_from_stall_escalation() {
    use arima_core::{
        DecisionPayload, DecisionStatus, QuestionOption, QuestionPayload, QuestionPrompt,
        ServerRole, VisualDecision,
    };
    use arima_db::{DecisionsRepo, ResolveDecisionInput};

    let db = Db::open_in_memory().unwrap();
    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('p1', 'alpha', 'Alpha', '/tmp/alpha', 1, 1)",
            [],
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();

    let repo = DecisionsRepo::new(db);

    // 1. Standard question (owner_only = false).
    let q_dec = VisualDecision {
        id: "dec-q1".into(),
        project_id: "p1".into(),
        from_id: "coder".into(),
        task_id: Some("T01".into()),
        title: "Pick test runner".into(),
        details: "Choose runner".into(),
        waiting: true,
        owner_only: false,
        status: DecisionStatus::Open,
        payload: DecisionPayload::Question(QuestionPayload {
            questions: vec![QuestionPrompt {
                id: "q1".into(),
                prompt: "Runner?".into(),
                multi_select: false,
                allow_other: false,
                options: vec![QuestionOption {
                    id: "nextest".into(),
                    label: "cargo test".into(),
                    description: None,
                    recommended: true,
                }],
            }],
            answers: vec![],
        }),
        note: None,
        created_at: "2020-01-01T00:00:00Z".into(),
        closed_at: None,
    };
    repo.upsert(&q_dec).unwrap();

    // 2. SpecApproval payload is automatically classified as `owner_only = true`.
    let spec_dec = VisualDecision {
        id: "dec-spec1".into(),
        project_id: "p1".into(),
        from_id: "lead".into(),
        task_id: None,
        title: "Approve v2 Spec".into(),
        details: "Spec approval".into(),
        waiting: true,
        owner_only: false, // classify_owner_only must promote to true!
        status: DecisionStatus::Open,
        payload: DecisionPayload::SpecApproval {
            board_id: "B1".into(),
            version: 1,
            markdown: "# Spec".into(),
        },
        note: None,
        created_at: "2020-01-01T00:00:00Z".into(),
        closed_at: None,
    };
    let saved_spec = repo.upsert(&spec_dec).unwrap();
    assert!(saved_spec.owner_only);

    // Stall escalation must ONLY return dec-q1 and NEVER owner_only dec-spec1!
    let stalled = repo
        .list_escalatable_stalled("p1", i64::MAX)
        .unwrap();
    assert_eq!(stalled.len(), 1);
    assert_eq!(stalled[0].id, "dec-q1");

    // Viewer blocked on dec-q1; Operator blocked on dec-spec1; Owner succeeds on dec-spec1.
    assert!(repo
        .resolve("dec-q1", ResolveDecisionInput::default(), ServerRole::Viewer)
        .is_err());
    assert!(repo
        .resolve(
            "dec-spec1",
            ResolveDecisionInput::default(),
            ServerRole::Operator
        )
        .is_err());
    let resolved_spec = repo
        .resolve(
            "dec-spec1",
            ResolveDecisionInput::default(),
            ServerRole::Owner,
        )
        .unwrap();
    assert_eq!(resolved_spec.status, DecisionStatus::Resolved);
}
