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

use crate::state::AppState;

const SCROLLBACK_BYTES: usize = 256 * 1024;
const DEFAULT_IMAGE: &str = "ghcr.io/sachindots/arimaops-agent:latest";
const DEFAULT_NETWORK: &str = "arima-agents";

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

pub struct AgentRuntime {
    pub config: RuntimeConfig,
    engine: DockerEngine,
    sessions: Mutex<HashMap<(String, String), Arc<Session>>>,
    status: Mutex<RuntimeStatus>,
}

fn clean_model(model: &Value) -> Option<String> {
    let m = model.as_str().unwrap_or("").trim();
    (!m.is_empty() && m.len() <= 80 && !m.starts_with('-') && m.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b':' | b'@'))).then(|| m.to_owned())
}

/// The CLI and its arguments for an agent in a container. The container and its network are the boundary, so
/// the CLI's own approval prompts are switched off: they would only stall an unattended agent.
#[must_use]
pub fn launch_args(cli: &str, model: &Value, mcp_config: bool) -> Option<(String, Vec<String>)> {
    let model = clean_model(model);
    let flag = |name: &str| model.iter().flat_map(|m| [name.to_owned(), m.clone()]).collect::<Vec<_>>();
    let args: Vec<String> = match cli {
        "claude" => ["--dangerously-skip-permissions".to_owned()].into_iter().chain(mcp_config.then(|| ["--mcp-config".to_owned(), ".mcp.json".to_owned()]).into_iter().flatten()).chain(flag("--model")).collect(),
        "codex" => ["-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"].map(str::to_owned).into_iter().chain(flag("-m")).collect(),
        "gemini" => ["--yolo".to_owned()].into_iter().chain(flag("--model")).collect(),
        "copilot" => ["--allow-all-tools".to_owned()].into_iter().chain(flag("--model")).collect(),
        "opencode" => flag("-m"),
        "agy" => ["--dangerously-skip-permissions", "--mode", "auto"].map(str::to_owned).into_iter().chain(flag("--model")).collect(),
        _ => return None,
    };
    Some((cli.to_owned(), args))
}

/// The instruction file name each CLI reads from its working folder.
#[must_use]
pub fn role_file(cli: &str) -> &'static str {
    match cli {
        "claude" => "CLAUDE.md",
        "gemini" => "GEMINI.md",
        _ => "AGENTS.md",
    }
}

/// The environment variable that carries an API-key account's secret to a CLI, if that pairing exists.
#[must_use]
pub fn provider_env(cli: &str, provider: &str) -> &'static [&'static str] {
    match (cli, provider) {
        ("claude", "anthropic") => &["ANTHROPIC_API_KEY"],
        ("codex" | "opencode", "openai") => &["OPENAI_API_KEY"],
        ("gemini", "google") => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        ("opencode", "openrouter") => &["OPENROUTER_API_KEY"],
        _ => &[],
    }
}

impl AgentRuntime {
    #[must_use]
    pub fn new(config: RuntimeConfig) -> Self {
        Self { config, engine: DockerEngine::from_env(), sessions: Mutex::new(HashMap::new()), status: Mutex::new(RuntimeStatus::default()) }
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

    pub async fn stop(&self, state: &AppState, project_id: &str, agent_id: &str) -> Result<(), String> {
        let name = format!("hq-{}-{agent_id}", crate::team::project_slug(state, project_id).unwrap_or_else(|| project_id.to_owned()));
        let session = self.sessions.lock().ok().and_then(|mut m| m.remove(&Self::key(project_id, agent_id)));
        let target = session.as_ref().map_or(name, |s| s.container.clone());
        self.engine.stop(&target, 10).await.map_err(|e| e.to_string())?;
        self.engine.remove(&target).await.map_err(|e| e.to_string())
    }

    /// Starts an agent's container and begins streaming its terminal. A running agent is left as it is.
    pub async fn start(&self, state: &AppState, project_id: &str, agent_id: &str) -> Result<(), String> {
        if self.is_running(project_id, agent_id) {
            return Ok(());
        }
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
            let _ = state.inner.supervisor.stop_agent(project_id, agent_id).await;
            let note = if exit == 0 { "Session ended".to_owned() } else { format!("Session ended with exit code {exit}") };
            let event = json!({ "type": "agent-status", "projectId": project_id, "agentId": agent_id, "state": "idle", "note": note });
            state.inner.ws_hub.broadcast_project(project_id, &event.to_string());
        }
        let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
        state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
    }

