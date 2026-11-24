// SPDX-License-Identifier: AGPL-3.0-or-later

//! The agent runtime: runs each agent's CLI in its own container with a TTY, keeps the terminal's scrollback,
//! and streams its output to every connected client as `terminal.output` events.
//!
//! Container mode only. HQ reaches Docker through its Unix socket (see `arima_agents::DockerEngine`), so mounting
//! that socket into HQ is what turns the runtime on. Without it every start answers with a plain error.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use arima_agents::{DockerEngine, DEFAULT_CONTAINER_CPUS, DEFAULT_CONTAINER_MEMORY_MB};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;

use crate::cli::McpServer;
use crate::state::AppState;

const SCROLLBACK_BYTES: usize = 256 * 1024;
const DEFAULT_IMAGE: &str = "ghcr.io/sachindots/arimaops-agent:latest";
const DEFAULT_NETWORK: &str = "arima-agents";
/// Approved skills as agents get them, under the workspaces root but outside every agent's own folder.
const SKILLS_FOLDER: &str = ".arima-skills";
/// What the agent CLIs read as a plugin's root: the Claude Code name, and the name Codex documents for plugin hooks.
const PLUGIN_ROOT_ENV: [&str; 2] = ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"];

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub enabled: bool,
    pub image: String,
    pub network: String,
    /// Where HQ itself sees the workspaces folder.
    pub workspaces_root: PathBuf,
    /// The same folder as the Docker daemon sees it (differs when HQ runs in a container).
    pub workspaces_host_root: PathBuf,
    /// HQ's address as agents reach it, for their MCP tools. Unset means agents get no HQ tools.
    pub hq_url: Option<String>,
    /// The port of HQ's egress proxy, on the same host as `hq_url`.
    pub egress_port: u16,
    /// HQ's own container (its id prefix, which Docker uses as the hostname) when HQ runs in one. Enforce mode
    /// attaches it to the agents' internal network, so it is their only way out.
    pub hq_container: Option<String>,
}

/// `HQ_EGRESS_PORT`, or HQ's port + 1000 (8420 by default).
#[must_use]
pub fn egress_port() -> u16 {
    let env_port = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u16>().ok());
    env_port("HQ_EGRESS_PORT").unwrap_or_else(|| env_port("HQ_PORT").unwrap_or(7420).saturating_add(1000))
}

impl RuntimeConfig {
    #[must_use]
    pub fn from_env(data_root: Option<&std::path::Path>) -> Self {
        let socket = std::env::var("DOCKER_HOST").ok().and_then(|h| h.strip_prefix("unix://").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from(arima_agents::engine::DEFAULT_SOCKET));
        let off = std::env::var("ARIMA_AGENT_RUNTIME").is_ok_and(|v| v == "off");
        let root = std::env::var("ARIMA_WORKSPACES_ROOT").map(PathBuf::from).unwrap_or_else(|_| {
            if PathBuf::from("/workspaces").is_dir() { PathBuf::from("/workspaces") } else { data_root.map_or_else(|| PathBuf::from("workspaces"), |d| d.join("workspaces")) }
        });
        let nonempty = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
            enabled: !off && socket.exists(),
            image: nonempty("ARIMA_AGENT_IMAGE").unwrap_or_else(|| DEFAULT_IMAGE.into()),
            network: nonempty("ARIMA_AGENT_NETWORK").unwrap_or_else(|| DEFAULT_NETWORK.into()),
            workspaces_host_root: std::env::var("ARIMA_WORKSPACES_HOST_ROOT").map_or_else(|_| root.clone(), PathBuf::from),
            workspaces_root: root,
            hq_url: nonempty("ARIMA_AGENT_HQ_URL"),
            egress_port: egress_port(),
            hq_container: std::path::Path::new("/.dockerenv").exists().then(|| std::fs::read_to_string("/etc/hostname").ok()).flatten().map(|h| h.trim().to_owned()).filter(|h| !h.is_empty()),
        }
    }

    /// The network a project's enforce-mode agents start on: internal, so HQ (attached to it too) is their only way
    /// out, and one per project, so agents of different projects can't reach each other. Named from HQ's network
    /// and the project's slug in Docker's name characters; a name over 63 characters is cut and ends in a hash of
    /// the whole, so it stays the same for the project and distinct from other projects'.
    #[must_use]
    pub fn internal_network(&self, slug: &str) -> String {
        use sha2::{Digest, Sha256};
        let name: String = format!("{}-internal-{slug}", self.network).chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '-' }).collect();
        if name.len() <= 63 {
            return name;
        }
        format!("{}-{}", &name[..54], hex::encode(&Sha256::digest(name.as_bytes())[..4]))
    }

    /// HQ's container and the host name agents use for it, which enforce mode needs to put HQ on their network.
    fn enforce_hq(&self) -> Result<(String, String), String> {
        let container = self.hq_container.clone().ok_or(
            "Enforce mode needs HQ to run in a container, so it can be the agents' only way out. Switch this project to observe in Settings, or run HQ with the compose files.",
        )?;
        let host = self.hq_url.as_deref().and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(str::to_owned));
        let host = host.filter(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_err()).ok_or(
            "Enforce mode needs ARIMA_AGENT_HQ_URL to name HQ by host name (as in http://arima-hq:7420), so agents find it on their internal network.",
        )?;
        Ok((container, host))
    }
}

struct Session {
    container: String,
    writer: tokio::sync::Mutex<OwnedWriteHalf>,
    scrollback: Mutex<Vec<u8>>,
    workspace: String,
}

