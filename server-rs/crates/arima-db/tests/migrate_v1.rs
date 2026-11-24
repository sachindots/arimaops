// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use arima_db::{
    migrate_v1_data, Db, FindingsRepo, MemoryRepo, MemoryStatusFilter, MigrateV1Options,
    VaultSecretRepo,
};
use serde_json::Value;
use tempfile::TempDir;

const FIXTURE_MASTER_KEY: &str = "fixture-v1-test-master-key-do-not-use-in-prod";

fn copy_dir_recursive(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let target = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir_recursive(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn decrypt_v2_secret(v2_home: &Path, id: &str, encoded: &str) -> String {
    let key_hex = fs::read_to_string(v2_home.join("vault.key")).unwrap();
    let key = hex::decode(key_hex.trim()).unwrap();
    let (nonce_hex, ct_hex) = encoded.split_once(':').unwrap();
    let nonce_raw = hex::decode(nonce_hex).unwrap();
    let ct = hex::decode(ct_hex).unwrap();
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let aad = format!("vault-secret:{id}");
    let nonce = Nonce::try_from(nonce_raw.as_slice()).unwrap();
    let pt = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ct,
                aad: aad.as_bytes(),
            },
        )
        .unwrap();
    String::from_utf8(pt).unwrap()
}

#[test]
fn migrates_the_real_v1_layout() {
    let tmp = TempDir::new().unwrap();
    let v1_home = tmp.path().join("v1-home");
    let v2_home = tmp.path().join("v2-home");
    let fixture_src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v1-home");
    copy_dir_recursive(&fixture_src, &v1_home);

    // Add a symlink escape under evidence/ to confirm it is rejected and never copied.
    let outside = tmp.path().join("outside-secret.txt");
    fs::write(&outside, b"MUST-NOT-BE-COPIED").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, v1_home.join("evidence/alpha/escape-link.txt")).unwrap();

    let alpha_repo = v1_home.join("repos/alpha");
    let beta_repo = v1_home.join("repos/legacy-beta");
    let src_db_before = fs::read(v1_home.join("arima.db")).unwrap();

    // 1. Dry-run without master key lists skipped secrets and writes nothing to v2_home.
    let dry = migrate_v1_data(&MigrateV1Options {
        from: v1_home.clone(),
        to: v2_home.clone(),
        dry_run: true,
        v1_master_key: None,
        repos: vec![alpha_repo.clone(), beta_repo.clone()],
    })
    .unwrap();
    assert!(dry.dry_run);
    assert_eq!(dry.projects, 2);
    assert_eq!(dry.templates, 1);
    assert_eq!(dry.boards, 3); // alpha B1+B2 + legacy-beta B1
    assert_eq!(dry.goals, 1);
    assert_eq!(dry.tasks, 3); // alpha T1+T2 + legacy-beta T-LEG-1
    assert_eq!(dry.users, 2);
    assert_eq!(dry.memories, 2);
    assert_eq!(dry.findings, 1);
    assert_eq!(dry.usage_events, 1);
    assert_eq!(dry.secrets_imported, 0);
    assert_eq!(
        dry.secrets_skipped,
        vec![
            "account:aws-bedrock".to_owned(),
            "account:work-anthropic".to_owned(),
            "push:fcm".to_owned(),
        ]
    );
    assert_eq!(dry.evidence_files, 1);
    assert!(dry.vault_found);
    assert!(dry.company_imported);
    #[cfg(unix)]
    assert!(dry.warnings.iter().any(|w| w.contains("symlink")));
    assert!(!v2_home.exists(), "dry-run must never create v2_home");

    // 2. Wrong v1 master key is rejected before writing anything.
    let wrong_key = migrate_v1_data(&MigrateV1Options {
        from: v1_home.clone(),
        to: v2_home.clone(),
        dry_run: true,
        v1_master_key: Some("wrong-key".into()),
        repos: vec![alpha_repo.clone(), beta_repo.clone()],
    });
    assert!(wrong_key.is_err());

    // 3. Live migration with master key & repo paths imports everything into v2 schema.
    let live = migrate_v1_data(&MigrateV1Options {
        from: v1_home.clone(),
        to: v2_home.clone(),
        dry_run: false,
        v1_master_key: Some(FIXTURE_MASTER_KEY.into()),
        repos: vec![alpha_repo.clone(), beta_repo.clone()],
    })
    .unwrap();
    assert!(!live.dry_run);
    assert_eq!(live.secrets_imported, 3);
    assert!(live.secrets_skipped.is_empty());

    let db = Db::open(&v2_home.join("arima.db")).unwrap();
    db.read(|conn| {
        // Users imported without passwords or TOTP secrets (Decision 1.5)
        let mut stmt = conn.prepare(
            "SELECT name, role, password_hash, totp_secret_enc, totp_enabled FROM users ORDER BY name ASC",
        )?;
        let users: Vec<(String, String, String, Option<String>, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        assert_eq!(
            users,
            vec![
                ("Priya".to_owned(), "operator".to_owned(), String::new(), None, 0),
                ("Sachin".to_owned(), "owner".to_owned(), String::new(), None, 0),
            ]
        );

        // Alpha project keeps custom template edits, charter, spendCaps, scope & resolved container seats
        let alpha_cfg_raw: String = conn.query_row(
            "SELECT config_json FROM projects WHERE id = 'alpha'",
            [],
            |r| r.get(0),
        )?;
        let alpha_cfg: Value = serde_json::from_str(&alpha_cfg_raw).unwrap();
        assert_eq!(alpha_cfg["team"]["template"]["name"], "Dev Team Custom Alpha");
        assert_eq!(alpha_cfg["team"]["project"]["charter"], "Ship reliable v2 releases");
        assert_eq!(alpha_cfg["team"]["project"]["spendCaps"]["dailyUsd"], 10.0);
        assert_eq!(alpha_cfg["team"]["team"][0]["mode"], "container");
        assert_eq!(alpha_cfg["team"]["team"][0]["account"], "work-anthropic");
        assert!(alpha_cfg["team"]["team"][0]["roleMd"]
            .as_str()
            .unwrap()
            .contains("Custom alpha lead guidance."));

        // Legacy beta preserves paused flag and its plan.json board + task
        let beta_paused: i64 = conn.query_row(
            "SELECT paused FROM projects WHERE id = 'legacy-beta'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(beta_paused, 1);
        let beta_task: String = conn.query_row(
            "SELECT title FROM tasks WHERE project_id = 'legacy-beta' AND id = 'T-LEG-1'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(beta_task, "Migrate legacy docs");

        // Board titles and spec markdown migrated intact
        let (b1_name, b1_ver, b1_spec): (String, i64, Option<String>) = conn.query_row(
            "SELECT name, spec_version, spec_markdown FROM boards WHERE project_id = 'alpha' AND id = 'B1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(b1_name, "Sprint 1");
        assert_eq!(b1_ver, 1);
        assert!(b1_spec.unwrap().contains("Enforce PKCE"));

        // Goal and linked task fields migrated
        let (g_title, g_target, g_curr): (String, String, String) = conn.query_row(
            "SELECT title, target_text, current_text FROM goals WHERE project_id = 'alpha' AND id = 'G1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(g_title, "Launch v2 beta");
        assert_eq!(g_target, "200");
        assert_eq!(g_curr, "45");

        let (t1_goal, t1_pr, t1_data): (Option<String>, Option<i64>, String) = conn.query_row(
            "SELECT goal_id, pr_number, data_json FROM tasks WHERE project_id = 'alpha' AND id = 'T1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(t1_goal.as_deref(), Some("G1"));
        assert_eq!(t1_pr, Some(42));
        let t1_json: Value = serde_json::from_str(&t1_data).unwrap();
        assert_eq!(t1_json["cli"], "claude");
        assert_eq!(t1_json["specItems"][0], "S1");

        // Usage events, company, customTemplates, account fields
        let usage_tokens: i64 = conn.query_row(
            "SELECT input_tokens FROM usage_events WHERE project_id = 'alpha' AND task_id = 'T1'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(usage_tokens, 1500);

        let company_raw: String = conn.query_row(
            "SELECT value_json FROM server_settings WHERE key = 'company'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(
            serde_json::from_str::<String>(&company_raw).unwrap(),
            "ArimaOps builds reliable multi-agent command decks."
        );

        let custom_raw: String = conn.query_row(
            "SELECT value_json FROM server_settings WHERE key = 'customTemplates'",
            [],
            |r| r.get(0),
        )?;
        let custom_arr: Vec<Value> = serde_json::from_str(&custom_raw).unwrap();
        assert_eq!(custom_arr.len(), 1);
        assert_eq!(custom_arr[0]["id"], "custom-web");

        let bedrock_fields_raw: String = conn.query_row(
            "SELECT value_json FROM server_settings WHERE key = 'account-fields:aws-bedrock'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(
            serde_json::from_str::<Value>(&bedrock_fields_raw).unwrap()["region"],
            "us-east-1"
        );
        Ok::<_, arima_db::DbError>(())
    })
    .unwrap();

    // Verify FTS5 memory search, findings, and decrypted secrets through repository APIs.
    let mem_repo = MemoryRepo::new(db.clone());
    let hits = mem_repo
        .search("alpha", Some("rustls"), MemoryStatusFilter::Certified)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].about.contains(&"server-rs/crates/arima-proxy/src/egress.rs".to_owned()));

    let findings = FindingsRepo::new(db.clone()).list_findings("alpha").unwrap();
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].title, "SSRF in webhook fetcher");
    assert_eq!(findings[0].cwe.as_deref(), Some("CWE-918"));
    assert_eq!(findings[0].target, "https://api.alpha.test/hook");

    let vault_repo = VaultSecretRepo::new(db.clone());
    let ant_rec = vault_repo.get_by_id("acct-work-anthropic").unwrap().unwrap();
    assert_eq!(
        decrypt_v2_secret(&v2_home, &ant_rec.id, &ant_rec.secret_enc),
        "sk-ant-fixture-alpha-9876"
    );
    let push_rec = vault_repo.get_by_id("v1:push:fcm").unwrap().unwrap();
    assert_eq!(
        decrypt_v2_secret(&v2_home, &push_rec.id, &push_rec.secret_enc),
        "fcm-fixture-server-key-5555"
    );

    // Evidence copied, symlink escape skipped.
    assert_eq!(
        fs::read_to_string(v2_home.join("evidence/alpha/proof.txt")).unwrap(),
        "v1-evidence-artifact\n"
    );
    assert!(!v2_home.join("evidence/alpha/escape-link.txt").exists());

    // 4. Second run is strictly idempotent with zero duplicate FTS5, usage, or customTemplate rows.
    let second = migrate_v1_data(&MigrateV1Options {
        from: v1_home.clone(),
        to: v2_home.clone(),
        dry_run: false,
        v1_master_key: Some(FIXTURE_MASTER_KEY.into()),
        repos: vec![alpha_repo, beta_repo],
    })
    .unwrap();
    assert_eq!(second.projects, 2);

    assert_eq!(
        mem_repo
            .search("alpha", Some("rustls"), MemoryStatusFilter::All)
            .unwrap()
            .len(),
        1
    );
    db.read(|conn| {
        let usage_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM usage_events WHERE project_id = 'alpha'", [], |r| r.get(0))?;
        assert_eq!(usage_count, 1);
        let custom_raw: String = conn.query_row(
            "SELECT value_json FROM server_settings WHERE key = 'customTemplates'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(serde_json::from_str::<Vec<Value>>(&custom_raw).unwrap().len(), 1);
        Ok::<_, arima_db::DbError>(())
    })
    .unwrap();

    // Source directory strictly unchanged.
    assert_eq!(fs::read(v1_home.join("arima.db")).unwrap(), src_db_before);
}
