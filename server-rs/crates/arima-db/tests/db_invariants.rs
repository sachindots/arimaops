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
        assert_eq!(schema_version, 16);
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

    // 2. SkillScan payload is automatically classified as `owner_only = true`.
    let scan_dec = VisualDecision {
        id: "dec-scan1".into(),
        project_id: "p1".into(),
        from_id: "hq".into(),
        task_id: None,
        title: "Check skill acme/x".into(),
        details: "Skill scan".into(),
        waiting: true,
        owner_only: false, // classify_owner_only must promote to true!
        status: DecisionStatus::Open,
        payload: DecisionPayload::SkillScan {
            pack: "acme/x".into(),
            findings: vec!["suspicious".into()],
        },
        note: None,
        created_at: "2020-01-01T00:00:00Z".into(),
        closed_at: None,
    };
    let saved_scan = repo.upsert(&scan_dec).unwrap();
    assert!(saved_scan.owner_only);

    // Stall escalation must ONLY return dec-q1 and NEVER owner_only dec-scan1!
    let stalled = repo
        .list_escalatable_stalled("p1", i64::MAX)
        .unwrap();
    assert_eq!(stalled.len(), 1);
    assert_eq!(stalled[0].id, "dec-q1");

    // Viewer blocked on dec-q1; Operator blocked on dec-scan1; Owner succeeds on dec-scan1.
    assert!(repo
        .resolve("dec-q1", ResolveDecisionInput::default(), ServerRole::Viewer)
        .is_err());
    assert!(repo
        .resolve(
            "dec-scan1",
            ResolveDecisionInput::default(),
            ServerRole::Operator
        )
        .is_err());
    let resolved_scan = repo
        .resolve(
            "dec-scan1",
            ResolveDecisionInput::default(),
            ServerRole::Owner,
        )
        .unwrap();
    assert_eq!(resolved_scan.status, DecisionStatus::Resolved);
}