/// What the last Docker check found; the setup checklist reads this instead of probing on every snapshot.
#[derive(Clone, Default)]
pub struct RuntimeStatus {
    pub docker_ok: bool,
    pub docker_detail: String,
    pub image_ok: bool,
    pub image_detail: String,
}

struct StartGuard {
    set: Arc<Mutex<std::collections::HashSet<(String, String)>>>,
    key: (String, String),
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.key);
        }
    }
}

pub struct AgentRuntime {
    pub config: RuntimeConfig,
    engine: DockerEngine,
    sessions: Mutex<HashMap<(String, String), Arc<Session>>>,
    /// Agents whose container is being created; a second Start while one is in flight is a no-op.
    starting: Arc<Mutex<std::collections::HashSet<(String, String)>>>,
    status: Mutex<RuntimeStatus>,
}

/// Rewrites only HQ's marked section of the role file, so notes an agent or the owner adds outside it survive.
/// A file without the markers is HQ's own output from before they existed and is replaced whole.
#[must_use]
pub fn refresh_role(existing: Option<&str>, role: &str) -> String {
    const START: &str = "<!-- arimaops:role:start (ArimaOps rewrites this section on every start: edit the role in ArimaOps) -->";
    const END: &str = "<!-- arimaops:role:end -->";
    let block = format!("{START}\n{role}\n{END}\n");
    let Some(text) = existing else { return block };
    match (text.find(START), text.find(END)) {
        (Some(a), Some(b)) if a < b => format!("{}{block}{}", &text[..a], text[b + END.len()..].trim_start_matches('\n')),
        _ => block,
    }
}

/// Pre-creates a bind mount's target directory inside the agent's workspace so HQ (the container's non-root user)
/// owns every intermediate folder (such as `.claude/` or `.agents/`) instead of Docker creating them as `root:root`.
fn ensure_mountpoint(workspace_dir: &Path, container_path: &str) -> Result<(), String> {
    let Some(rel) = container_path.strip_prefix("/workspace/") else { return Ok(()) };
    let host = workspace_dir.join(rel);
    match std::fs::create_dir_all(&host) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && host.is_dir() => Ok(()),
        Err(e) => Err(format!("couldn't prepare mount point {container_path}: {e}")),
    }
}

/// Some MCP files hold the agent's HQ token, so only the owner (HQ's user, which is also the container's user) can read them.
fn write_private(path: &std::path::Path, body: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path).map_err(|e| e.to_string())?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    file.write_all(body.as_bytes()).map_err(|e| e.to_string())
}

pub(crate) fn vault_secret(state: &AppState, id: &str) -> Result<Option<String>, String> {
    let Some(row) = state.inner.vault_secrets.get_by_id(id).map_err(|e| e.to_string())? else { return Ok(None) };
    let secret = state.inner.auth.vault().decrypt(format!("vault-secret:{id}").as_bytes(), &row.secret_enc).map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&secret).into_owned()))
}

/// HQ's own server at `base`, then the project's servers this agent was given in Settings, each reached through
/// HQ at `base/{name}` (HQ attaches its key). One that is gone is skipped, so a stale selection never stops a start.
fn hq_servers(state: &AppState, project_id: &str, agent: &Value, base: &str) -> Vec<McpServer> {
    let registry = crate::integrations::tool_servers(state, project_id);
    let agent_id = agent["id"].as_str().unwrap_or("");
    let selected = agent["mcp"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|name| {
        let Some(entry) = registry.iter().find(|s| s.name == *name).filter(|_| *name != "arima") else {
            tracing::warn!(agent = agent_id, server = name, "skipping an MCP server that isn't registered");
            return false;
        };
        if let Some(why) = &entry.blocked {
            tracing::warn!(agent = agent_id, server = name, "skipping a blocked MCP server: {why}");
            return false;
        }
        true
    });
    std::iter::once(McpServer::Http { name: "arima".to_owned(), url: base.to_owned() })
        .chain(selected.map(|name| McpServer::Http { name: name.to_owned(), url: format!("{base}/{name}") }))
        .collect()
}

impl AgentRuntime {
    #[must_use]
    pub fn new(config: RuntimeConfig) -> Self {
        Self { config, engine: DockerEngine::from_env(), sessions: Mutex::new(HashMap::new()), starting: Arc::default(), status: Mutex::new(RuntimeStatus::default()) }
    }

    fn key(project_id: &str, agent_id: &str) -> (String, String) {
        (project_id.to_owned(), agent_id.to_owned())
    }

    fn session(&self, project_id: &str, agent_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().ok()?.get(&Self::key(project_id, agent_id)).cloned()
    }

    #[must_use]
    pub fn is_running(&self, project_id: &str, agent_id: &str) -> bool {
        self.session(project_id, agent_id).is_some()
    }

    /// `AgentStatus.session` for the snapshot.
    #[must_use]
    pub fn session_info(&self, project_id: &str, agent_id: &str) -> Value {
        self.session(project_id, agent_id).map_or_else(
            || json!({ "state": "stopped", "detail": null, "workspace": null, "sandbox": null }),
            |s| json!({ "state": "running", "detail": null, "workspace": s.workspace, "sandbox": null }),
        )
    }

    /// Every running agent's recent terminal output, for a client that just connected.
    #[must_use]
    pub fn scrollbacks(&self, project_id: &str) -> Vec<(String, String)> {
        let Ok(map) = self.sessions.lock() else { return Vec::new() };
        map.iter()
            .filter(|((p, _), _)| p == project_id)
            .filter_map(|((_, agent), s)| {
                let bytes = s.scrollback.lock().ok()?.clone();
                (!bytes.is_empty()).then(|| (agent.clone(), String::from_utf8_lossy(&bytes).into_owned()))
            })
            .collect()
    }

