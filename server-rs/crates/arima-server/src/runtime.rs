// SPDX-License-Identifier: AGPL-3.0-or-later

//! The agent runtime: runs each agent's CLI in its own container with a TTY, keeps the terminal's scrollback,
//! and streams its output to every connected client as `terminal.output` events.
//!
//! Container mode only. HQ reaches Docker through its Unix socket (see `arima_agents::DockerEngine`), so mounting
//! that socket into HQ is what turns the runtime on. Without it every start answers with a plain error.

use std::collections::HashMap;
use std::path::PathBuf;
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
    pub egress_proxy: Option<String>,
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
            egress_proxy: nonempty("ARIMA_AGENT_EGRESS_PROXY"),
        }
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
        let known = *name != "arima" && registry.iter().any(|s| s.name == *name);
        if !known {
            tracing::warn!(agent = agent_id, server = name, "skipping an MCP server that isn't registered");
        }
        known
    });
    std::iter::once(McpServer { name: "arima".to_owned(), url: base.to_owned() })
        .chain(selected.map(|name| McpServer { name: name.to_owned(), url: format!("{base}/{name}") }))
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

    /// Stops every running agent of a project (used when the project is deleted).
    pub async fn stop_project(&self, state: &AppState, project_id: &str) {
        let agents: Vec<String> = self.sessions.lock().map(|m| m.keys().filter(|(p, _)| p == project_id).map(|(_, a)| a.clone()).collect()).unwrap_or_default();
        for agent in agents {
            let _ = self.stop(state, project_id, &agent).await;
        }
    }

    pub async fn stop(&self, state: &AppState, project_id: &str, agent_id: &str) -> Result<(), String> {
        let name = format!("hq-{}-{agent_id}", crate::team::project_slug(state, project_id).unwrap_or_else(|| project_id.to_owned()));
        let session = self.sessions.lock().ok().and_then(|mut m| m.remove(&Self::key(project_id, agent_id)));
        state.inner.mcp.revoke_agent_token(project_id, agent_id);
        let target = session.as_ref().map_or(name, |s| s.container.clone());
        self.engine.stop(&target, 10).await.map_err(|e| e.to_string())?;
        self.engine.remove(&target).await.map_err(|e| e.to_string())
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
        self.engine.ensure_network(&self.config.network).await.map_err(|e| e.to_string())?;
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
            state.inner.mcp.revoke_agent_token(project_id, agent_id);
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
                let base = format!("{}/api/projects/{project_id}/mcp", url.trim_end_matches('/'));
                (hq_servers(state, project_id, agent, &base), Some(state.inner.mcp.issue_agent_token(project_id, agent_id)))
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
        if let Some(proxy) = &self.config.egress_proxy {
            for var in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                env.insert(var.to_owned(), proxy.clone());
            }
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
        if let Some(skills_dir) = adapter.skills_dir {
            let role_id = agent["roleId"].as_str().unwrap_or_default();
            for skill in crate::skills::approved_skills(state, project_id, role_id) {
                crate::skills::store(&self.config.workspaces_root.join(SKILLS_FOLDER), &skill.hash, &skill.name, &skill.files)?;
                let host = self.config.workspaces_host_root.join(SKILLS_FOLDER).join(&skill.hash).join(&skill.name);
                binds.push(format!("{}:{skills_dir}/{}:ro", host.display(), skill.name));
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
                "NetworkMode": self.config.network,
                "Init": true,
                "RestartPolicy": { "Name": "no" }
            }
        });
        Ok(Plan { container: format!("hq-{slug}-{agent_id}"), body, workspace_host })
    }
}

pub(crate) struct Plan {
    container: String,
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
            egress_proxy: None,
        });
        let plan = rt.plan(&state, &pid, &id).unwrap();
        let dir = root.path().join("demo").join(&id);
        let cfg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        let names: Vec<&String> = cfg["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(names, ["arima", "docs", "open-web"], "HQ's server plus the selected ones; the unknown id is skipped");
        assert_eq!(cfg["mcpServers"]["docs"], json!({ "type": "http", "url": format!("http://hq:7420/api/projects/{pid}/mcp/docs"), "headers": { "Authorization": "Bearer ${ARIMA_MCP_TOKEN}" } }));
        let env: Vec<&str> = plan.body["Env"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(env.iter().any(|e| e.starts_with("ARIMA_MCP_TOKEN=mcp_")), "{env:?}");
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
    }

}
