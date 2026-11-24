// SPDX-License-Identifier: AGPL-3.0-or-later

//! Lossless, read-only-source v1 -> v2 data migrator (`arima-server migrate-v1`).
//!
//! Reads the real Node v1 storage layout (`<from>/arima.db` `docs` rows + typed tables,
//! `accounts.json`, `vault.json`, `<repo>/.arima/arima.db`, and `evidence/`) strictly
//! read-only, supports `--dry-run` inspection with zero writes, imports atomically into
//! `<to>/arima.db` (re-indexing `memory_fts`), re-encrypts decrypted v1 secrets into v2's
//! `vault_secrets` when a v1 master key is supplied, copies `evidence/` rejecting symlinks
//! and path traversal, and is idempotent on re-run.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use rand::Rng;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{Db, DbError, Result};

/// Configuration for running the v1 -> v2 migrator.
#[derive(Debug, Clone, Default)]
pub struct MigrateV1Options {
    pub from: PathBuf,
    pub to: PathBuf,
    pub dry_run: bool,
    /// Optional v1 vault master key passphrase / base64 string (never stored on disk).
    pub v1_master_key: Option<String>,
    /// Extra repository roots whose `.arima/arima.db` holds `config.json` and `plan.json`.
    pub repos: Vec<PathBuf>,
}