    #[must_use]
    pub fn status(&self) -> RuntimeStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Probes Docker and the agent image and remembers the answer for the setup checklist.
    pub async fn refresh(&self) {
        let next = if !self.config.enabled {
            RuntimeStatus {
                docker_detail: "HQ can't reach Docker. Mount /var/run/docker.sock into the HQ container (compose.runtime.yaml) and restart it.".into(),
                image_detail: "Needs Docker first.".into(),
                ..RuntimeStatus::default()
            }
        } else {
            match self.engine.ping().await {
                Err(e) => RuntimeStatus { docker_detail: format!("Docker didn't answer: {e}"), image_detail: "Needs Docker first.".into(), ..RuntimeStatus::default() },
                Ok(()) => {
                    let image = self.engine.image_present(&self.config.image).await.unwrap_or(false);
                    RuntimeStatus {
                        docker_ok: true,
                        docker_detail: "Docker is reachable.".into(),
                        image_ok: image,
                        image_detail: if image { format!("{} is on this machine.", self.config.image) } else { format!("{} is pulled on the first Start (a few hundred MB).", self.config.image) },
                    }
                }
            }
        };
        if let Ok(mut st) = self.status.lock() {
            *st = next;
        }
    }

    pub async fn send_input(&self, project_id: &str, agent_id: &str, data: &str) -> Result<(), String> {
        let session = self.session(project_id, agent_id).ok_or("That agent isn't running.")?;
        let mut writer = session.writer.lock().await;
        writer.write_all(data.as_bytes()).await.map_err(|e| e.to_string())
    }

    pub async fn resize(&self, project_id: &str, agent_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(project_id, agent_id).ok_or("That agent isn't running.")?;
        self.engine.resize(&session.container, cols.clamp(20, 500), rows.clamp(5, 200)).await.map_err(|e| e.to_string())
    }

    /// Removes this HQ's agent containers (labelled with its workspaces root, so another HQ on the same Docker host is untouched) left by a previous process: this process has no session for them, so nothing
    /// could stop them or read their terminal. Call once at boot, before any Start.
    pub async fn reconcile(&self) -> usize {
        if !self.config.enabled {
            return 0;
        }
        let Ok(ids) = self.engine.ids_with_label(&format!("arimaops.hq={}", self.config.workspaces_root.display())).await else { return 0 };
        let mut removed = 0;
        for id in ids {
            removed += usize::from(self.engine.remove(&id).await.is_ok());
        }
        removed
    }

    /// Stops every running agent of a project and removes its internal network (used when the project is deleted).
    pub async fn stop_project(&self, state: &AppState, project_id: &str) {
        let agents: Vec<String> = self.sessions.lock().map(|m| m.keys().filter(|(p, _)| p == project_id).map(|(_, a)| a.clone()).collect()).unwrap_or_default();
        for agent in agents {
            let _ = self.stop(state, project_id, &agent).await;
        }
        self.release_network(state, project_id, true).await;
    }

    fn project_network(&self, state: &AppState, project_id: &str) -> String {
        self.config.internal_network(&crate::team::project_slug(state, project_id).unwrap_or_else(|| project_id.to_owned()))
    }

    /// The network an agent starts on: its project's internal one with HQ attached under `alias` in enforce mode.
    async fn prepare_network(&self, state: &AppState, project_id: &str, enforce: Option<&(String, String)>) -> Result<(), String> {
        let Some((hq, alias)) = enforce else {
            return self.engine.ensure_network(&self.config.network, false).await.map_err(|e| e.to_string());
        };
        let net = self.project_network(state, project_id);
        self.engine.ensure_network(&net, true).await.map_err(|e| e.to_string())?;
        self.engine.connect_network(&net, hq, std::slice::from_ref(alias)).await.map_err(|e| format!("couldn't put HQ on the agents' internal network: {e}"))
    }

    /// Takes HQ off a project's internal network and removes it, once none of the project's agents runs or is
    /// starting and the project has left enforce mode (or, with `deleted`, is going away). Best effort: a network
    /// that is already gone or still has containers on it is left as it is.
    pub async fn release_network(&self, state: &AppState, project_id: &str, deleted: bool) {
        let busy = self.sessions.lock().map_or(true, |m| m.keys().any(|(p, _)| p == project_id)) || self.starting.lock().map_or(true, |s| s.iter().any(|(p, _)| p == project_id));
        if !self.config.enabled || busy || (!deleted && crate::egress::mode(state, project_id) == crate::egress::EgressMode::Enforce) {
            return;
        }
        let net = self.project_network(state, project_id);
        if let Some(hq) = &self.config.hq_container {
            let _ = self.engine.disconnect_network(&net, hq).await;
        }
        let _ = self.engine.remove_network(&net).await;
    }

    pub async fn stop(&self, state: &AppState, project_id: &str, agent_id: &str) -> Result<(), String> {
        let name = format!("hq-{}-{agent_id}", crate::team::project_slug(state, project_id).unwrap_or_else(|| project_id.to_owned()));
        let session = self.sessions.lock().ok().and_then(|mut m| m.remove(&Self::key(project_id, agent_id)));
        state.inner.mcp.revoke_agent_token(project_id, agent_id);
        state.inner.egress.revoke(project_id, agent_id);
        let target = session.as_ref().map_or(name, |s| s.container.clone());
        let stopped = match self.engine.stop(&target, 10).await {
            Ok(()) => self.engine.remove(&target).await,
            Err(e) => Err(e),
        };
        self.release_network(state, project_id, false).await;
        stopped.map_err(|e| e.to_string())
    }

