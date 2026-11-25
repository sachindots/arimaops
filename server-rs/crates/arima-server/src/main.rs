// SPDX-License-Identifier: AGPL-3.0-or-later

use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use arima_auth::VaultKey;
use arima_db::{migrate_v1_data, Db, MigrateV1Options};
use arima_proxy::{normalize_preview_domain, normalize_strict_origin, EgressProxy, PreviewProxy, PreviewProxyConfig};
use arima_server::{router_with_state, AppState, ServerConfig};
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

fn default_data_root() -> PathBuf {
    if let Ok(explicit) = env::var("ARIMA_HOME") {
        let p = PathBuf::from(explicit);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".arima").join("v2")
}

fn load_or_create_bootstrap_token(data_root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let tok_path = data_root.join("dev-browser-token");
    if tok_path.is_file() {
        let existing = fs::read_to_string(&tok_path)?;
        let clean = existing.trim();
        if !clean.is_empty() {
            return Ok(clean.to_owned());
        }
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().to_string().replace('-', ""),
        uuid::Uuid::new_v4().to_string().replace('-', "")
    );
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tok_path)?;
        f.write_all(token.as_bytes())?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&tok_path, &token)?;
    }
    Ok(token)
}

fn handle_cli_subcommand() -> Result<bool, Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(first) = args.first().map(String::as_str) else {
        return Ok(false);
    };
    match first {
        "--version" | "-V" => {
            println!("arima-server {}", env!("CARGO_PKG_VERSION"));
            return Ok(true);
        }
        "migrate-v1" => {
            let mut from: Option<PathBuf> = None;
            let mut to: Option<PathBuf> = None;
            let mut master_key_file: Option<PathBuf> = None;
            let mut repos: Vec<PathBuf> = Vec::new();
            let mut dry_run = false;
            let mut json_out = false;
            let mut i = 1usize;
            while i < args.len() {
                match args[i].as_str() {
                    "--from" => {
                        i += 1;
                        let val = args.get(i).ok_or("--from requires a path")?;
                        from = Some(PathBuf::from(val));
                    }
                    "--to" => {
                        i += 1;
                        let val = args.get(i).ok_or("--to requires a path")?;
                        to = Some(PathBuf::from(val));
                    }
                    "--v1-master-key-file" => {
                        i += 1;
                        let val = args.get(i).ok_or("--v1-master-key-file requires a path")?;
                        master_key_file = Some(PathBuf::from(val));
                    }
                    "--repo" => {
                        i += 1;
                        let val = args.get(i).ok_or("--repo requires a path")?;
                        repos.push(PathBuf::from(val));
                    }
                    "--dry-run" => dry_run = true,
                    "--json" => json_out = true,
                    "--help" | "-h" => {
                        println!(
                            "Usage: arima-server migrate-v1 [--from <v1_home>] [--to <v2_home>] [--repo <path>]... [--v1-master-key-file <path>] [--dry-run] [--json]"
                        );
                        return Ok(true);
                    }
                    other => {
                        return Err(format!("unknown migrate-v1 flag '{other}'").into());
                    }
                }
                i += 1;
            }
            let v1_master_key = if let Some(key_file) = master_key_file {
                Some(fs::read_to_string(&key_file)?.trim().to_owned())
            } else {
                env::var("ARIMA_V1_MASTER_KEY")
                    .ok()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
            };
            let home = env::var("HOME").unwrap_or_else(|_| ".".into());
            let from_dir = from.unwrap_or_else(|| PathBuf::from(&home).join(".arima"));
            let to_dir = to.unwrap_or_else(|| PathBuf::from(&home).join(".arima").join("v2"));
            let report = migrate_v1_data(&MigrateV1Options {
                from: from_dir,
                to: to_dir,
                dry_run,
                v1_master_key,
                repos,
            })?;
            if json_out {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "ArimaOps v1 -> v2 migration ({}): projects={} templates={} boards={} goals={} tasks={} users={} memories={} findings={} usageEvents={} secretsImported={} secretsSkipped={} evidenceFiles={} vaultFound={} companyImported={} warnings={}",
                    if report.dry_run { "dry-run" } else { "applied" },
                    report.projects,
                    report.templates,
                    report.boards,
                    report.goals,
                    report.tasks,
                    report.users,
                    report.memories,
                    report.findings,
                    report.usage_events,
                    report.secrets_imported,
                    report.secrets_skipped.len(),
                    report.evidence_files,
                    report.vault_found,
                    report.company_imported,
                    report.warnings.len(),
                );
                for w in &report.warnings {
                    eprintln!("warning: {w}");
                }
            }
            return Ok(true);
        }
        _ => {}
    }
    Ok(false)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if handle_cli_subcommand()? {
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let port: u16 = env::var("HQ_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7420);
    let preview_port: u16 = env::var("HQ_PREVIEW_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(port + 1);
    let host = env::var("HQ_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let trust_proxy = env::var("HQ_TRUST_PROXY")
        .ok()
        .is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    let public_origin = env::var("HQ_PUBLIC_ORIGIN")
        .ok()
        .and_then(|v| normalize_strict_origin(&v));
    let preview_domain = env::var("HQ_PREVIEW_DOMAIN")
        .ok()
        .and_then(|v| normalize_preview_domain(&v));

    let data_root = default_data_root();
    fs::create_dir_all(&data_root)?;
    let db = Db::open(&data_root.join("arima.db"))?;
    let vault = VaultKey::load_or_create(Some(&data_root))?;
    let bootstrap_token = load_or_create_bootstrap_token(&data_root)?;

    let mut allowed_origins = Vec::new();
    if let Some(ref po) = public_origin {
        allowed_origins.push(po.clone());
    }

    let config = ServerConfig {
        port,
        preview_port,
        bootstrap_token: bootstrap_token.clone(),
        local_origins: vec![
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
            "http://127.0.0.1:5173".into(),
            "http://localhost:5173".into(),
        ],
        allowed_origins,
        preview_origin: None,
        trust_proxy,
        same_origin: false,
        data_root: Some(data_root.clone()),
        allow_private_connections: env::var("ARIMA_ALLOW_PRIVATE_CONNECTIONS").is_ok_and(|v| v == "1"),
    };

    let state = AppState::new(db, vault, config);
    state.configure_cloud_proxy(public_origin.clone(), preview_domain.clone());
    state.inner.runtime.refresh().await;
    let orphans = state.inner.runtime.reconcile().await;
    if orphans > 0 {
        tracing::info!(orphans, "removed agent containers left by a previous run");
    }
    {
        let rt = &state.inner.runtime.config;
        if rt.enabled {
            info!("agent runtime: on (image {}, network {}, workspaces {})", rt.image, rt.network, rt.workspaces_root.display());
        } else {
            info!("agent runtime: off (Docker socket not reachable; agents can't start)");
        }
    }
    let cwd = env::current_dir()?;
    let project_name = cwd
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo")
        .to_owned();
    let slug: String = project_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    state.ensure_default_project(&project_name, slug.trim_matches('-'), &cwd.display().to_string())?;
    arima_server::team::refresh_builtin_role_prompts(&state);
    let gc = arima_server::skills::gc_storage(&state, std::time::Duration::from_secs(10 * 60));
    if gc.total_removed() > 0 {
        info!(
            trees = gc.trees_removed,
            workspace_trees = gc.workspace_trees_removed,
            link_views = gc.link_views_removed,
            agent_views = gc.agent_views_removed,
            tmp = gc.tmp_removed,
            "boot skill/view GC pruned stale directories"
        );
    }

    let preview_addr: SocketAddr = format!("{host}:{preview_port}").parse()?;
    let default_hq_origin = public_origin
        .clone()
        .unwrap_or_else(|| format!("http://{host}:{port}"));
    let preview_secure = default_hq_origin.starts_with("https://");
    let _preview_handle = PreviewProxy::bind(
        preview_addr,
        state.inner.preview_registry.clone(),
        state.inner.preview_signer.clone(),
        PreviewProxyConfig {
            default_hq_origin,
            secure_cookies: preview_secure,
            trust_proxy,
        },
    )
    .await?;
    info!("ArimaOps v2 preview proxy listening on http://{preview_addr}");
    println!("ArimaOps v2 preview proxy listening on http://{preview_addr}");

    // Agents reach the internet through this proxy (observe mode); each one is named by its own credential.
    let _egress_handle = if state.inner.runtime.config.enabled {
        let egress_addr: SocketAddr = format!("{host}:{}", state.inner.runtime.config.egress_port).parse()?;
        let handle = EgressProxy::start(
            egress_addr,
            state.inner.egress.credentials.clone(),
            std::sync::Arc::new(arima_server::egress::ProxyPolicy(state.clone())),
        )
        .await
        .map_err(|e| format!("couldn't start the agent egress proxy on {egress_addr} (set HQ_EGRESS_PORT to move it): {e}"))?;
        info!("agent egress proxy listening on {}", handle.addr());
        Some(handle)
    } else {
        None
    };

    let _backup_scheduler = arima_server::backups::spawn_nightly_backup_scheduler(state.clone());

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!("ArimaOps v2 listening on http://{addr}/?token={bootstrap_token}");
    println!("ArimaOps v2 listening on http://{addr}/?token={bootstrap_token}");

    let app = router_with_state(state).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, app).await?;
    Ok(())
}