/// Summary report produced by both `--dry-run` and live migrations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateV1Report {
    pub dry_run: bool,
    pub source_path: String,
    pub target_path: String,
    pub projects: usize,
    pub templates: usize,
    pub boards: usize,
    pub goals: usize,
    pub tasks: usize,
    pub users: usize,
    pub memories: usize,
    pub findings: usize,
    pub usage_events: usize,
    pub secrets_imported: usize,
    pub secrets_skipped: Vec<String>,
    pub evidence_files: usize,
    pub vault_found: bool,
    pub company_imported: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct V1Project {
    id: String,
    slug: String,
    name: String,
    root_path: String,
    template_id: Option<String>,
    config_json: String,
    paused: bool,
    archived: bool,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct V1User {
    id: String,
    name: String,
    role: String,
    disabled: bool,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct V1Board {
    id: String,
    project_id: String,
    name: String,
    status: String,
    ord: i64,
    spec_version: i64,
    spec_markdown: Option<String>,
}

#[derive(Debug, Clone)]
struct V1Goal {
    id: String,
    project_id: String,
    title: String,
    metric: String,
    target_value: f64,
    current_value: f64,
    target_text: String,
    current_text: String,
    status: String,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct V1Task {
    id: String,
    project_id: String,
    board_id: String,
    goal_id: Option<String>,
    stage_id: String,
    status: String,
    title: String,
    owner_id: Option<String>,
    pr_number: Option<i64>,
    template_id: Option<String>,
    template_version: Option<i64>,
    data_json: String,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct V1Memory {
    id: String,
    project_id: String,
    mem_type: String,
    text: String,
    certified: bool,
    superseded_by: Option<String>,
    about: Vec<String>,
    created_at: i64,
    last_used_at: i64,
}

#[derive(Debug, Clone)]
struct V1Finding {
    id: String,
    project_id: String,
    title: String,
    severity: String,
    cvss_score: Option<f64>,
    asset: String,
    status: String,
    verified: bool,
    data_json: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct V1UsageEvent {
    project_id: String,
    agent_id: String,
    task_id: Option<String>,
    account_id: Option<String>,
    provider: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cost_usd: f64,
    at: i64,
}

#[derive(Debug, Clone)]
struct AccountMeta {
    provider: String,
    label: String,
    fields: Value,
}

#[derive(Debug, Clone)]
struct DecryptedSecret {
    ref_name: String,
    plaintext: Vec<u8>,
}

#[derive(Debug, Clone)]
struct EvidenceCopyItem {
    src: PathBuf,
    rel_under_evidence: PathBuf,
}

#[derive(Debug, Clone)]
struct RepoOverlay {
    dir: PathBuf,
    config_json: Option<Value>,
    plan_json: Option<Value>,
}

#[derive(Default)]
struct ParsedV1Home {
    company: Option<String>,
    templates: Vec<Value>,
    projects: Vec<V1Project>,
    boards: Vec<V1Board>,
    goals: Vec<V1Goal>,
    tasks: Vec<V1Task>,
    users: Vec<V1User>,
    memories: Vec<V1Memory>,
    findings: Vec<V1Finding>,
    usage_events: Vec<V1UsageEvent>,
    accounts: HashMap<String, AccountMeta>,
    decrypted_secrets: Vec<DecryptedSecret>,
    secrets_skipped: Vec<String>,
    evidence: Vec<EvidenceCopyItem>,
    vault_found: bool,
    warnings: Vec<String>,
}

/// Runs a lossless v1 -> v2 migration (or non-mutating `--dry-run` scan).
///
/// The `--from` directory is NEVER modified under any circumstances.
pub fn migrate_v1_data(opts: &MigrateV1Options) -> Result<MigrateV1Report> {
    if !opts.from.is_dir() {
        return Err(DbError::InvalidInput(format!(
            "v1 source directory '{}' does not exist or is not a directory",
            opts.from.display()
        )));
    }
    if opts.from == opts.to {
        return Err(DbError::InvalidInput(
            "source (--from) and destination (--to) directories must differ".into(),
        ));
    }

    let parsed = read_home(&opts.from, opts.v1_master_key.as_deref(), &opts.repos)?;

    let report = MigrateV1Report {
        dry_run: opts.dry_run,
        source_path: opts.from.display().to_string(),
        target_path: opts.to.display().to_string(),
        projects: parsed.projects.len(),
        templates: parsed.templates.len(),
        boards: parsed.boards.len(),
        goals: parsed.goals.len(),
        tasks: parsed.tasks.len(),
        users: parsed.users.len(),
        memories: parsed.memories.len(),
        findings: parsed.findings.len(),
        usage_events: parsed.usage_events.len(),
        secrets_imported: parsed.decrypted_secrets.len(),
        secrets_skipped: parsed.secrets_skipped.clone(),
        evidence_files: parsed.evidence.len(),
        vault_found: parsed.vault_found,
        company_imported: parsed.company.is_some(),
        warnings: parsed.warnings.clone(),
    };

    if opts.dry_run {
        return Ok(report);
    }

    write_v2(opts, &parsed)?;
    Ok(report)
}

fn read_home(
    from: &Path,
    explicit_master_key: Option<&str>,
    extra_repos: &[PathBuf],
) -> Result<ParsedV1Home> {
    let mut out = ParsedV1Home::default();
    let now_ms = Utc::now().timestamp_millis();

    let central_db_path = from.join("arima.db");
    let central_conn = if is_regular_file(&central_db_path) {
        Some(open_sqlite_readonly(&central_db_path)?)
    } else {
        if central_db_path.exists() {
            out.warnings.push("skipped non-regular arima.db in v1 source".into());
        }
        None
    };

    // 1. Company context (`docs['company.json']` or plain file fallback)
    if let Some(company_val) = read_doc(central_conn.as_ref(), &from.join("company.json"), "company.json") {
        let text = company_val
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        out.company = text;
    }

    // 2. Users (`docs['users.json']` or plain file fallback), always password-less per Decision 1.5
    if let Some(users_val) = read_doc(central_conn.as_ref(), &from.join("users.json"), "users.json") {
        let mut seen_names = HashSet::new();
        let list = users_val
            .as_array()
            .or_else(|| users_val.get("users").and_then(Value::as_array));
        if let Some(items) = list {
            for item in items {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim();
                if name.is_empty() || !seen_names.insert(name.to_ascii_lowercase()) {
                    continue;
                }
                let id = non_empty_str(item.get("id"))
                    .unwrap_or_else(|| format!("usr-{}", sanitize_slug(name)));
                let role = match item
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("operator")
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "owner" => "owner",
                    "viewer" => "viewer",
                    _ => "operator",
                }
                .to_owned();
                out.users.push(V1User {
                    id,
                    name: name.to_owned(),
                    role,
                    disabled: item.get("disabled").and_then(Value::as_bool).unwrap_or(false),
                    created_at: parse_any_ts_json(item.get("createdAt"), now_ms),
                });
            }
        }
    }

    // 3. Projects registry (`docs['projects.json']` or plain file fallback)
    let mut raw_projects: Vec<(String, String, String, String, bool, bool, i64)> = Vec::new();
    let mut seen_pids = HashSet::new();
    if let Some(proj_val) = read_doc(central_conn.as_ref(), &from.join("projects.json"), "projects.json") {
        let list = proj_val
            .as_array()
            .or_else(|| proj_val.get("projects").and_then(Value::as_array));
        if let Some(items) = list {
            for item in items {
                let name_raw = item.get("name").and_then(Value::as_str).unwrap_or("").trim();
                let id_raw = non_empty_str(item.get("id"));
                let slug_src = non_empty_str(item.get("slug"))
                    .or_else(|| id_raw.clone())
                    .unwrap_or_else(|| name_raw.to_owned());
                if slug_src.is_empty() {
                    continue;
                }
                let slug = sanitize_slug(&slug_src);
                let id = id_raw.unwrap_or_else(|| slug.clone());
                if !seen_pids.insert(id.clone()) {
                    continue;
                }
                let root_path = item
                    .get("path")
                    .or_else(|| item.get("rootPath"))
                    .and_then(Value::as_str)
                    .unwrap_or(".")
                    .to_owned();
                let paused = item.get("paused").and_then(Value::as_bool).unwrap_or(false);
                let archived = match item.get("archived") {
                    Some(Value::Bool(b)) => *b,
                    Some(Value::String(s)) => !s.trim().is_empty(),
                    _ => false,
                };
                let created_at = parse_any_ts_json(
                    item.get("createdAt").or_else(|| item.get("lastUpdatedAt")),
                    now_ms,
                );
                let display_name = if name_raw.is_empty() { slug.clone() } else { name_raw.to_owned() };
                raw_projects.push((id, slug, display_name, root_path, paused, archived, created_at));
            }
        }
    }

    // 4. Core v1 SQLite tables
    let mut project_models: HashMap<String, (String, Value)> = HashMap::new();
    let mut specs_map: HashMap<(String, String), (i64, String)> = HashMap::new();
    let mut about_map: HashMap<(String, String), Vec<String>> = HashMap::new();

    if let Some(conn) = central_conn.as_ref() {
        read_custom_templates(conn, &mut out)?;
        read_project_models(conn, &mut project_models, &mut out.warnings)?;
        read_specs(conn, &mut specs_map)?;
        read_boards(conn, &specs_map, &mut out.boards)?;
        read_goals(conn, &mut out.goals)?;
        read_tasks(conn, &mut out.tasks)?;
        read_memory_about(conn, &mut about_map)?;
        read_memories(conn, &about_map, now_ms, &mut out.memories)?;
        read_findings(conn, now_ms, &mut out.findings)?;
        read_usage_events(conn, now_ms, &mut out.usage_events)?;
    }

    // Ensure any project referenced by project_models exists in project list before building configs
    let mut seen_slugs: HashSet<String> = raw_projects.iter().map(|p| p.1.clone()).collect();
    for pid in project_models.keys() {
        if seen_pids.insert(pid.clone()) {
            let slug = unique_slug(&sanitize_slug(pid), &mut seen_slugs);
            raw_projects.push((pid.clone(), slug, pid.clone(), ".".into(), false, false, now_ms));
        }
    }
    for pid in collect_referenced_project_ids(&out) {
        if seen_pids.insert(pid.clone()) {
            let slug = unique_slug(&sanitize_slug(&pid), &mut seen_slugs);
            out.warnings.push(format!("synthesized missing project entry '{pid}' referenced by v1 data"));
            raw_projects.push((pid, slug, String::new(), ".".into(), false, false, now_ms));
        }
    }

    // 5. Repo overlays (`--repo` paths first, then recorded `root_path` on disk)
    let repo_overlays = load_repo_overlays(extra_repos, &raw_projects, &mut out.warnings);

    // 6. Assemble finalized V1Project list + legacy repo `plan.json` fallback
    let central_board_pids: HashSet<String> = out.boards.iter().map(|b| b.project_id.clone()).collect();
    let central_task_pids: HashSet<String> = out.tasks.iter().map(|t| t.project_id.clone()).collect();

    for (idx, (id, mut slug, name_raw, root_path, paused, archived, created_at)) in raw_projects.into_iter().enumerate() {
        // Deduplicate slug across distinct projects (keep first occurrence intact)
        if idx > 0 && out.projects.iter().any(|p| p.slug == slug) {
            slug = unique_slug(&slug, &mut seen_slugs);
        }
        seen_slugs.insert(slug.clone());

        let overlay = repo_overlays
            .get(&id)
            .or_else(|| repo_overlays.get(&slug));
        let repo_cfg = overlay.and_then(|o| o.config_json.as_ref());

        let mut cfg_root = Map::new();
        let mut template_id: Option<String> = None;

        if let Some((tpl_id, tpl_body)) = project_models.get(&id) {
            template_id = Some(tpl_id.clone());
            let team_model = assemble_team_config(tpl_body, repo_cfg);
            cfg_root.insert("team".into(), team_model);
            if overlay.is_none() {
                out.warnings.push(format!(
                    "repo .arima/arima.db not found for template project '{id}'; synthesized default seats"
                ));
            }
        } else if let Some(legacy_cfg) = repo_cfg {
            let mut normalized = legacy_cfg.clone();
            if let Some(team) = normalized.get_mut("team").and_then(Value::as_array_mut) {
                for seat in team {
                    if let Some(obj) = seat.as_object_mut() {
                        obj.insert("mode".into(), json!("container"));
                        obj.remove("nextMode");
                    }
                }
            }
            cfg_root.insert("legacyConfig".into(), normalized);
        }

        if let Some(scope) = repo_cfg.and_then(|c| c.get("project")).and_then(|p| p.get("scope")) {
            if scope.is_object() {
                cfg_root.insert("scope".into(), scope.clone());
            }
        }

        if !project_models.contains_key(&id) {
            if let Some(plan) = overlay.and_then(|o| o.plan_json.as_ref()) {
                if !central_board_pids.contains(&id) {
                    import_plan_boards(&id, plan, &mut out.boards);
                }
                if !central_task_pids.contains(&id) {
                    import_plan_tasks(&id, plan, now_ms, &mut out.tasks);
                }
            }
        }

        let effective_root = overlay
            .map(|o| o.dir.display().to_string())
            .filter(|_| root_path == "." || !Path::new(&root_path).exists())
            .unwrap_or(root_path);

        let name = if name_raw.is_empty() {
            repo_cfg
                .and_then(|c| c.get("project"))
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&slug)
                .to_owned()
        } else {
            name_raw
        };

        out.projects.push(V1Project {
            id,
            slug,
            name,
            root_path: effective_root,
            template_id,
            config_json: Value::Object(cfg_root).to_string(),
            paused,
            archived,
            created_at,
        });
    }

    // 7. `accounts.json` + `vault.json`
    read_accounts_json(&from.join("accounts.json"), &mut out.accounts, &mut out.warnings);
    let vault_res = decrypt_v1_vault(from, explicit_master_key)?;
    out.vault_found = vault_res.found;
    out.decrypted_secrets = vault_res.decrypted;
    out.secrets_skipped = vault_res.skipped;
    out.warnings.extend(vault_res.warnings);

    // 8. `evidence/`
    let ev_root = from.join("evidence");
    if ev_root.exists() {
        if is_symlink(&ev_root) {
            out.warnings.push("rejected symlinked evidence/ directory".into());
        } else if ev_root.is_dir() {
            collect_evidence_readonly(&ev_root, &ev_root, &mut out.evidence, &mut out.warnings)?;
        }
    }

    Ok(out)
}

fn write_v2(opts: &MigrateV1Options, parsed: &ParsedV1Home) -> Result<()> {
    crate::ensure_private_dir(&opts.to)?;

    let v2_secrets: Vec<(String, String, String, String, String)> = if parsed.decrypted_secrets.is_empty() {
        Vec::new()
    } else {
        let v2_key = load_or_create_v2_vault_key(&opts.to)?;
        let mut encrypted = Vec::with_capacity(parsed.decrypted_secrets.len());
        for sec in &parsed.decrypted_secrets {
            let (id, scope, provider, label) = if let Some(acct_id) = sec.ref_name.strip_prefix("account:") {
                let meta = parsed.accounts.get(acct_id);
                let provider = meta
                    .map(|m| m.provider.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "custom".into());
                let label = meta
                    .map(|m| m.label.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| acct_id.to_owned());
                (format!("acct-{acct_id}"), "account".to_owned(), provider, label)
            } else {
                let provider = sec
                    .ref_name
                    .split(':')
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("v1")
                    .to_ascii_lowercase();
                (
                    format!("v1:{}", sec.ref_name),
                    "v1-migrated".to_owned(),
                    provider,
                    sec.ref_name.clone(),
                )
            };
            let aad = format!("vault-secret:{id}");
            let enc = encrypt_v2_vault(&v2_key, aad.as_bytes(), &sec.plaintext)?;
            encrypted.push((id, scope, provider, label, enc));
        }
        encrypted
    };

    let db = Db::open(&opts.to.join("arima.db"))?;
    let now_ms = Utc::now().timestamp_millis();

    db.transaction(|conn| {
        for u in &parsed.users {
            conn.execute(
                "INSERT INTO users
                    (id, name, password_hash, role, disabled, totp_secret_enc, totp_enabled, created_at)
                 VALUES (?1, ?2, '', ?3, ?4, NULL, 0, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                    role = excluded.role,
                    disabled = excluded.disabled",
                rusqlite::params![
                    u.id,
                    u.name,
                    u.role,
                    i64::from(u.disabled),
                    u.created_at,
                ],
            )?;
        }

        for p in &parsed.projects {
            let existing_cfg: Option<String> = conn
                .query_row("SELECT config_json FROM projects WHERE id = ?1", [&p.id], |r| r.get(0))
                .optional()?;
            let merged_cfg = merge_project_config(existing_cfg.as_deref(), &p.config_json);
            conn.execute(
                "INSERT INTO projects
                    (id, slug, name, root_path, template_id, config_json, paused, archived, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    root_path = excluded.root_path,
                    template_id = COALESCE(excluded.template_id, projects.template_id),
                    config_json = excluded.config_json,
                    paused = excluded.paused,
                    archived = excluded.archived,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    p.id,
                    p.slug,
                    p.name,
                    p.root_path,
                    p.template_id,
                    merged_cfg,
                    i64::from(p.paused),
                    i64::from(p.archived),
                    p.created_at,
                    now_ms,
                ],
            )?;
        }

        let mut known_boards: HashSet<(String, String)> = HashSet::new();
        for b in &parsed.boards {
            known_boards.insert((b.project_id.clone(), b.id.clone()));
            let created_at = now_ms + b.ord.max(0);
            conn.execute(
                "INSERT INTO boards
                    (id, project_id, name, status, spec_version, spec_markdown, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    name = excluded.name,
                    status = excluded.status,
                    spec_version = excluded.spec_version,
                    spec_markdown = excluded.spec_markdown,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    b.id,
                    b.project_id,
                    b.name,
                    b.status,
                    b.spec_version,
                    b.spec_markdown,
                    created_at,
                    now_ms,
                ],
            )?;
        }

        for p in &parsed.projects {
            if !parsed.boards.iter().any(|b| b.project_id == p.id) {
                known_boards.insert((p.id.clone(), "B1".into()));
                conn.execute(
                    "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                     VALUES ('B1', ?1, 'Backlog', 'active', ?2, ?2)",
                    rusqlite::params![p.id, p.created_at],
                )?;
            }
        }

        let mut known_goals: HashSet<(String, String)> = HashSet::new();
        for g in &parsed.goals {
            known_goals.insert((g.project_id.clone(), g.id.clone()));
            conn.execute(
                "INSERT INTO goals
                    (id, project_id, title, metric, target_value, current_value, status, created_at, target_text, current_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    title = excluded.title,
                    metric = excluded.metric,
                    target_value = excluded.target_value,
                    current_value = excluded.current_value,
                    status = excluded.status,
                    target_text = excluded.target_text,
                    current_text = excluded.current_text",
                rusqlite::params![
                    g.id,
                    g.project_id,
                    g.title,
                    g.metric,
                    g.target_value,
                    g.current_value,
                    g.status,
                    g.created_at,
                    g.target_text,
                    g.current_text,
                ],
            )?;
        }

        for t in &parsed.tasks {
            if !known_boards.contains(&(t.project_id.clone(), t.board_id.clone())) {
                known_boards.insert((t.project_id.clone(), t.board_id.clone()));
                conn.execute(
                    "INSERT OR IGNORE INTO boards (id, project_id, name, status, created_at, updated_at)
                     VALUES (?1, ?2, 'Main Board', 'active', ?3, ?3)",
                    rusqlite::params![t.board_id, t.project_id, t.updated_at],
                )?;
            }
            let valid_goal = t
                .goal_id
                .as_ref()
                .filter(|gid| known_goals.contains(&(t.project_id.clone(), (*gid).clone())))
                .cloned();
            conn.execute(
                "INSERT INTO tasks
                    (id, project_id, board_id, goal_id, stage_id, status, title, owner_id, pr_number, template_id, template_version, data_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    board_id = excluded.board_id,
                    goal_id = excluded.goal_id,
                    stage_id = excluded.stage_id,
                    status = excluded.status,
                    title = excluded.title,
                    owner_id = excluded.owner_id,
                    pr_number = excluded.pr_number,
                    template_id = COALESCE(excluded.template_id, tasks.template_id),
                    template_version = COALESCE(excluded.template_version, tasks.template_version),
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    t.id,
                    t.project_id,
                    t.board_id,
                    valid_goal,
                    t.stage_id,
                    t.status,
                    t.title,
                    t.owner_id,
                    t.pr_number,
                    t.template_id,
                    t.template_version,
                    t.data_json,
                    t.updated_at,
                ],
            )?;
        }

        for m in &parsed.memories {
            conn.execute(
                "INSERT INTO memories
                    (id, project_id, mem_type, text, certified, created_at, last_used_at, superseded_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    mem_type = excluded.mem_type,
                    text = excluded.text,
                    certified = excluded.certified,
                    last_used_at = excluded.last_used_at,
                    superseded_by = excluded.superseded_by",
                rusqlite::params![
                    m.id,
                    m.project_id,
                    m.mem_type,
                    m.text,
                    i64::from(m.certified),
                    m.created_at,
                    m.last_used_at,
                    m.superseded_by,
                ],
            )?;
            for tag in &m.about {
                conn.execute(
                    "INSERT OR IGNORE INTO memory_about (project_id, memory_id, about)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![m.project_id, m.id, tag],
                )?;
            }
            conn.execute(
                "DELETE FROM memory_fts WHERE project_id = ?1 AND id = ?2",
                rusqlite::params![m.project_id, m.id],
            )?;
            conn.execute(
                "INSERT INTO memory_fts (id, project_id, text) VALUES (?1, ?2, ?3)",
                rusqlite::params![m.id, m.project_id, m.text],
            )?;
        }

        for f in &parsed.findings {
            conn.execute(
                "INSERT INTO findings
                    (id, project_id, title, severity, cvss_score, asset, status, verified, data_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(project_id, id) DO UPDATE SET
                    title = excluded.title,
                    severity = excluded.severity,
                    cvss_score = excluded.cvss_score,
                    asset = excluded.asset,
                    status = excluded.status,
                    verified = excluded.verified,
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    f.id,
                    f.project_id,
                    f.title,
                    f.severity,
                    f.cvss_score,
                    f.asset,
                    f.status,
                    i64::from(f.verified),
                    f.data_json,
                    f.created_at,
                    f.updated_at,
                ],
            )?;
        }

        for u in &parsed.usage_events {
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM usage_events
                     WHERE project_id = ?1 AND agent_id = ?2 AND at = ?3 AND model = ?4
                       AND input_tokens = ?5 AND output_tokens = ?6
                     LIMIT 1",
                    rusqlite::params![
                        u.project_id,
                        u.agent_id,
                        u.at,
                        u.model,
                        u.input_tokens,
                        u.output_tokens,
                    ],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                conn.execute(
                    "INSERT INTO usage_events
                        (project_id, agent_id, task_id, account_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    rusqlite::params![
                        u.project_id,
                        u.agent_id,
                        u.task_id,
                        u.account_id,
                        u.provider,
                        u.model,
                        u.input_tokens,
                        u.output_tokens,
                        u.cache_read_tokens,
                        u.cost_usd,
                        u.at,
                    ],
                )?;
            }
        }

        if let Some(company) = &parsed.company {
            upsert_setting(conn, "company", &json!(company).to_string(), now_ms)?;
        }

        if !parsed.templates.is_empty() {
            let existing_raw: Option<String> = conn
                .query_row(
                    "SELECT value_json FROM server_settings WHERE key = 'customTemplates'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let mut merged: Vec<Value> = existing_raw
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok())
                .unwrap_or_default();
            for tpl in &parsed.templates {
                let id = tpl.get("id").and_then(Value::as_str).unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                if let Some(pos) = merged.iter().position(|x| x.get("id").and_then(Value::as_str) == Some(id)) {
                    merged[pos] = tpl.clone();
                } else {
                    merged.push(tpl.clone());
                }
            }
            upsert_setting(conn, "customTemplates", &Value::Array(merged).to_string(), now_ms)?;
        }

        for (acct_id, meta) in &parsed.accounts {
            if meta.fields.as_object().is_some_and(|m| !m.is_empty()) {
                upsert_setting(
                    conn,
                    &format!("account-fields:{acct_id}"),
                    &meta.fields.to_string(),
                    now_ms,
                )?;
            }
        }

        for (id, scope, provider, label, secret_enc) in &v2_secrets {
            conn.execute(
                "INSERT INTO vault_secrets (id, scope, provider, label, secret_enc, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    scope = excluded.scope,
                    provider = excluded.provider,
                    label = excluded.label,
                    secret_enc = excluded.secret_enc,
                    updated_at = excluded.updated_at",
                rusqlite::params![id, scope, provider.to_ascii_lowercase(), label, secret_enc, now_ms],
            )?;
        }

        Ok::<_, DbError>(())
    })?;

    let dest_ev_root = opts.to.join("evidence");
    for item in &parsed.evidence {
        validate_rel_path(&item.rel_under_evidence)?;
        let dest_path = dest_ev_root.join(&item.rel_under_evidence);
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = fs::read(&item.src)?;
        fs::write(&dest_path, &bytes)?;
    }

    db.checkpoint_and_close()?;
    Ok(())
}

fn upsert_setting(conn: &Connection, key: &str, value_json: &str, now_ms: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO server_settings (key, value_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at",
        rusqlite::params![key, value_json, now_ms],
    )?;
    Ok(())
}

fn merge_project_config(existing_json: Option<&str>, new_json: &str) -> String {
    let mut base = existing_json
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if let Ok(Value::Object(incoming)) = serde_json::from_str::<Value>(new_json) {
        for (k, v) in incoming {
            base.insert(k, v);
        }
    }
    Value::Object(base).to_string()
}

fn open_sqlite_readonly(path: &Path) -> Result<Connection> {
    if !is_regular_file(path) {
        return Err(DbError::InvalidInput(format!(
            "refusing non-regular or symlinked SQLite path: {}",
            path.display()
        )));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if let Ok(conn) = Connection::open_with_flags(path, flags) {
        let _ = conn.pragma_update(None, "query_only", true);
        return Ok(conn);
    }
    // Fallback for read-only bind mounts where SQLite cannot create `-shm` beside `-wal`.
    let encoded = percent_encode_uri_path(path);
    let uri = format!("file:{encoded}?mode=ro&immutable=1");
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let _ = conn.pragma_update(None, "query_only", true);
    Ok(conn)
}

fn percent_encode_uri_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'?' => out.push_str("%3F"),
            b'#' => out.push_str("%23"),
            b'%' => out.push_str("%25"),
            b => out.push(*b as char),
        }
    }
    out
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    let hit: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1 LIMIT 1",
            [table],
            |r| r.get(0),
        )
        .optional()?;
    Ok(hit.is_some())
}

fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut cols = HashSet::new();
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\"")))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for col in rows {
        cols.insert(col?.to_ascii_lowercase());
    }
    Ok(cols)
}