    fn plan(&self, state: &AppState, project_id: &str, agent_id: &str) -> Result<Plan, String> {
        let model = crate::team::load(state, project_id).ok_or("This project has no team yet. Pick a team first.")?;
        let agent = model.team.iter().find(|a| a["id"] == agent_id).ok_or_else(|| format!("No agent \"{agent_id}\"."))?;
        let mode = agent["mode"].as_str().unwrap_or("local");
        if mode != "container" {
            return Err(format!("{} runs in {mode} mode. Agents run in container mode in this HQ build: switch the team's mode in Settings → Sandbox.", agent["name"].as_str().unwrap_or(agent_id)));
        }
        let cli = agent["cli"].as_str().unwrap_or("");
        let with_mcp = self.config.hq_url.is_some() && cli == "claude";
        let (program, args) = launch_args(cli, &agent["model"], with_mcp).ok_or_else(|| format!("HQ doesn't know how to launch \"{cli}\"."))?;
        arima_agents::docker::validate_launch(&program, &args).map_err(|e| e.to_string())?;

        let slug = crate::team::project_slug(state, project_id).unwrap_or_else(|| project_id.to_owned());
        let dir = self.config.workspaces_root.join(&slug).join(agent_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create the agent's folder: {e}"))?;
        let name = agent["name"].as_str().unwrap_or(agent_id);
        let role_path = dir.join(role_file(cli));
        if !role_path.exists() {
            let body = format!("# {name}, {}\n\n{}\n", agent["role"].as_str().unwrap_or("agent"), agent["roleMd"].as_str().unwrap_or(""));
            std::fs::write(&role_path, body).map_err(|e| e.to_string())?;
        }
        if let (Some(url), true) = (&self.config.hq_url, with_mcp) {
            let token = state.inner.mcp.issue_agent_token(project_id, agent_id);
            let cfg = json!({ "mcpServers": { "arima": { "type": "http", "url": format!("{}/api/projects/{project_id}/mcp", url.trim_end_matches('/')), "headers": { "Authorization": format!("Bearer {token}") } } } });
            std::fs::write(dir.join(".mcp.json"), serde_json::to_string_pretty(&cfg).unwrap_or_default()).map_err(|e| e.to_string())?;
        }

        let mut env: HashMap<String, String> = crate::secrets::env_for(state, project_id, agent_id);
        env.extend([("TERM".to_owned(), "xterm-256color".to_owned()), ("HOME".to_owned(), "/workspace/.agent-home".to_owned())]);
        if let Some(account) = agent["account"].as_str().filter(|a| !a.is_empty()) {
            let row = state.inner.vault_secrets.get_by_id(&format!("acct-{account}")).ok().flatten().ok_or_else(|| format!("The account \"{account}\" this agent uses doesn't exist."))?;
            let secret = state.inner.auth.vault().decrypt(format!("vault-secret:{}", row.id).as_bytes(), &row.secret_enc).map_err(|e| e.to_string())?;
            for var in provider_env(cli, &row.provider) {
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
            "Labels": { "arimaops.project": project_id, "arimaops.agent": agent_id },
            "HostConfig": {
                "Binds": [format!("{workspace_host}:/workspace:rw")],
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

struct Plan {
    container: String,
    body: Value,
    workspace_host: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_args_switch_off_prompts_and_pass_the_model() {
        let (prog, args) = launch_args("claude", &json!("opus"), true).unwrap();
        assert_eq!(prog, "claude");
        assert_eq!(args, ["--dangerously-skip-permissions", "--mcp-config", ".mcp.json", "--model", "opus"]);
        let (_, codex) = launch_args("codex", &json!(""), false).unwrap();
        assert!(codex.contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()) && !codex.contains(&"-m".to_owned()));
        assert!(launch_args("vim", &json!(""), false).is_none());
    }

    #[test]
    fn a_model_that_looks_like_a_flag_or_shell_is_dropped() {
        for bad in ["--evil", "-x", "a b", "x;rm -rf /", "$(id)"] {
            let (_, args) = launch_args("gemini", &json!(bad), false).unwrap();
            assert_eq!(args, ["--yolo"], "{bad} isn't passed through");
        }
        assert_eq!(launch_args("gemini", &json!("gemini-2.5-pro"), false).unwrap().1, ["--yolo", "--model", "gemini-2.5-pro"]);
    }

    #[test]
    fn provider_keys_map_only_to_cli_pairs_that_use_them() {
        assert_eq!(provider_env("claude", "anthropic"), ["ANTHROPIC_API_KEY"]);
        assert!(provider_env("claude", "openai").is_empty());
        assert_eq!(role_file("claude"), "CLAUDE.md");
        assert_eq!(role_file("codex"), "AGENTS.md");
    }
}