    /// Starts an agent's container and begins streaming its terminal. A running agent is left as it is.
    pub async fn start(&self, state: &AppState, project_id: &str, agent_id: &str) -> Result<(), String> {
        if self.is_running(project_id, agent_id) {
            return Ok(());
        }
        let key = Self::key(project_id, agent_id);
        if !self.starting.lock().is_ok_and(|mut set| set.insert(key.clone())) {
            return Ok(());
        }
        let _release = StartGuard { set: self.starting.clone(), key };
        if !self.config.enabled {
            return Err("Agents can't start here: Docker isn't available to HQ. Mount the Docker socket into HQ to turn the agent runtime on.".into());
        }
        self.engine.ping().await.map_err(|e| e.to_string())?;
        let plan = self.plan(state, project_id, agent_id)?;
        self.prepare_network(state, project_id, plan.enforce.as_ref()).await?;
        self.engine.ensure_image(&self.config.image).await.map_err(|e| e.to_string())?;
        let _ = self.engine.remove(&plan.container).await;
        let id = self.engine.create_container(&plan.container, &plan.body).await.map_err(|e| e.to_string())?;
        if let Err(e) = self.engine.start(&id).await {
            let _ = self.engine.remove(&id).await;
            return Err(e.to_string());
        }
        let stream = match self.engine.attach(&id).await {
            Ok(s) => s,
            Err(e) => {
                let _ = self.engine.remove(&id).await;
                return Err(e.to_string());
            }
        };
        let _ = self.engine.resize(&id, 120, 32).await;
        let (mut reader, writer) = stream.into_split();
        let session = Arc::new(Session { container: id.clone(), writer: tokio::sync::Mutex::new(writer), scrollback: Mutex::new(Vec::new()), workspace: plan.workspace_host });
        if let Ok(mut map) = self.sessions.lock() {
            map.insert(Self::key(project_id, agent_id), session.clone());
        }
        let (state, project, agent) = (state.clone(), project_id.to_owned(), agent_id.to_owned());
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                let n = match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if let Ok(mut sb) = session.scrollback.lock() {
                    sb.extend_from_slice(&buf[..n]);
                    let over = sb.len().saturating_sub(SCROLLBACK_BYTES);
                    if over > 0 {
                        sb.drain(..over);
                    }
                }
                let event = json!({ "type": "terminal.output", "projectId": project, "agentId": agent, "data": String::from_utf8_lossy(&buf[..n]) });
                state.inner.ws_hub.broadcast_project_streams(&project, &event.to_string());
            }
            state.inner.runtime.finished(&state, &project, &agent, &session).await;
        });
        Ok(())
    }

    /// The agent's terminal closed: clean up and tell everyone it stopped, unless a stop already did.
    async fn finished(&self, state: &AppState, project_id: &str, agent_id: &str, session: &Arc<Session>) {
        let still_ours = self.sessions.lock().ok().is_some_and(|mut m| {
            let ours = m.get(&Self::key(project_id, agent_id)).is_some_and(|s| Arc::ptr_eq(s, session));
            if ours {
                m.remove(&Self::key(project_id, agent_id));
            }
            ours
        });
        if still_ours {
            let exit = self.engine.inspect(&session.container).await.ok().flatten().map_or(0, |c| c.exit_code);
            let _ = self.engine.remove(&session.container).await;
            self.release_network(state, project_id, false).await;
            state.inner.mcp.revoke_agent_token(project_id, agent_id);
            state.inner.egress.revoke(project_id, agent_id);
            let _ = state.inner.supervisor.stop_agent(project_id, agent_id).await;
            let note = if exit == 0 { "Session ended".to_owned() } else { format!("Session ended with exit code {exit}") };
            let event = json!({ "type": "agent-status", "projectId": project_id, "agentId": agent_id, "state": "idle", "note": note });
            state.inner.ws_hub.broadcast_project(project_id, &event.to_string());
        }
        let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
        state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
    }

    pub(crate) fn plan(&self, state: &AppState, project_id: &str, agent_id: &str) -> Result<Plan, String> {
        let model = crate::team::load(state, project_id).ok_or("This project has no team yet. Pick a team first.")?;
        let agent = model.team.iter().find(|a| a["id"] == agent_id).ok_or_else(|| format!("No agent \"{agent_id}\"."))?;
        let mode = agent["mode"].as_str().unwrap_or("local");
        if mode != "container" {
            return Err(format!("{} runs in {mode} mode. Agents run in container mode in this HQ build: switch the team's mode in Settings → Sandbox.", agent["name"].as_str().unwrap_or(agent_id)));
        }
        let cli = agent["cli"].as_str().unwrap_or("");
        let adapter = crate::cli::adapter(cli).ok_or_else(|| format!("HQ doesn't know how to launch \"{cli}\"."))?;
        let (program, mut args) = adapter.launch_args(&agent["model"]);

        let slug = crate::team::project_slug(state, project_id).unwrap_or_else(|| project_id.to_owned());
        let dir = self.config.workspaces_root.join(&slug).join(agent_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create the agent's folder: {e}"))?;
        let name = agent["name"].as_str().unwrap_or(agent_id);
        let role_path = dir.join(adapter.role_file);
        let role = format!("# {name}, {}\n\n{}", agent["role"].as_str().unwrap_or("agent"), agent["roleMd"].as_str().unwrap_or(""));
        let body = refresh_role(std::fs::read_to_string(&role_path).ok().as_deref(), &role);
        std::fs::write(&role_path, body).map_err(|e| e.to_string())?;

        // Without HQ's address the agent can reach neither HQ's server nor the ones HQ forwards to.
        let (servers, token) = match &self.config.hq_url {
            Some(url) => {
                let project_url = format!("{}/api/projects/{project_id}", url.trim_end_matches('/'));
                // Tools as code: one server, the codemode runner in the container, in place of every other.
                let servers = if crate::codemode::enabled(state, project_id) {
                    vec![McpServer::Codemode { project_url }]
                } else {
                    hq_servers(state, project_id, agent, &format!("{project_url}/mcp"))
                };
                (servers, Some(state.inner.mcp.issue_agent_token(project_id, agent_id)))
            }
            None => (Vec::new(), None),
        };
        let mcp = (adapter.mcp)(&servers, token.as_deref().unwrap_or(""));
        if let Some((path, cfg)) = &mcp.file {
            write_private(&dir.join(path), &serde_json::to_string_pretty(cfg).unwrap_or_default())?;
        }
        args.extend(mcp.args);
        arima_agents::docker::validate_launch(&program, &args).map_err(|e| e.to_string())?;

        let mut env: HashMap<String, String> = crate::secrets::env_for(state, project_id, agent_id);
        env.extend([("TERM".to_owned(), "xterm-256color".to_owned()), ("HOME".to_owned(), crate::cli::AGENT_HOME.to_owned())]);
        env.extend(mcp.env);
        env.extend(token.map(|t| (crate::cli::TOKEN_ENV.to_owned(), t)));
        if let Some(account) = agent["account"].as_str().filter(|a| !a.is_empty()) {
            let row = state.inner.vault_secrets.get_by_id(&format!("acct-{account}")).ok().flatten().ok_or_else(|| format!("The account \"{account}\" this agent uses doesn't exist."))?;
            let secret = state.inner.auth.vault().decrypt(format!("vault-secret:{}", row.id).as_bytes(), &row.secret_enc).map_err(|e| e.to_string())?;
            for var in adapter.provider_env(&row.provider) {
                env.insert((*var).to_owned(), String::from_utf8_lossy(&secret).into_owned());
            }
        }
        let container = format!("hq-{slug}-{agent_id}");
        let egress = crate::egress::mode(state, project_id);
        // Read at each start, so a mode change reaches an agent at its next start.
        let enforce = if egress == crate::egress::EgressMode::Enforce { Some(self.config.enforce_hq()?) } else { None };
        // Without an HQ address agents can't reach the proxy either, so they keep going straight out.
        if let Some(hq) = self.config.hq_url.as_deref().filter(|_| egress != crate::egress::EgressMode::Off) {
            let policy = crate::egress::policy(egress, adapter.egress, &crate::egress::project_rules(state, project_id), agent);
            let token = state.inner.egress.admit(project_id, agent_id, &container, policy);
            env.extend(crate::egress::proxy_env(hq, self.config.egress_port, agent_id, &token));
        }
        std::fs::create_dir_all(dir.join(".agent-home")).map_err(|e| e.to_string())?;
        let (uid, gid) = {
            use std::os::unix::fs::MetadataExt;
            let md = std::fs::metadata(&dir).map_err(|e| e.to_string())?;
            (md.uid(), md.gid())
        };
        let res = &agent["sandbox"]["resources"];
        let cpus = res["cpus"].as_f64().filter(|c| *c >= 1.0).unwrap_or(f64::from(DEFAULT_CONTAINER_CPUS));
        let memory_mb = res["memoryGb"].as_f64().filter(|m| *m >= 0.5).map_or(u64::from(DEFAULT_CONTAINER_MEMORY_MB), |g| (g * 1024.0).round() as u64);
        let workspace_host = self.config.workspaces_host_root.join(&slug).join(agent_id).display().to_string();
        let mut binds = vec![format!("{workspace_host}:/workspace:rw")];
        // Copied outside every agent's /workspace and mounted read-only, so an agent can't edit a skill it was given.
        // Each skill in the CLI's skills_dir is a symlink inside a read-only view directory pointing into the
        // read-only mounted plugin tree (or standalone skill mount), so relative paths like `../../resources/...`
        // resolve physically inside the plugin while keeping both the plugin and the skills_dir read-only.
        if let Some(skills_dir) = adapter.skills_dir {
            let role_id = agent["roleId"].as_str().unwrap_or_default();
            let mut plugin_roots = BTreeSet::new();
            let mut standalone_mounted = BTreeSet::new();
            let mut links = BTreeMap::new();
            for skill in crate::skills::approved_skills(state, project_id, role_id) {
                let Some(plugin) = &skill.plugin else {
                    if let std::collections::btree_map::Entry::Vacant(e) = links.entry(skill.name.clone()) {
                        crate::skills::store(&self.config.workspaces_root.join(SKILLS_FOLDER), &skill.hash, &skill.name, &skill.files)?;
                        let host = self.config.workspaces_host_root.join(SKILLS_FOLDER).join(&skill.hash).join(&skill.name);
                        let target = format!("{}/.arima/skills/{}", crate::cli::AGENT_HOME, skill.name);
                        if standalone_mounted.insert(skill.name) {
                            ensure_mountpoint(&dir, &target)?;
                            binds.push(format!("{}:{target}:ro", host.display()));
                        }
                        e.insert(target);
                    }
                    continue;
                };
                let tree = self.config.workspaces_host_root.join(SKILLS_FOLDER).join(&skill.hash).join(crate::packs::STORED_PLUGIN);
                let root = format!("{}/{}", crate::cli::AGENT_HOME, plugin.dir);
                if plugin_roots.insert(root.clone()) {
                    crate::skills::store(&self.config.workspaces_root.join(SKILLS_FOLDER), &skill.hash, crate::packs::STORED_PLUGIN, &skill.files)?;
                    ensure_mountpoint(&dir, &root)?;
                    binds.push(format!("{}:{root}:ro", tree.display()));
                }
                links.entry(skill.name).or_insert_with(|| format!("{root}/{}", plugin.skill));
            }
            if !links.is_empty() {
                let view_hash = crate::skills::store_links(&self.config.workspaces_root.join(SKILLS_FOLDER), &links)?;
                let view_host = self.config.workspaces_host_root.join(SKILLS_FOLDER).join("views").join(&view_hash);
                ensure_mountpoint(&dir, skills_dir)?;
                binds.push(format!("{}:{skills_dir}:ro", view_host.display()));
            }
            // One variable can name one plugin: with several, each skill's plugin is still at its own path.
            if let [root] = Vec::from_iter(plugin_roots).as_slice() {
                env.extend(PLUGIN_ROOT_ENV.map(|k| (k.to_owned(), root.clone())));
            }
        }
        let mut env_list: Vec<String> = env.into_iter().map(|(k, v)| format!("{k}={v}")).collect();
        env_list.sort();
        let body = json!({
            "Image": self.config.image,
            "Entrypoint": [program],
            "Cmd": args,
            "Env": env_list,
            "Tty": true, "OpenStdin": true, "StdinOnce": false,
            "WorkingDir": "/workspace",
            "User": format!("{uid}:{gid}"),
            "Labels": { "arimaops.project": project_id, "arimaops.agent": agent_id, "arimaops.hq": self.config.workspaces_root.display().to_string() },
            "HostConfig": {
                "Binds": binds,
                "NanoCpus": (cpus * 1e9).round() as i64,
                "Memory": memory_mb * 1024 * 1024,
                "PidsLimit": 512,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges"],
                "Tmpfs": { "/tmp": "rw,nosuid,size=256m" },
                "NetworkMode": if enforce.is_some() { self.config.internal_network(&slug) } else { self.config.network.clone() },
                "Init": true,
                "RestartPolicy": { "Name": "no" }
            }
        });
        Ok(Plan { container, body, workspace_host, enforce })
    }
}