fn read_doc(conn: Option<&Connection>, fallback_file: &Path, name: &str) -> Option<Value> {
    if let Some(c) = conn {
        if table_exists(c, "docs").ok()? {
            if let Ok(Some(raw)) = c
                .query_row("SELECT value FROM docs WHERE name = ?1", [name], |r| r.get::<_, String>(0))
                .optional()
            {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    return Some(v);
                }
            }
        }
    }
    if is_regular_file(fallback_file) {
        return fs::read_to_string(fallback_file)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    }
    None
}

fn read_custom_templates(conn: &Connection, out: &mut ParsedV1Home) -> Result<()> {
    if !table_exists(conn, "templates")? {
        return Ok(());
    }
    let cols = table_columns(conn, "templates")?;
    let sql = if cols.contains("builtin") {
        "SELECT id, body FROM templates WHERE builtin = 0 ORDER BY id ASC"
    } else {
        "SELECT id, body FROM templates ORDER BY id ASC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, raw_body) = row?;
        match serde_json::from_str::<Value>(&raw_body) {
            Ok(mut body) => {
                if body.get("id").and_then(Value::as_str).unwrap_or("").is_empty() {
                    if let Some(obj) = body.as_object_mut() {
                        obj.insert("id".into(), json!(id));
                    }
                }
                out.templates.push(body);
            }
            Err(e) => out.warnings.push(format!("skipped unreadable template '{id}': {e}")),
        }
    }
    Ok(())
}