#[test]
fn opens_and_migrates_pre_upgrade_sqlite_db_with_fts5_and_backups() {
    use arima_db::{
        create_encrypted_backup, restore_encrypted_backup, verify_encrypted_backup,
        CreateMemoryInput, MemoryRepo, MemoryStatusFilter,
    };

    let fixture_src =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pre_upgrade_v032.db");
    assert!(
        fixture_src.is_file(),
        "pre-upgrade SQLite fixture missing at {}",
        fixture_src.display()
    );

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("state/arima.db");
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    fs::copy(&fixture_src, &db_path).unwrap();

    let db = Db::open(&db_path).unwrap();

    db.read(|conn| {
        let integrity: String = conn.query_row("PRAGMA integrity_check;", [], |r| r.get(0))?;
        assert_eq!(integrity.to_lowercase(), "ok");

        let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check;")?;
        assert_eq!(fk_stmt.query_map([], |_| Ok(()))?.count(), 0);

        // The fixture was written by main at migration 13; its rows must survive untouched.
        let original_migrations: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version <= 13 AND applied_at <= 1795503862961;",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(original_migrations, 11);

        let marker: String = conn.query_row(
            "SELECT value_json FROM server_settings WHERE key = 'upgradeFixtureMarker';",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(marker, "\"rusqlite-0.32\"");

        let task_title: String = conn.query_row(
            "SELECT title FROM tasks WHERE project_id = 'p-legacy' AND id = 'T01';",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(task_title, "Upgrade rusqlite safely");

        let passkey_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM passkeys;", [], |r| r.get(0))?;
        assert_eq!(passkey_count, 1);
        Ok::<_, DbError>(())
    })
    .unwrap();

    let mem_repo = MemoryRepo::new(db.clone());
    let fts_hits = mem_repo
        .search(
            "p-legacy",
            Some("upgrade backup"),
            MemoryStatusFilter::Certified,
        )
        .unwrap();
    assert_eq!(fts_hits.len(), 1);
    assert_eq!(fts_hits[0].id, "M-FTS-1");

    let passkey_hits = mem_repo
        .search("p-legacy", Some("passkey"), MemoryStatusFilter::All)
        .unwrap();
    assert_eq!(passkey_hits.len(), 1);
    assert_eq!(passkey_hits[0].id, "M-FTS-2");

    mem_repo
        .insert(
            "p-legacy",
            CreateMemoryInput {
                id: Some("M-FTS-3".into()),
                mem_type: "Lesson".into(),
                text: "Post-upgrade FTS5 indexing still matches new records cleanly.".into(),
                about: vec!["sqlite".into()],
                certified: true,
                created_at_ms: Some(1_700_000_002_000),
                last_used_at_ms: Some(1_700_000_002_000),
            },
        )
        .unwrap();
    let new_hits = mem_repo
        .search(
            "p-legacy",
            Some("post-upgrade indexing"),
            MemoryStatusFilter::Certified,
        )
        .unwrap();
    assert_eq!(new_hits.len(), 1);
    assert_eq!(new_hits[0].id, "M-FTS-3");

    let outbox = OutboxRepo::new(db.clone());
    let pending = outbox
        .next_pending("p-legacy", "coder", 1, 1, 0)
        .unwrap()
        .unwrap();
    assert_eq!((pending.epoch, pending.seq), (1, 1));

    let snap_path = dir.path().join("backups/pre-upgrade-snap.db");
    backup_sqlite_to(&db, &snap_path).unwrap();
    let snap_db = Db::open(&snap_path).unwrap();
    let snap_mem = MemoryRepo::new(snap_db);
    let snap_hits = snap_mem
        .search("p-legacy", Some("stemming"), MemoryStatusFilter::Certified)
        .unwrap();
    assert_eq!(snap_hits.len(), 1);
    assert_eq!(snap_hits[0].id, "M-FTS-1");

    let backups_dir = dir.path().join("encrypted-backups");
    let key = b"test-vault-key-material-32bytes!";
    let (_summary, manifest, archive) =
        create_encrypted_backup(&db, None, &backups_dir, key, "upgrade-test").unwrap();
    assert!(manifest.valid && manifest.integrity_ok);
    assert_eq!(manifest.projects_count, 1);
    assert_eq!(manifest.users_count, 1);
    assert_eq!(manifest.memories_count, 3);

    let verified = verify_encrypted_backup(&archive, key).unwrap();
    assert!(verified.valid && verified.integrity_ok);

    let target_db = Db::open(&dir.path().join("restored/arima.db")).unwrap();
    let outcome = restore_encrypted_backup(&target_db, None, None, &archive, key).unwrap();
    assert!(outcome.manifest.valid);
    let restored_hits = MemoryRepo::new(target_db)
        .search("p-legacy", Some("passkey"), MemoryStatusFilter::All)
        .unwrap();
    assert_eq!(restored_hits.len(), 1);
    assert_eq!(restored_hits[0].id, "M-FTS-2");
}

#[test]
fn migration_15_retires_dead_decision_kinds_and_tool_connections() {
    use arima_core::{DecisionPayload, DecisionStatus};
    use arima_db::DecisionsRepo;

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("state/arima.db");
    let db = Db::open(&db_path).unwrap();

    db.transaction(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, slug, name, root_path, created_at, updated_at)
             VALUES ('p1', 'alpha', 'Alpha', '/tmp/alpha', 1, 1);

             CREATE TABLE IF NOT EXISTS tool_connections (
                 id          TEXT PRIMARY KEY,
                 kind        TEXT NOT NULL,
                 label       TEXT NOT NULL,
                 endpoint    TEXT NOT NULL,
                 secret_enc  TEXT,
                 created_at  INTEGER NOT NULL,
                 updated_at  INTEGER NOT NULL
             );
             INSERT INTO tool_connections (id, kind, label, endpoint, secret_enc, created_at, updated_at)
             VALUES ('crm', 'mcp', 'CRM', 'https://crm.example/mcp', NULL, 1, 1);
             INSERT INTO server_settings (key, value_json, updated_at)
             VALUES ('connection-meta:crm', '{}', 1), ('other-setting', '{}', 1);

             INSERT INTO visual_decisions (id, project_id, from_id, title, details, waiting, owner_only, status, payload_json, created_at, closed_at)
             VALUES
               ('d-spec', 'p1', 'lead', 'Spec v1', 'Spec details', 1, 1, 'open', '{\"kind\":\"spec-approval\",\"boardId\":\"B1\",\"version\":1,\"markdown\":\"# Spec\"}', 100, NULL),
               ('d-plan', 'p1', 'lead', 'Plan v1', '', 1, 1, 'open', '{\"kind\":\"plan-approval\",\"markdown\":\"# Plan\"}', 101, NULL),
               ('d-gate', 'p1', 'lead', 'Gate', 'Gate details', 1, 1, 'resolved', '{\"kind\":\"gate-approval\",\"taskId\":\"T1\",\"gateId\":\"review\",\"reason\":\"ok\",\"deliverablePreview\":null}', 102, 200),
               ('d-send', 'p1', 'sales', 'Send email', 'Outbound body', 1, 1, 'open', '{\"kind\":\"send-proposal\",\"connection\":\"crm\",\"tool\":\"send\",\"args\":{},\"sentAt\":null,\"error\":null}', 103, NULL),
               ('d-spend', 'p1', 'hq', 'Spend alert', 'Over budget', 1, 1, 'open', '{\"kind\":\"spend-alert\",\"dailyUsd\":5.5,\"capUsd\":5.0,\"paused\":true}', 104, NULL),
               ('d-over', 'p1', 'hq', 'Overflow', 'Fallback', 0, 0, 'resolved', '{\"kind\":\"overflow-fallback\",\"agentId\":\"dev\",\"taskId\":\"T2\",\"cli\":\"codex\",\"model\":\"gpt-5\"}', 105, 250),
               ('d-keep', 'p1', 'hq', 'Current info', 'Keep me', 0, 0, 'open', '{\"kind\":\"info\",\"markdown\":\"Stay open\"}', 106, NULL);

             DROP INDEX IF EXISTS idx_mcp_tokens_hash;
             DELETE FROM schema_migrations WHERE version = 15;",
        )?;
        Ok::<_, DbError>(())
    })
    .unwrap();
    db.checkpoint_and_close().unwrap();

    let reopened = Db::open(&db_path).unwrap();
    let list = DecisionsRepo::new(reopened.clone())
        .list_by_project("p1", None)
        .unwrap();
    assert_eq!(list.len(), 7);

    let find = |id: &str| list.iter().find(|d| d.id == id).unwrap();
    for open_retired in ["d-spec", "d-plan", "d-send", "d-spend"] {
        let d = find(open_retired);
        assert_eq!(d.status, DecisionStatus::Dismissed, "{open_retired}");
        assert!(!d.waiting, "{open_retired}");
        assert!(d.closed_at.is_some(), "{open_retired}");
        assert!(matches!(d.payload, DecisionPayload::Info { .. }), "{open_retired}");
    }
    assert_eq!(
        find("d-plan").payload,
        DecisionPayload::Info { markdown: "Plan v1".into() }
    );
    assert_eq!(
        find("d-spec").payload,
        DecisionPayload::Info { markdown: "Spec details".into() }
    );

    for closed_retired in ["d-gate", "d-over"] {
        let d = find(closed_retired);
        assert_eq!(d.status, DecisionStatus::Resolved, "{closed_retired}");
        assert!(!d.waiting, "{closed_retired}");
        assert!(matches!(d.payload, DecisionPayload::Info { .. }), "{closed_retired}");
    }

    assert_eq!(find("d-keep").status, DecisionStatus::Open);

    reopened
        .read(|conn| {
            let conn_table: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tool_connections'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(conn_table, 0);

            let meta_left: i64 = conn.query_row(
                "SELECT COUNT(*) FROM server_settings WHERE key LIKE 'connection-meta:%'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(meta_left, 0);

            let other_kept: i64 = conn.query_row(
                "SELECT COUNT(*) FROM server_settings WHERE key = 'other-setting'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(other_kept, 1);

            let idx_exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_mcp_tokens_hash'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(idx_exists, 1);
            Ok::<_, DbError>(())
        })
        .unwrap();
}