pub(crate) struct Plan {
    container: String,
    /// HQ's container and its name for agents, when the agent starts on the internal network.
    enforce: Option<(String, String)>,
    pub(crate) body: Value,
    workspace_host: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_role_section_is_rewritten_and_the_rest_of_the_file_kept() {
        let first = refresh_role(None, "# Ada, lead\n\nOld role");
        assert!(first.contains("Old role"));
        let edited = format!("Notes above\n{first}My own notes\n");
        let next = refresh_role(Some(&edited), "# Ada, lead\n\nNew role");
        assert!(next.starts_with("Notes above\n") && next.ends_with("My own notes\n"), "{next}");
        assert!(next.contains("New role") && !next.contains("Old role"), "{next}");
        assert_eq!(refresh_role(Some(&next), "# Ada, lead\n\nNew role"), next, "rewriting is idempotent");
        assert_eq!(refresh_role(Some("# Ada, lead\n\nOld role from before markers\n"), "R"), refresh_role(None, "R"), "a file without markers is HQ's old output");
    }

    #[test]
    fn a_start_applies_the_selected_servers_and_the_current_role() {
        use crate::{integrations as int, team, team_edit as edit};
        let root = tempfile::TempDir::new().unwrap();
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([7u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
        let pid = state.default_project().unwrap().0;
        team::complete_welcome(&state, &pid, &[json!({ "templateId": "dev" })]).unwrap();
        edit::set_team_mode(&state, &pid, &[json!("container")]).unwrap();
        int::add_mcp(&state, &pid, &[json!({ "name": "docs", "url": "https://docs.example/mcp", "apiKey": "docs-key-1" })]).unwrap();
        int::add_mcp(&state, &pid, &[json!({ "name": "open-web", "url": "https://web.example/mcp" })]).unwrap();
        let agent = team::load(&state, &pid).unwrap().team[0].clone();
        let (id, role_id) = (agent["id"].as_str().unwrap().to_owned(), agent["roleId"].as_str().unwrap_or("lead").to_owned());
        edit::edit_seat(&state, &pid, &id, |seat| {
            seat["mcp"] = json!(["docs", "removed-later", "open-web"]);
            Ok(())
        })
        .unwrap();
        edit::update_role(&state, &pid, &[json!(role_id), json!({ "cli": "claude", "roleMd": "First role text" })]).unwrap();

        let rt = AgentRuntime::new(RuntimeConfig {
            enabled: true,
            image: "img".into(),
            network: "net".into(),
            workspaces_root: root.path().into(),
            workspaces_host_root: root.path().into(),
            hq_url: Some("http://hq:7420/".into()),
            egress_port: 8420,
            hq_container: None,
        });
        let plan = rt.plan(&state, &pid, &id).unwrap();
        let dir = root.path().join("demo").join(&id);
        let cfg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        let names: Vec<&String> = cfg["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(names, ["arima", "docs", "open-web"], "HQ's server plus the selected ones; the unknown id is skipped");
        assert_eq!(cfg["mcpServers"]["docs"], json!({ "type": "http", "url": format!("http://hq:7420/api/projects/{pid}/mcp/docs"), "headers": { "Authorization": "Bearer ${ARIMA_MCP_TOKEN}" } }));
        let env: Vec<&str> = plan.body["Env"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(env.iter().any(|e| e.starts_with("ARIMA_MCP_TOKEN=mcp_")), "{env:?}");
        let proxy = env.iter().find_map(|e| e.strip_prefix("HTTPS_PROXY=")).expect("observe mode sets the proxy");
        let token = proxy.strip_prefix(&format!("http://{id}:")).and_then(|t| t.strip_suffix("@hq:8420")).expect(proxy);
        assert!(state.inner.egress.credentials.identify(&id, token).is_some(), "the credential in the URL names this agent");
        assert!(env.contains(&"NODE_USE_ENV_PROXY=1") && env.iter().any(|e| e.starts_with("NO_PROXY=") && e.split([',', '=']).any(|h| h == "hq")), "{env:?}");
        assert_eq!(plan.body["HostConfig"]["NetworkMode"], "net", "observe keeps the agent on HQ's normal network");
        assert!(state.inner.egress.policy(&pid, &id).unwrap().observe);

        crate::egress::set_mode(&state, &pid, &[json!("enforce")]).unwrap();
        let err = rt.plan(&state, &pid, &id).err().unwrap();
        assert!(err.contains("container"), "HQ on the host can't be the only way out, so enforce refuses to start: {err}");
        let mut in_container = rt.config.clone();
        in_container.hq_container = Some("0123abcd".into());
        let rt = AgentRuntime::new(in_container);
        let enforced = rt.plan(&state, &pid, &id).unwrap();
        assert_eq!(enforced.body["HostConfig"]["NetworkMode"], "net-internal-demo");
        assert_eq!(enforced.enforce, Some(("0123abcd".to_owned(), "hq".to_owned())), "HQ joins under the name agents use for it");
        assert!(!state.inner.egress.policy(&pid, &id).unwrap().observe, "the proxy refuses for this agent");
        crate::egress::set_mode(&state, &pid, &[json!("observe")]).unwrap();
        assert!(!state.inner.egress.policy(&pid, &id).unwrap().observe, "a running agent keeps its start's mode");
        let back = rt.plan(&state, &pid, &id).unwrap();
        assert_eq!((back.body["HostConfig"]["NetworkMode"].clone(), back.enforce), (json!("net"), None), "the next start applies the switch");

        crate::egress::set_mode(&state, &pid, &[json!("off")]).unwrap();
        let off = rt.plan(&state, &pid, &id).unwrap();
        assert!(!off.body["Env"].to_string().contains("PROXY"), "off mode sets no proxy");
        assert!(plan.body["Cmd"].as_array().unwrap().contains(&json!("--strict-mcp-config")));

        for cli in crate::cli::ADAPTERS.iter().map(|a| a.id) {
            edit::update_role(&state, &pid, &[json!(role_id), json!({ "cli": cli })]).unwrap();
            let plan = rt.plan(&state, &pid, &id).unwrap();
            assert!(!plan.body.to_string().contains("docs-key-1") && !plan.body.to_string().contains("ARIMA_MCP_KEY"), "{cli}: no upstream key in the container's env or command");
            let mut stack = vec![dir.clone()];
            while let Some(d) = stack.pop() {
                for entry in std::fs::read_dir(&d).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        stack.push(path);
                    } else {
                        assert!(!std::fs::read_to_string(&path).unwrap_or_default().contains("docs-key-1"), "{cli}: {} holds an upstream key", path.display());
                    }
                }
            }
        }
        edit::update_role(&state, &pid, &[json!(role_id), json!({ "cli": "claude" })]).unwrap();
        assert!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap().contains("First role text"));

        std::fs::write(dir.join("CLAUDE.md"), format!("{}\nNotes the agent kept\n", std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap())).unwrap();
        edit::update_role(&state, &pid, &[json!(role_id), json!({ "roleMd": "Second role text" })]).unwrap();
        rt.plan(&state, &pid, &id).unwrap();
        let role = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert!(role.contains("Second role text") && !role.contains("First role text") && role.contains("Notes the agent kept"), "{role}");

        // A blocked server (a pack server whose tools changed) isn't given to the agent.
        int::update_tool_servers(&state, &pid, |servers| {
            servers[0].blocked = Some("tools changed".into());
            Ok(())
        })
        .unwrap();
        rt.plan(&state, &pid, &id).unwrap();
        let cfg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(cfg["mcpServers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["arima", "open-web"]);

        crate::codemode::set_switch(&state, &pid, &[json!(true)]).unwrap();
        rt.plan(&state, &pid, &id).unwrap();
        let cfg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(
            cfg["mcpServers"],
            json!({ "codemode": { "type": "stdio", "command": "node", "args": ["/opt/arima-codemode/server.mjs", format!("http://hq:7420/api/projects/{pid}")], "env": { "ARIMA_MCP_TOKEN": "${ARIMA_MCP_TOKEN}" } } }),
            "with Tools as code on, the CLI lists only the codemode server"
        );
        crate::codemode::set_switch(&state, &pid, &[json!(false)]).unwrap();
        rt.plan(&state, &pid, &id).unwrap();
        let cfg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(cfg["mcpServers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["arima", "open-web"], "off again, today's config");
    }

    /// A Docker stand-in that knows only the networks created through it, and logs each request as "METHOD path body".
    async fn fake_docker(dir: &std::path::Path) -> (PathBuf, Arc<Mutex<Vec<String>>>) {
        let path = dir.join("docker.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = log.clone();
        tokio::spawn(async move {
            let mut networks = std::collections::HashSet::new();
            while let Ok((mut stream, _)) = listener.accept().await {
                let (mut raw, mut buf) = (Vec::new(), [0u8; 4096]);
                let text = loop {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                        if body.len() >= len || n == 0 {
                            break text;
                        }
                    } else if n == 0 {
                        break text;
                    }
                };
                let mut words = text.split_whitespace();
                let (method, path) = (words.next().unwrap_or("").to_owned(), words.next().unwrap_or("").to_owned());
                let request = text.split_once("\r\n\r\n").map_or("", |(_, b)| b);
                seen.lock().unwrap().push(format!("{method} {path} {request}").trim_end().to_owned());
                let (status, body) = match method.as_str() {
                    "GET" if networks.contains(path.trim_start_matches("/networks/")) => (200, r#"{"Internal":true,"Containers":{}}"#),
                    "GET" => (404, "{}"),
                    "DELETE" => (204, ""),
                    _ if path == "/networks/create" => {
                        networks.insert(serde_json::from_str::<Value>(request).unwrap()["Name"].as_str().unwrap().to_owned());
                        (201, "{}")
                    }
                    _ => (200, "{}"),
                };
                let _ = stream.write_all(format!("HTTP/1.0 {status} X\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await;
            }
        });
        (path, log)
    }

    #[tokio::test]
    async fn each_enforce_project_gets_its_own_internal_network_until_it_leaves_enforce_or_is_deleted() {
        use crate::{team, team_edit as edit};
        let root = tempfile::TempDir::new().unwrap();
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([7u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
        let demo = state.default_project().unwrap().0;
        state.inner.db.transaction(|c| c.execute("INSERT INTO projects (id, slug, name, root_path, created_at, updated_at) VALUES ('proj-two', 'two', 'Two', '/w/two', 9, 9)", []).map_err(arima_db::DbError::from)).unwrap();
        let (socket, log) = fake_docker(root.path()).await;
        let mut rt = AgentRuntime::new(RuntimeConfig {
            enabled: true,
            image: "img".into(),
            network: "net".into(),
            workspaces_root: root.path().into(),
            workspaces_host_root: root.path().into(),
            hq_url: Some("http://arima-hq:7420".into()),
            egress_port: 8420,
            hq_container: Some("0123abcd".into()),
        });
        rt.engine = DockerEngine::new(&socket);
        let take = || std::mem::take(&mut *log.lock().unwrap());

        let mut nets = Vec::new();
        for pid in [demo.as_str(), "proj-two"] {
            team::complete_welcome(&state, pid, &[json!({ "templateId": "dev" })]).unwrap();
            edit::set_team_mode(&state, pid, &[json!("container")]).unwrap();
            crate::egress::set_mode(&state, pid, &[json!("enforce")]).unwrap();
            let agent = team::load(&state, pid).unwrap().team[0]["id"].as_str().unwrap().to_owned();
            let plan = rt.plan(&state, pid, &agent).unwrap();
            rt.prepare_network(&state, pid, plan.enforce.as_ref()).await.unwrap();
            nets.push(plan.body["HostConfig"]["NetworkMode"].as_str().unwrap().to_owned());
        }
        assert_eq!(nets, ["net-internal-demo", "net-internal-two"], "each enforce project starts its agents on its own network");
        let seen = take();
        for net in &nets {
            assert!(seen.iter().any(|r| r.starts_with("POST /networks/create {") && r.contains(&format!(r#""Name":"{net}""#)) && r.contains(r#""Internal":true"#)), "{seen:?}");
            assert!(seen.iter().any(|r| r.starts_with(&format!("POST /networks/{net}/connect ")) && r.contains(r#""Container":"0123abcd""#) && r.contains(r#""Aliases":["arima-hq"]"#)), "HQ joins {net} under its name: {seen:?}");
        }

        rt.release_network(&state, &demo, false).await;
        assert!(take().is_empty(), "a project still in enforce keeps its network");
        crate::egress::set_mode(&state, &demo, &[json!("observe")]).unwrap();
        rt.release_network(&state, &demo, false).await;
        assert_eq!(take(), [r#"POST /networks/net-internal-demo/disconnect {"Container":"0123abcd","Force":true}"#, "DELETE /networks/net-internal-demo"], "leaving enforce with nothing running removes it");

        rt.stop_project(&state, "proj-two").await;
        assert_eq!(take(), [r#"POST /networks/net-internal-two/disconnect {"Container":"0123abcd","Force":true}"#, "DELETE /networks/net-internal-two"], "deleting a project removes its network");
    }

    #[test]
    fn a_long_project_network_name_is_cut_to_63_characters_and_stays_distinct() {
        let cfg = RuntimeConfig { enabled: true, image: String::new(), network: "arima-agents".into(), workspaces_root: PathBuf::new(), workspaces_host_root: PathBuf::new(), hq_url: None, egress_port: 0, hq_container: None };
        let (a, b) = (cfg.internal_network(&format!("{}a", "x".repeat(80))), cfg.internal_network(&format!("{}b", "x".repeat(80))));
        assert!(a.len() == 63 && b.len() == 63 && a != b, "{a} {b}");
        assert_eq!(a, cfg.internal_network(&format!("{}a", "x".repeat(80))), "the same project always gets the same name");
        assert_eq!(cfg.internal_network("my proj!"), "arima-agents-internal-my-proj-", "only Docker's name characters");
    }

}