fn read_project_models(
    conn: &Connection,
    out: &mut HashMap<String, (String, Value)>,
    warnings: &mut Vec<String>,
) -> Result<()> {
    if !table_exists(conn, "projects_model")? {
        return Ok(());
    }
    let mut stmt = conn.prepare("SELECT project_id, template_id, body FROM projects_model")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    for row in rows {
        let (pid, tid, raw_body) = row?;
        match serde_json::from_str::<Value>(&raw_body) {
            Ok(body) => {
                out.insert(pid, (tid, body));
            }
            Err(e) => warnings.push(format!("skipped unreadable projects_model for '{pid}': {e}")),
        }
    }
    Ok(())
}

fn read_specs(conn: &Connection, out: &mut HashMap<(String, String), (i64, String)>) -> Result<()> {
    if !table_exists(conn, "specs")? {
        return Ok(());
    }
    let mut stmt = conn.prepare("SELECT project_id, board_id, version, text FROM specs")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (pid, bid, ver, text) = row?;
        out.insert((pid, bid), (ver, text));
    }
    Ok(())
}

fn read_boards(
    conn: &Connection,
    specs: &HashMap<(String, String), (i64, String)>,
    out: &mut Vec<V1Board>,
) -> Result<()> {
    if !table_exists(conn, "boards")? {
        return Ok(());
    }
    let cols = table_columns(conn, "boards")?;
    let title_col = if cols.contains("title") { "title" } else { "name" };
    let ord_expr = if cols.contains("ord") { "ord" } else { "rowid" };
    let sql = format!(
        "SELECT project_id, id, {title_col}, status, {ord_expr} FROM boards ORDER BY project_id ASC, {ord_expr} ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    for row in rows {
        let (pid, id, name, status, ord) = row?;
        let spec = specs.get(&(pid.clone(), id.clone()));
        out.push(V1Board {
            id,
            project_id: pid,
            name,
            status,
            ord,
            spec_version: spec.map_or(0, |(v, _)| *v),
            spec_markdown: spec.map(|(_, s)| s.clone()),
        });
    }
    Ok(())
}

fn read_goals(conn: &Connection, out: &mut Vec<V1Goal>) -> Result<()> {
    if !table_exists(conn, "goals")? {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT project_id, id, title, metric, target, current, status, created_at
         FROM goals ORDER BY project_id ASC, created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        let target_text = r.get::<_, Option<String>>(4)?.unwrap_or_default();
        let current_text = r.get::<_, Option<String>>(5)?.unwrap_or_default();
        let created_at = parse_ts_ref(r.get_ref(7)?, 0);
        Ok(V1Goal {
            project_id: r.get(0)?,
            id: r.get(1)?,
            title: r.get(2)?,
            metric: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            target_value: parse_leading_number(&target_text),
            current_value: parse_leading_number(&current_text),
            target_text,
            current_text,
            status: r.get(6)?,
            created_at,
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

fn read_tasks(conn: &Connection, out: &mut Vec<V1Task>) -> Result<()> {
    if !table_exists(conn, "tasks")? {
        return Ok(());
    }
    let cols = table_columns(conn, "tasks")?;
    let opt = |name: &str, expr: &str| {
        if cols.contains(name) {
            expr.to_owned()
        } else {
            format!("NULL AS {name}")
        }
    };
    let sql = format!(
        "SELECT project_id, id, {board}, {stage}, title, {owner}, status, {needs}, {files},
                {desc}, {done_when}, {note}, {pr}, {deliv}, {cli}, {model}, {updated},
                {spec_items}, {high_stakes}, {tpl_id}, {tpl_ver}, {goal}
         FROM tasks ORDER BY project_id ASC, rowid ASC",
        board = if cols.contains("board_id") { "board_id" } else { "'B1'" },
        stage = if cols.contains("stage_id") { "stage_id" } else { "'work'" },
        owner = opt("owner_id", "owner_id"),
        needs = if cols.contains("needs") { "needs" } else { "'[]'" },
        files = if cols.contains("files") { "files" } else { "'[]'" },
        desc = opt("description", "description"),
        done_when = opt("done_when", "done_when"),
        note = opt("note", "note"),
        pr = opt("pr_number", "pr_number"),
        deliv = opt("deliverable_path", "deliverable_path"),
        cli = opt("cli", "cli"),
        model = opt("model", "model"),
        updated = if cols.contains("updated_at") {
            "updated_at"
        } else if cols.contains("created_at") {
            "created_at"
        } else {
            "0"
        },
        spec_items = if cols.contains("spec_items") { "spec_items" } else { "'[]'" },
        high_stakes = if cols.contains("high_stakes") { "high_stakes" } else { "0" },
        tpl_id = opt("template_id", "template_id"),
        tpl_ver = opt("template_version", "template_version"),
        goal = opt("goal_id", "goal_id"),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        let mut data = Map::new();
        let needs: Value = r
            .get::<_, Option<String>>(7)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!([]));
        let files: Value = r
            .get::<_, Option<String>>(8)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!([]));
        let spec_items: Value = r
            .get::<_, Option<String>>(17)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!([]));
        data.insert("needs".into(), needs);
        data.insert("files".into(), files);
        if let Some(d) = r.get::<_, Option<String>>(9)? {
            data.insert("description".into(), json!(d));
        }
        if let Some(dw) = r.get::<_, Option<String>>(10)? {
            data.insert("doneWhen".into(), json!(dw));
        }
        if let Some(note) = r.get::<_, Option<String>>(11)? {
            data.insert("note".into(), json!(note));
        }
        if let Some(deliv) = r.get::<_, Option<String>>(13)? {
            data.insert("deliverablePath".into(), json!(deliv));
        }
        if let Some(cli) = r.get::<_, Option<String>>(14)? {
            data.insert("cli".into(), json!(cli));
        }
        if let Some(model) = r.get::<_, Option<String>>(15)? {
            data.insert("model".into(), json!(model));
        }
        if spec_items.as_array().is_some_and(|a| !a.is_empty()) {
            data.insert("specItems".into(), spec_items);
        }
        if r.get::<_, Option<i64>>(18)?.unwrap_or(0) != 0 {
            data.insert("highStakes".into(), json!(true));
        }

        Ok(V1Task {
            project_id: r.get(0)?,
            id: r.get(1)?,
            board_id: r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "B1".into()),
            stage_id: r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "work".into()),
            title: r.get(4)?,
            owner_id: r.get(5)?,
            status: r.get(6)?,
            pr_number: r.get(12)?,
            updated_at: parse_ts_ref(r.get_ref(16)?, 0),
            template_id: r.get(19)?,
            template_version: r.get(20)?,
            goal_id: r.get(21)?,
            data_json: Value::Object(data).to_string(),
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

fn read_memory_about(
    conn: &Connection,
    out: &mut HashMap<(String, String), Vec<String>>,
) -> Result<()> {
    if !table_exists(conn, "memory_about")? {
        return Ok(());
    }
    let cols = table_columns(conn, "memory_about")?;
    let path_col = if cols.contains("path") { "path" } else { "about" };
    let sql = format!("SELECT project_id, memory_id, {path_col} FROM memory_about ORDER BY {path_col} ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    for row in rows {
        let (pid, mid, about) = row?;
        out.entry((pid, mid)).or_default().push(about);
    }
    Ok(())
}

fn read_memories(
    conn: &Connection,
    about_map: &HashMap<(String, String), Vec<String>>,
    fallback_ms: i64,
    out: &mut Vec<V1Memory>,
) -> Result<()> {
    if !table_exists(conn, "memories")? {
        return Ok(());
    }
    let cols = table_columns(conn, "memories")?;
    let type_col = if cols.contains("type") { "type" } else { "mem_type" };
    let sup_expr = if cols.contains("superseded_by") {
        "superseded_by"
    } else {
        "NULL"
    };
    let sql = format!(
        "SELECT project_id, id, {type_col}, text, certified, created_at, last_used_at, {sup_expr}
         FROM memories"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        let pid: String = r.get(0)?;
        let id: String = r.get(1)?;
        let mem_type: String = r.get(2)?;
        let text: String = r.get(3)?;
        let certified = r.get::<_, i64>(4)? != 0;
        let created_at = parse_ts_ref(r.get_ref(5)?, fallback_ms);
        let last_used_at = parse_ts_ref(r.get_ref(6)?, created_at);
        let superseded_by: Option<String> = r.get(7)?;
        let about = about_map.get(&(pid.clone(), id.clone())).cloned().unwrap_or_default();
        Ok(V1Memory {
            id,
            project_id: pid,
            mem_type,
            text,
            certified,
            superseded_by,
            about,
            created_at,
            last_used_at,
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

fn read_findings(conn: &Connection, fallback_ms: i64, out: &mut Vec<V1Finding>) -> Result<()> {
    if !table_exists(conn, "findings")? {
        return Ok(());
    }
    let cols = table_columns(conn, "findings")?;
    if !cols.contains("asset_value") {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT project_id, id, reporter_id, title, asset_value, cvss_vector, cvss_score, severity,
                cwe, description, impact, remediation, evidence, verified, status, at, updated_at
         FROM findings ORDER BY project_id ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        let reporter_id: Option<String> = r.get(2)?;
        let cvss_vector: Option<String> = r.get(5)?;
        let cwe_raw: Option<String> = r.get(8)?;
        let cwe = cwe_raw
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .and_then(|v| v.into_iter().find(|s| !s.trim().is_empty()));
        let description: String = r.get::<_, Option<String>>(9)?.unwrap_or_default();
        let impact: String = r.get::<_, Option<String>>(10)?.unwrap_or_default();
        let remediation: String = r.get::<_, Option<String>>(11)?.unwrap_or_default();
        let ev_raw: Option<String> = r.get(12)?;
        let evidence_refs: Vec<String> = ev_raw
            .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
            .map(|items| {
                items
                    .into_iter()
                    .filter_map(|item| {
                        item.as_str()
                            .map(str::to_owned)
                            .or_else(|| item.get("content").and_then(Value::as_str).map(str::to_owned))
                    })
                    .filter(|s| !s.trim().is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let created_at = parse_ts_ref(r.get_ref(15)?, fallback_ms);
        let updated_at = parse_ts_ref(r.get_ref(16)?, created_at);
        let extra = json!({
            "cwe": cwe,
            "cvssVector": cvss_vector,
            "descriptionMarkdown": description,
            "reproductionMarkdown": impact,
            "remediationMarkdown": remediation,
            "evidenceRefs": evidence_refs,
            "reporterId": reporter_id.filter(|s| !s.trim().is_empty()),
        });
        Ok(V1Finding {
            project_id: r.get(0)?,
            id: r.get(1)?,
            title: r.get(3)?,
            asset: r.get(4)?,
            cvss_score: r.get(6)?,
            severity: r.get(7)?,
            verified: r.get::<_, i64>(13)? != 0,
            status: r.get(14)?,
            data_json: extra.to_string(),
            created_at,
            updated_at,
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

fn read_usage_events(conn: &Connection, fallback_ms: i64, out: &mut Vec<V1UsageEvent>) -> Result<()> {
    if !table_exists(conn, "usage_events")? {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT at, project_id, task_id, agent_id, account, provider, model, input, cached, output, cost_usd
         FROM usage_events ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        let at = parse_ts_ref(r.get_ref(0)?, fallback_ms);
        let account: String = r.get::<_, Option<String>>(4)?.unwrap_or_default();
        Ok(V1UsageEvent {
            at,
            project_id: r.get(1)?,
            task_id: r.get(2)?,
            agent_id: r.get::<_, Option<String>>(3)?
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "unknown".into()),
            account_id: (!account.trim().is_empty()).then_some(account),
            provider: r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "unknown".into()),
            model: r.get(6)?,
            input_tokens: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            cache_read_tokens: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
            output_tokens: r.get::<_, Option<i64>>(9)?.unwrap_or(0),
            cost_usd: r.get::<_, Option<f64>>(10)?.unwrap_or(0.0),
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

fn load_repo_overlays(
    extra_repos: &[PathBuf],
    raw_projects: &[(String, String, String, String, bool, bool, i64)],
    warnings: &mut Vec<String>,
) -> HashMap<String, RepoOverlay> {
    let mut overlays = HashMap::new();
    let mut candidates: Vec<PathBuf> = extra_repos.to_vec();
    for (_, _, _, root_path, _, _, _) in raw_projects {
        if !root_path.is_empty() && root_path != "." {
            let p = PathBuf::from(root_path);
            if !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }

    for repo_dir in candidates {
        match read_repo_dir(&repo_dir) {
            Ok(Some((keys, overlay))) => {
                for key in keys {
                    overlays.entry(key).or_insert_with(|| overlay.clone());
                }
            }
            Ok(None) => {}
            Err(e) => warnings.push(format!("failed reading repo {}: {e}", repo_dir.display())),
        }
    }
    overlays
}

fn read_repo_dir(repo_dir: &Path) -> Result<Option<(Vec<String>, RepoOverlay)>> {
    if !repo_dir.is_dir() || is_symlink(repo_dir) {
        return Ok(None);
    }
    let db_path = [".arima", ".hq"]
        .iter()
        .map(|d| repo_dir.join(d).join("arima.db"))
        .find(|p| is_regular_file(p));
    let Some(db_path) = db_path else {
        return Ok(None);
    };
    let conn = open_sqlite_readonly(&db_path)?;
    let config_json = read_doc(Some(&conn), Path::new("/nonexistent"), "config.json");
    let plan_json = read_doc(Some(&conn), Path::new("/nonexistent"), "plan.json");

    let mut keys = Vec::new();
    if let Some(proj) = config_json.as_ref().and_then(|c| c.get("project")) {
        if let Some(id) = non_empty_str(proj.get("id")) {
            keys.push(sanitize_slug(&id));
            if id != keys[0] {
                keys.push(id);
            }
        }
        if let Some(name) = non_empty_str(proj.get("name")) {
            let s = sanitize_slug(&name);
            if !keys.contains(&s) {
                keys.push(s);
            }
        }
    }
    if let Some(dir_name) = repo_dir.file_name().and_then(|s| s.to_str()) {
        let s = sanitize_slug(dir_name);
        if !keys.contains(&s) {
            keys.push(s);
        }
    }

    Ok(Some((
        keys,
        RepoOverlay {
            dir: repo_dir.to_path_buf(),
            config_json,
            plan_json,
        },
    )))
}

fn assemble_team_config(template: &Value, repo_cfg: Option<&Value>) -> Value {
    let roles = template
        .get("roles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let raw_seats: Vec<Value> = repo_cfg
        .and_then(|c| c.get("team"))
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .cloned()
        .unwrap_or_else(|| synthesize_seats_from_roles(&roles));

    let team: Vec<Value> = raw_seats
        .into_iter()
        .map(|seat| resolve_v2_seat(&roles, seat))
        .collect();

    let waits_for_merge = template["flow"]["stages"]
        .as_array()
        .is_some_and(|stages| {
            stages.iter().any(|s| {
                s["gates"]
                    .as_array()
                    .is_some_and(|g| g.iter().any(|gate| gate["kind"] == "pr-merged"))
            })
        });
    let default_workflow = json!({
        "mode": if waits_for_merge { "github-pr" } else { "deliverables" },
        "review": { "enabled": true, "tool": "human", "command": "" },
        "merge": { "by": "human" },
        "deploy": { "enabled": false, "tool": "custom", "command": "", "perAgentEnvironments": false }
    });
    let workflow = repo_cfg
        .and_then(|c| c.get("workflow"))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(default_workflow);

    let rules = template.get("rules").cloned().unwrap_or_else(|| {
        json!({ "findings": false, "plans": false, "scopeRequired": false, "labMode": false, "outbound": "none", "egress": [] })
    });

    let stack = repo_cfg
        .and_then(|c| c.get("stack"))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(Value::Null);

    let mut project_extra = Map::new();
    if let Some(proj_obj) = repo_cfg.and_then(|c| c.get("project")).and_then(Value::as_object) {
        for key in [
            "officeName",
            "charter",
            "standup",
            "rituals",
            "exportPlan",
            "crossProject",
            "spendCaps",
            "promoteLessons",
        ] {
            if let Some(v) = proj_obj.get(key) {
                project_extra.insert(key.into(), v.clone());
            }
        }
    }

    json!({
        "template": template,
        "team": team,
        "workflow": workflow,
        "rules": rules,
        "stack": stack,
        "project": Value::Object(project_extra),
    })
}

fn synthesize_seats_from_roles(roles: &[Value]) -> Vec<Value> {
    let mut ordered: Vec<&Value> = roles.iter().collect();
    ordered.sort_by_key(|r| !r["isLead"].as_bool().unwrap_or(false));
    let mut out = Vec::new();
    let mut idx = 0usize;
    for role in ordered {
        let count = role["seats"].as_u64().unwrap_or(0);
        for _ in 0..count {
            idx += 1;
            let is_lead = role["isLead"].as_bool().unwrap_or(false);
            let name = if is_lead {
                "Cipher".to_owned()
            } else {
                format!("Agent {idx}")
            };
            out.push(json!({
                "id": sanitize_slug(&name),
                "name": name,
                "roleId": role["id"],
                "color": role.get("color").and_then(Value::as_str).unwrap_or("#818cf8"),
                "mode": "container",
                "account": "",
                "workspacePath": Value::Null,
                "sandbox": { "resources": { "cpus": Value::Null, "memoryGb": Value::Null }, "allow": [], "deny": [] },
                "mcp": []
            }));
        }
    }
    out
}

fn resolve_v2_seat(roles: &[Value], seat: Value) -> Value {
    let mut obj = seat.as_object().cloned().unwrap_or_default();
    obj.insert("mode".into(), json!("container"));
    obj.remove("nextMode");
    if obj.get("account").and_then(Value::as_str) == Some("") {
        obj.remove("account");
    }
    if let Some(role) = obj
        .get("roleId")
        .and_then(Value::as_str)
        .and_then(|rid| roles.iter().find(|r| r["id"] == rid))
    {
        obj.insert("role".into(), role["title"].clone());
        for key in ["isLead", "cli", "model", "skills", "roleMd"] {
            if let Some(val) = role.get(key) {
                obj.insert(key.into(), val.clone());
            }
        }
    }
    Value::Object(obj)
}

fn import_plan_boards(project_id: &str, plan: &Value, out: &mut Vec<V1Board>) {
    for (idx, b) in plan["boards"].as_array().into_iter().flatten().enumerate() {
        let id = non_empty_str(b.get("id")).unwrap_or_else(|| format!("B{}", idx + 1));
        let name = non_empty_str(b.get("title"))
            .or_else(|| non_empty_str(b.get("name")))
            .unwrap_or_else(|| id.clone());
        let status = non_empty_str(b.get("status")).unwrap_or_else(|| "active".into());
        let ord = b.get("order").and_then(Value::as_i64).unwrap_or(idx as i64);
        out.push(V1Board {
            id,
            project_id: project_id.to_owned(),
            name,
            status,
            ord,
            spec_version: 0,
            spec_markdown: None,
        });
    }
}

fn import_plan_tasks(project_id: &str, plan: &Value, now_ms: i64, out: &mut Vec<V1Task>) {
    for (idx, t) in plan["tasks"].as_array().into_iter().flatten().enumerate() {
        let id = non_empty_str(t.get("id")).unwrap_or_else(|| format!("T-LEG-{}", idx + 1));
        let mut data = Map::new();
        data.insert(
            "needs".into(),
            t.get("needs").cloned().unwrap_or_else(|| json!([])),
        );
        data.insert(
            "files".into(),
            t.get("files").cloned().unwrap_or_else(|| json!([])),
        );
        for k in ["description", "doneWhen", "note", "deliverablePath", "cli", "model"] {
            if let Some(v) = t.get(k).filter(|v| !v.is_null()) {
                data.insert(k.into(), v.clone());
            }
        }
        if t.get("highStakes").and_then(Value::as_bool) == Some(true) {
            data.insert("highStakes".into(), json!(true));
        }
        out.push(V1Task {
            id,
            project_id: project_id.to_owned(),
            board_id: non_empty_str(t.get("boardId")).unwrap_or_else(|| "B1".into()),
            goal_id: non_empty_str(t.get("goalId")),
            stage_id: non_empty_str(t.get("stageId")).unwrap_or_else(|| "work".into()),
            status: non_empty_str(t.get("status")).unwrap_or_else(|| "todo".into()),
            title: non_empty_str(t.get("title")).unwrap_or_else(|| "Untitled task".into()),
            owner_id: non_empty_str(t.get("ownerId")),
            pr_number: t.get("prNumber").and_then(Value::as_i64),
            template_id: non_empty_str(t.get("templateId")),
            template_version: t.get("templateVersion").and_then(Value::as_i64),
            data_json: Value::Object(data).to_string(),
            updated_at: parse_any_ts_json(t.get("movedAt"), now_ms),
        });
    }
}

fn read_accounts_json(
    path: &Path,
    out: &mut HashMap<String, AccountMeta>,
    warnings: &mut Vec<String>,
) {
    if !path.exists() {
        return;
    }
    if !is_regular_file(path) {
        warnings.push("skipped non-regular accounts.json".into());
        return;
    }
    match fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
    {
        Some(list) => {
            for item in list {
                let Some(id) = non_empty_str(item.get("id")) else { continue };
                let provider = non_empty_str(item.get("provider")).unwrap_or_else(|| "custom".into());
                let label = non_empty_str(item.get("label")).unwrap_or_else(|| id.clone());
                let fields = item
                    .get("fields")
                    .filter(|v| v.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                out.insert(id, AccountMeta { provider, label, fields });
            }
        }
        None => warnings.push("accounts.json could not be parsed".into()),
    }
}

#[derive(Default)]
struct VaultReadResult {
    found: bool,
    decrypted: Vec<DecryptedSecret>,
    skipped: Vec<String>,
    warnings: Vec<String>,
}

fn decrypt_v1_vault(
    from: &Path,
    explicit_master_key: Option<&str>,
) -> Result<VaultReadResult> {
    let mut warnings = Vec::new();
    let vault_path = from.join("vault.json");
    if !vault_path.exists() {
        return Ok(VaultReadResult::default());
    }
    if !is_regular_file(&vault_path) {
        warnings.push("skipped symlinked or non-regular vault.json in source directory".into());
        return Ok(VaultReadResult {
            warnings,
            ..Default::default()
        });
    }

    let raw = fs::read_to_string(&vault_path)?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| DbError::InvalidInput(format!("corrupt v1 vault.json: {e}")))?;

    let entries: BTreeMap<String, Value> = parsed
        .get("entries")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    let key_from_file = if explicit_master_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        let kf = from.join("vault.key");
        if is_regular_file(&kf) {
            fs::read_to_string(&kf).ok()
        } else {
            None
        }
    } else {
        None
    };

    let master_text = explicit_master_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            key_from_file
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        });

    let Some(master_text) = master_text else {
        let skipped: Vec<String> = entries.keys().cloned().collect();
        if !skipped.is_empty() {
            warnings.push(format!(
                "v1 vault.json has {} secret(s) that require --v1-master-key-file to import",
                skipped.len()
            ));
        }
        return Ok(VaultReadResult {
            found: true,
            skipped,
            warnings,
            ..Default::default()
        });
    };

    let key = derive_v1_vault_key(&master_text);
    let expected_check = parsed.get("check").and_then(Value::as_str).unwrap_or("");
    let actual_check = &hex::encode(Sha256::digest(key))[..16];
    if expected_check != actual_check {
        return Err(DbError::InvalidInput(
            "v1 master key does not match vault.json check fingerprint".into(),
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| DbError::InvalidInput(format!("v1 vault cipher init failed: {e}")))?;

    let mut decrypted = Vec::with_capacity(entries.len());
    for (ref_name, sealed) in entries {
        let iv_b64 = sealed.get("iv").and_then(Value::as_str).unwrap_or("");
        let tag_b64 = sealed.get("tag").and_then(Value::as_str).unwrap_or("");
        let data_b64 = sealed.get("data").and_then(Value::as_str).unwrap_or("");
        let iv = BASE64
            .decode(iv_b64)
            .map_err(|_| DbError::InvalidInput(format!("invalid v1 vault iv for '{ref_name}'")))?;
        if iv.len() != 12 {
            return Err(DbError::InvalidInput(format!(
                "invalid v1 vault nonce length for '{ref_name}'"
            )));
        }
        let mut combined = BASE64.decode(data_b64).map_err(|_| {
            DbError::InvalidInput(format!("invalid v1 vault ciphertext for '{ref_name}'"))
        })?;
        let tag = BASE64
            .decode(tag_b64)
            .map_err(|_| DbError::InvalidInput(format!("invalid v1 vault tag for '{ref_name}'")))?;
        combined.extend_from_slice(&tag);
        let nonce = Nonce::try_from(iv.as_slice())
            .map_err(|_| DbError::InvalidInput("invalid v1 vault nonce".into()))?;
        let plaintext = cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &combined,
                    aad: ref_name.as_bytes(),
                },
            )
            .map_err(|_| {
                DbError::InvalidInput(format!("failed decrypting v1 vault entry '{ref_name}'"))
            })?;
        decrypted.push(DecryptedSecret {
            ref_name,
            plaintext,
        });
    }

    Ok(VaultReadResult {
        found: true,
        decrypted,
        skipped: Vec::new(),
        warnings,
    })
}

/// Mirrors `server/credentials/vault.ts:keyFrom` exactly.
fn derive_v1_vault_key(text: &str) -> [u8; 32] {
    let trimmed = text.trim();
    if let Ok(raw) = BASE64.decode(trimmed) {
        if raw.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&raw);
            return key;
        }
    }
    let digest = Sha256::digest(trimmed.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// Matches `arima_auth::VaultKey::load_or_create(Some(dir))` identically.
fn load_or_create_v2_vault_key(dir: &Path) -> Result<[u8; 32]> {
    if let Ok(env_key) = std::env::var("ARIMA_MASTER_KEY") {
        let trimmed = env_key.trim();
        if !trimmed.is_empty() {
            if let Ok(raw) = hex::decode(trimmed) {
                if raw.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&raw);
                    return Ok(key);
                }
            }
            let digest = Sha256::digest(trimmed.as_bytes());
            let mut key = [0u8; 32];
            key.copy_from_slice(&digest);
            return Ok(key);
        }
    }

    let key_path = dir.join("vault.key");
    if key_path.exists() {
        let contents = fs::read_to_string(&key_path)?;
        let raw = hex::decode(contents.trim())
            .map_err(|_| DbError::InvalidInput("corrupt v2 vault.key hex".into()))?;
        if raw.len() != 32 {
            return Err(DbError::InvalidInput("invalid v2 vault.key length".into()));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&raw);
        return Ok(key);
    }

    let mut key = [0u8; 32];
    UnwrapErr(SysRng).fill_bytes(&mut key);
    let hex_key = hex::encode(key);
    write_private_file(&key_path, hex_key.as_bytes())?;
    Ok(key)
}

fn encrypt_v2_vault(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| DbError::InvalidInput(format!("v2 cipher init failed: {e}")))?;
    let mut nonce_bytes = [0u8; 12];
    UnwrapErr(SysRng).fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let ct = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .map_err(|e| DbError::InvalidInput(format!("v2 vault encrypt failed: {e}")))?;
    Ok(format!("{}:{}", hex::encode(nonce_bytes), hex::encode(ct)))
}

fn collect_referenced_project_ids(out: &ParsedV1Home) -> Vec<String> {
    let mut ids = Vec::new();
    for pid in out
        .boards
        .iter()
        .map(|b| &b.project_id)
        .chain(out.goals.iter().map(|g| &g.project_id))
        .chain(out.tasks.iter().map(|t| &t.project_id))
        .chain(out.memories.iter().map(|m| &m.project_id))
        .chain(out.findings.iter().map(|f| &f.project_id))
        .chain(out.usage_events.iter().map(|u| &u.project_id))
    {
        if !ids.contains(pid) {
            ids.push(pid.clone());
        }
    }
    ids
}

fn collect_evidence_readonly(
    ev_root: &Path,
    dir: &Path,
    out: &mut Vec<EvidenceCopyItem>,
    warnings: &mut Vec<String>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let md = fs::symlink_metadata(&path)?;
        if md.file_type().is_symlink() {
            warnings.push(format!(
                "rejected symlink escape in evidence/: {}",
                path.display()
            ));
            continue;
        }
        if md.is_dir() {
            collect_evidence_readonly(ev_root, &path, out, warnings)?;
        } else if md.is_file() {
            let rel = path
                .strip_prefix(ev_root)
                .map_err(|_| DbError::InvalidInput("evidence relative path error".into()))?
                .to_path_buf();
            validate_rel_path(&rel)?;
            out.push(EvidenceCopyItem {
                src: path,
                rel_under_evidence: rel,
            });
        }
    }
    Ok(())
}

fn validate_rel_path(rel: &Path) -> Result<()> {
    if rel.as_os_str().is_empty() {
        return Err(DbError::InvalidInput("empty relative path".into()));
    }
    for c in rel.components() {
        match c {
            Component::Normal(_) => {}
            _ => {
                return Err(DbError::InvalidInput(format!(
                    "unsafe path traversal rejected: {}",
                    rel.display()
                )))
            }
        }
    }
    Ok(())
}

fn sanitize_slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "default".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn unique_slug(base: &str, seen: &mut HashSet<String>) -> String {
    if seen.insert(base.to_owned()) {
        return base.to_owned();
    }
    let mut n = 2usize;
    loop {
        let candidate = format!("{base}-{n}");
        if seen.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

fn non_empty_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn parse_leading_number(text: &str) -> f64 {
    let cleaned: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit() && *c != '-' && *c != '.')
        .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.')
        .collect();
    cleaned.parse::<f64>().unwrap_or(0.0)
}

fn parse_ts_ref(v: ValueRef<'_>, fallback_ms: i64) -> i64 {
    match v {
        ValueRef::Integer(n) => n,
        ValueRef::Real(r) => r as i64,
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .ok()
            .map(str::trim)
            .and_then(|s| {
                s.parse::<i64>().ok().or_else(|| {
                    chrono::DateTime::parse_from_rfc3339(s)
                        .ok()
                        .map(|dt| dt.timestamp_millis())
                })
            })
            .unwrap_or(fallback_ms),
        _ => fallback_ms,
    }
}

fn parse_any_ts_json(val: Option<&Value>, fallback_ms: i64) -> i64 {
    match val {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(fallback_ms),
        Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or_else(|_| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(fallback_ms)
        }),
        _ => fallback_ms,
    }
}

fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

fn is_regular_file(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
}

fn write_private_file(dest: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let tmp = dest.with_extension("tmp");
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        fs::rename(tmp, dest)?;
    }
    #[cfg(not(unix))]
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(dest)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    Ok(())
}
