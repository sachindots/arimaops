// SPDX-License-Identifier: AGPL-3.0-or-later

//! One adapter per agent CLI: how HQ launches it, where it reads its role, which provider keys it takes, how it
//! is told about tool servers and where it finds Agent Skills. Every per-CLI difference lives in this table.

use serde_json::{json, Value};

/// The agent's home inside its container (`HOME`).
pub const AGENT_HOME: &str = "/workspace/.agent-home";

/// The env var that carries the agent's HQ token, the only tool-server secret in its container.
pub const TOKEN_ENV: &str = "ARIMA_MCP_TOKEN";

/// Where the agent image keeps the codemode tool server (`docker/codemode`).
pub const CODEMODE_SERVER: &str = "/opt/arima-codemode/server.mjs";

/// A tool server an agent connects to. Each one reaches HQ (its own server, or a project server HQ forwards to) on
/// the agent's HQ token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpServer {
    Http { name: String, url: String },
    /// Tools as code: the codemode server inside the agent's container, started over stdio, calling HQ at
    /// `project_url` (HQ's `/api/projects/{id}`).
    Codemode { project_url: String },
}

impl McpServer {
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Http { name, .. } => name,
            Self::Codemode { .. } => "codemode",
        }
    }
}

const NODE: &str = "node";

/// How one CLI is told about its tool servers: a file written under the agent's folder, extra arguments, extra env.
#[derive(Debug, Default, PartialEq)]
pub struct McpLaunch {
    pub file: Option<(&'static str, Value)>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Native file format a CLI expects inside its user-level `agents_dir`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFormat {
    ClaudeMd,
    CodexToml,
    GeminiMd,
    CopilotAgentMd,
    OpencodeMd,
    AgyMd,
}

pub struct CliAdapter {
    /// The id stored on an agent (`agent.cli`), which is also the program run in the container.
    pub id: &'static str,
    pub label: &'static str,
    /// Arguments that switch off the CLI's own approval prompts: the container is the boundary.
    pub base_args: &'static [&'static str],
    pub model_flag: &'static str,
    /// The instruction file name the CLI reads from its working folder.
    pub role_file: &'static str,
    /// Provider id to the env vars that carry an API-key account's secret.
    pub provider_env: &'static [(&'static str, &'static [&'static str])],
    /// The CLI's MCP config, holding exactly the given servers and, where the CLI allows it, nothing from the workspace.
    /// The second argument is the agent's HQ token.
    pub mcp: fn(&[McpServer], &str) -> McpLaunch,
    /// The user-level folder inside the container where the CLI discovers Agent Skills; None without skills support.
    pub skills_dir: Option<&'static str>,
    /// The user-level folder inside the container where the CLI discovers sub-agents; None uses the role-file fallback.
    pub agents_dir: Option<&'static str>,
    /// Native file format rendered into `agents_dir` for this CLI.
    pub agent_format: AgentFormat,
    /// Hosts the CLI needs for its model providers' APIs and its own sign-in (egress rules, see `crate::egress`).
    pub egress: &'static [&'static str],
}

impl CliAdapter {
    /// The program and its arguments; a model that could be read as a flag or shell is dropped.
    #[must_use]
    pub fn launch_args(&self, model: &Value) -> (String, Vec<String>) {
        let model = clean_model(model).into_iter().flat_map(|m| [self.model_flag.to_owned(), m]);
        (self.id.to_owned(), self.base_args.iter().map(|a| (*a).to_owned()).chain(model).collect())
    }

    #[must_use]
    pub fn provider_env(&self, provider: &str) -> &'static [&'static str] {
        self.provider_env.iter().find(|(p, _)| *p == provider).map_or(&[], |(_, vars)| vars)
    }
}

pub const ADAPTERS: [CliAdapter; 6] = [
    CliAdapter {
        id: "claude",
        label: "Claude Code",
        base_args: &["--dangerously-skip-permissions"],
        model_flag: "--model",
        role_file: "CLAUDE.md",
        provider_env: &[("anthropic", &["ANTHROPIC_API_KEY"])],
        mcp: mcp_claude,
        skills_dir: Some("/workspace/.agent-home/.claude/skills"),
        agents_dir: Some("/workspace/.agent-home/.claude/agents"),
        agent_format: AgentFormat::ClaudeMd,
        egress: &["anthropic.com", "*.anthropic.com", "claude.ai", "*.claude.ai", "claude.com", "*.claude.com"],
    },
    CliAdapter {
        id: "codex",
        label: "Codex",
        base_args: &["-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"],
        model_flag: "-m",
        role_file: "AGENTS.md",
        provider_env: &[("openai", &["OPENAI_API_KEY"])],
        mcp: mcp_codex,
        skills_dir: Some("/workspace/.agent-home/.agents/skills"),
        agents_dir: Some("/workspace/.agent-home/.codex/agents"),
        agent_format: AgentFormat::CodexToml,
        egress: &["openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com"],
    },
    CliAdapter {
        id: "opencode",
        label: "OpenCode",
        base_args: &[],
        model_flag: "-m",
        role_file: "AGENTS.md",
        provider_env: &[("openai", &["OPENAI_API_KEY"]), ("openrouter", &["OPENROUTER_API_KEY"])],
        mcp: mcp_opencode,
        skills_dir: Some("/workspace/.agent-home/.config/opencode/skills"),
        agents_dir: Some("/workspace/.agent-home/.config/opencode/agents"),
        agent_format: AgentFormat::OpencodeMd,
        egress: &["opencode.ai", "*.opencode.ai", "models.dev", "openai.com", "*.openai.com", "openrouter.ai", "*.openrouter.ai", "api.deepseek.com"],
    },
    CliAdapter {
        id: "gemini",
        label: "Gemini CLI",
        base_args: &["--yolo"],
        model_flag: "--model",
        role_file: "GEMINI.md",
        provider_env: &[("google", &["GEMINI_API_KEY", "GOOGLE_API_KEY"])],
        mcp: mcp_gemini,
        skills_dir: Some("/workspace/.agent-home/.gemini/skills"),
        agents_dir: Some("/workspace/.agent-home/.gemini/agents"),
        agent_format: AgentFormat::GeminiMd,
        egress: &["*.googleapis.com", "accounts.google.com", "*.google.com", "*.gstatic.com"],
    },
    CliAdapter {
        id: "copilot",
        label: "Copilot CLI",
        base_args: &["--allow-all-tools"],
        model_flag: "--model",
        role_file: "AGENTS.md",
        provider_env: &[],
        mcp: mcp_copilot,
        skills_dir: Some("/workspace/.agent-home/.copilot/skills"),
        agents_dir: Some("/workspace/.agent-home/.copilot/agents"),
        agent_format: AgentFormat::CopilotAgentMd,
        egress: &["*.githubcopilot.com", "github.com", "*.github.com"],
    },
    CliAdapter {
        id: "agy",
        label: "Antigravity",
        base_args: &["--dangerously-skip-permissions", "--mode", "auto"],
        model_flag: "--model",
        role_file: "AGENTS.md",
        provider_env: &[],
        mcp: mcp_agy,
        skills_dir: Some("/workspace/.agent-home/.gemini/config/skills"),
        agents_dir: Some("/workspace/.agent-home/.gemini/config/agents"),
        agent_format: AgentFormat::AgyMd,
        egress: &["antigravity.google", "*.googleapis.com", "accounts.google.com", "*.google.com", "*.gstatic.com"],
    },
];

#[must_use]
pub fn adapter(cli: &str) -> Option<&'static CliAdapter> {
    ADAPTERS.iter().find(|a| a.id == cli)
}

fn clean_model(model: &Value) -> Option<String> {
    let m = model.as_str().unwrap_or("").trim();
    (!m.is_empty() && m.len() <= 80 && !m.starts_with('-') && m.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b':' | b'@'))).then(|| m.to_owned())
}

// Claude, Codex and OpenCode read the HQ token from the env var; the others don't expand env vars in headers, so
// their file (inside the agent's private home, never the workspace root) holds it. No upstream key is ever here.
// `http` gets an HTTP server's URL and headers; `stdio` a stdio server's arguments (after `node`) and environment.
fn server_map(servers: &[McpServer], http: impl Fn(&str, Value) -> Value, stdio: impl Fn(Vec<String>, Value) -> Value, token: &str) -> Value {
    servers
        .iter()
        .map(|s| {
            let entry = match s {
                McpServer::Http { url, .. } => http(url, json!({ "Authorization": format!("Bearer {token}") })),
                McpServer::Codemode { project_url } => stdio(vec![CODEMODE_SERVER.to_owned(), project_url.clone()], json!({ TOKEN_ENV: token })),
            };
            (s.name().to_owned(), entry)
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

fn in_home(path: &str) -> String {
    format!("/workspace/{path}")
}

fn mcp_claude(servers: &[McpServer], _: &str) -> McpLaunch {
    let map = server_map(servers, |url, h| json!({ "type": "http", "url": url, "headers": h }), |args, env| json!({ "type": "stdio", "command": NODE, "args": args, "env": env }), &format!("${{{TOKEN_ENV}}}"));
    McpLaunch {
        file: Some((".mcp.json", json!({ "mcpServers": map }))),
        args: ["--strict-mcp-config", "--mcp-config", ".mcp.json"].map(str::to_owned).to_vec(),
        env: Vec::new(),
    }
}

fn mcp_codex(servers: &[McpServer], _: &str) -> McpLaunch {
    // `-c` values parse as TOML; a JSON string or array of strings is valid TOML too.
    let set = |name: &str, key: &str, value: Value| ["-c".to_owned(), format!("mcp_servers.{name}.{key}={value}")];
    McpLaunch {
        args: servers
            .iter()
            .flat_map(|s| match s {
                McpServer::Http { name, url } => [set(name, "url", json!(url)), set(name, "bearer_token_env_var", json!(TOKEN_ENV))].concat(),
                // Codex starts stdio servers with a short list of variables; `env_vars` passes the token's on by name.
                McpServer::Codemode { project_url } => {
                    let name = s.name();
                    [set(name, "command", json!(NODE)), set(name, "args", json!([CODEMODE_SERVER, project_url])), set(name, "env_vars", json!([TOKEN_ENV]))].concat()
                }
            })
            .collect(),
        ..McpLaunch::default()
    }
}

fn mcp_gemini(servers: &[McpServer], token: &str) -> McpLaunch {
    const PATH: &str = ".agent-home/.arima/gemini-settings.json";
    let names: Vec<&str> = servers.iter().map(McpServer::name).collect();
    let map = server_map(servers, |url, h| json!({ "httpUrl": url, "headers": h }), |args, env| json!({ "command": NODE, "args": args, "env": env }), token);
    McpLaunch {
        file: Some((PATH, json!({ "mcpServers": map, "mcp": { "allowed": names } }))),
        // The system settings file outranks the user's and the workspace's settings.
        env: vec![("GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_owned(), in_home(PATH))],
        ..McpLaunch::default()
    }
}

fn mcp_copilot(servers: &[McpServer], token: &str) -> McpLaunch {
    let map = server_map(
        servers,
        |url, h| json!({ "type": "http", "url": url, "headers": h, "tools": ["*"] }),
        |args, env| json!({ "type": "local", "command": NODE, "args": args, "env": env, "tools": ["*"] }),
        token,
    );
    McpLaunch { file: Some((".agent-home/.copilot/mcp-config.json", json!({ "mcpServers": map }))), ..McpLaunch::default() }
}

fn mcp_opencode(servers: &[McpServer], _: &str) -> McpLaunch {
    const PATH: &str = ".agent-home/.arima/opencode.json";
    let map = server_map(
        servers,
        |url, h| json!({ "type": "remote", "url": url, "headers": h }),
        |args, env| json!({ "type": "local", "command": std::iter::once(NODE.to_owned()).chain(args).collect::<Vec<_>>(), "environment": env }),
        &format!("{{env:{TOKEN_ENV}}}"),
    );
    McpLaunch {
        file: Some((PATH, json!({ "mcp": { "servers": map } }))),
        env: vec![("OPENCODE_CONFIG".to_owned(), in_home(PATH))],
        ..McpLaunch::default()
    }
}

fn mcp_agy(servers: &[McpServer], token: &str) -> McpLaunch {
    let map = server_map(servers, |url, h| json!({ "serverUrl": url, "headers": h }), |args, env| json!({ "command": NODE, "args": args, "env": env }), token);
    McpLaunch { file: Some((".agent-home/.gemini/config/mcp_config.json", json!({ "mcpServers": map }))), ..McpLaunch::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(cli: &str, model: Value) -> Vec<String> {
        adapter(cli).unwrap().launch_args(&model).1
    }

    #[test]
    fn launch_args_switch_off_prompts_and_pass_the_model() {
        let (prog, a) = adapter("claude").unwrap().launch_args(&json!("opus"));
        assert_eq!(prog, "claude");
        assert_eq!(a, ["--dangerously-skip-permissions", "--model", "opus"]);
        let codex = args("codex", json!(""));
        assert!(codex.contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()) && !codex.contains(&"-m".to_owned()));
        assert!(adapter("vim").is_none());
    }

    #[test]
    fn a_model_that_looks_like_a_flag_or_shell_is_dropped() {
        for bad in ["--evil", "-x", "a b", "x;rm -rf /", "$(id)"] {
            assert_eq!(args("gemini", json!(bad)), ["--yolo"], "{bad} isn't passed through");
        }
        assert_eq!(args("gemini", json!("gemini-2.5-pro")), ["--yolo", "--model", "gemini-2.5-pro"]);
    }

    fn two_servers() -> Vec<McpServer> {
        vec![
            McpServer::Http { name: "arima".into(), url: "http://hq/api/projects/p/mcp".into() },
            McpServer::Http { name: "docs".into(), url: "http://hq/api/projects/p/mcp/docs".into() },
        ]
    }

    fn mcp(cli: &str, servers: &[McpServer]) -> McpLaunch {
        (adapter(cli).unwrap().mcp)(servers, "tok-1")
    }

    #[test]
    fn every_cli_gets_its_own_mcp_config_with_every_server_on_the_hq_token() {
        let s = two_servers();
        let claude = mcp("claude", &s);
        assert_eq!(claude.args, ["--strict-mcp-config", "--mcp-config", ".mcp.json"]);
        let (path, cfg) = claude.file.unwrap();
        assert_eq!(path, ".mcp.json");
        assert_eq!(cfg["mcpServers"]["arima"], json!({ "type": "http", "url": "http://hq/api/projects/p/mcp", "headers": { "Authorization": "Bearer ${ARIMA_MCP_TOKEN}" } }));
        assert_eq!(cfg["mcpServers"]["docs"], json!({ "type": "http", "url": "http://hq/api/projects/p/mcp/docs", "headers": { "Authorization": "Bearer ${ARIMA_MCP_TOKEN}" } }));
        assert!(!cfg.to_string().contains("tok-1"), "Claude reads the token from the environment, not the file");

        let codex = mcp("codex", &s);
        assert!(codex.file.is_none());
        assert_eq!(
            codex.args,
            [
                "-c",
                "mcp_servers.arima.url=\"http://hq/api/projects/p/mcp\"",
                "-c",
                "mcp_servers.arima.bearer_token_env_var=\"ARIMA_MCP_TOKEN\"",
                "-c",
                "mcp_servers.docs.url=\"http://hq/api/projects/p/mcp/docs\"",
                "-c",
                "mcp_servers.docs.bearer_token_env_var=\"ARIMA_MCP_TOKEN\""
            ]
        );
        assert!(arima_agents::docker::validate_launch("codex", &codex.args).is_ok(), "no secret on argv");

        let gemini = mcp("gemini", &s);
        let (path, cfg) = gemini.file.unwrap();
        assert_eq!(gemini.env, [("GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_owned(), format!("/workspace/{path}"))]);
        assert_eq!(cfg["mcpServers"]["docs"], json!({ "httpUrl": "http://hq/api/projects/p/mcp/docs", "headers": { "Authorization": "Bearer tok-1" } }));
        assert_eq!(cfg["mcp"]["allowed"], json!(["arima", "docs"]));

        let (path, cfg) = mcp("copilot", &s).file.unwrap();
        assert_eq!(path, ".agent-home/.copilot/mcp-config.json");
        assert_eq!(cfg["mcpServers"]["docs"], json!({ "type": "http", "url": "http://hq/api/projects/p/mcp/docs", "headers": { "Authorization": "Bearer tok-1" }, "tools": ["*"] }));

        let opencode = mcp("opencode", &s);
        let (path, cfg) = opencode.file.unwrap();
        assert_eq!(opencode.env, [("OPENCODE_CONFIG".to_owned(), format!("/workspace/{path}"))]);
        assert_eq!(cfg["mcp"]["servers"]["docs"], json!({ "type": "remote", "url": "http://hq/api/projects/p/mcp/docs", "headers": { "Authorization": "Bearer {env:ARIMA_MCP_TOKEN}" } }));

        let (path, cfg) = mcp("agy", &s).file.unwrap();
        assert_eq!(path, ".agent-home/.gemini/config/mcp_config.json");
        assert_eq!(cfg["mcpServers"]["docs"], json!({ "serverUrl": "http://hq/api/projects/p/mcp/docs", "headers": { "Authorization": "Bearer tok-1" } }));

        for a in ADAPTERS.iter().filter(|a| a.id != "codex") {
            assert!((a.mcp)(&[], "tok-1").file.is_some(), "{}: an empty selection still writes a config, replacing any earlier one", a.id);
        }
    }

    #[test]
    fn with_tools_as_code_every_cli_starts_only_the_codemode_server_with_the_hq_token() {
        let s = [McpServer::Codemode { project_url: "http://hq/api/projects/p".into() }];
        let args = json!(["/opt/arima-codemode/server.mjs", "http://hq/api/projects/p"]);
        let (_, cfg) = mcp("claude", &s).file.unwrap();
        assert_eq!(cfg["mcpServers"], json!({ "codemode": { "type": "stdio", "command": "node", "args": args, "env": { "ARIMA_MCP_TOKEN": "${ARIMA_MCP_TOKEN}" } } }));
        let codex = mcp("codex", &s);
        assert_eq!(
            codex.args,
            [
                "-c",
                "mcp_servers.codemode.command=\"node\"",
                "-c",
                "mcp_servers.codemode.args=[\"/opt/arima-codemode/server.mjs\",\"http://hq/api/projects/p\"]",
                "-c",
                "mcp_servers.codemode.env_vars=[\"ARIMA_MCP_TOKEN\"]"
            ]
        );
        assert!(arima_agents::docker::validate_launch("codex", &codex.args).is_ok(), "no secret on argv");
        let (_, cfg) = mcp("gemini", &s).file.unwrap();
        assert_eq!(cfg, json!({ "mcpServers": { "codemode": { "command": "node", "args": args, "env": { "ARIMA_MCP_TOKEN": "tok-1" } } }, "mcp": { "allowed": ["codemode"] } }));
        let (_, cfg) = mcp("copilot", &s).file.unwrap();
        assert_eq!(cfg["mcpServers"], json!({ "codemode": { "type": "local", "command": "node", "args": args, "env": { "ARIMA_MCP_TOKEN": "tok-1" }, "tools": ["*"] } }));
        let (_, cfg) = mcp("opencode", &s).file.unwrap();
        assert_eq!(cfg["mcp"]["servers"], json!({ "codemode": { "type": "local", "command": ["node", "/opt/arima-codemode/server.mjs", "http://hq/api/projects/p"], "environment": { "ARIMA_MCP_TOKEN": "{env:ARIMA_MCP_TOKEN}" } } }));
        let (_, cfg) = mcp("agy", &s).file.unwrap();
        assert_eq!(cfg["mcpServers"], json!({ "codemode": { "command": "node", "args": args, "env": { "ARIMA_MCP_TOKEN": "tok-1" } } }));
    }

    #[test]
    fn provider_keys_map_only_to_cli_pairs_that_use_them() {
        let claude = adapter("claude").unwrap();
        assert_eq!(claude.provider_env("anthropic"), ["ANTHROPIC_API_KEY"]);
        assert!(claude.provider_env("openai").is_empty());
        assert_eq!(adapter("opencode").unwrap().provider_env("openrouter"), ["OPENROUTER_API_KEY"]);
        assert_eq!(claude.role_file, "CLAUDE.md");
        assert_eq!(adapter("codex").unwrap().role_file, "AGENTS.md");
    }

    #[test]
    fn every_agent_cli_the_ui_offers_has_one_adapter_with_skills_under_the_agent_home() {
        let types = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src/data/types.ts")).unwrap();
        let list = types.split("export const AGENT_CLIS = [").nth(1).and_then(|r| r.split(']').next()).expect("AGENT_CLIS in src/data/types.ts");
        let ui: Vec<&str> = list.split(',').map(|c| c.trim().trim_matches('"')).collect();
        for cli in &ui {
            assert_eq!(ADAPTERS.iter().filter(|a| a.id == *cli).count(), 1, "{cli}");
        }
        assert_eq!(ui.len(), ADAPTERS.len(), "{ui:?}");
        for a in &ADAPTERS {
            assert!(a.skills_dir.is_none_or(|d| d.starts_with(&format!("{AGENT_HOME}/")) && d.ends_with("/skills")), "{}", a.id);
            assert!(a.agents_dir.is_none_or(|d| d.starts_with(&format!("{AGENT_HOME}/")) && d.ends_with("/agents")), "{}", a.id);
        }
    }

    #[test]
    fn no_per_cli_string_match_outside_the_adapter_table() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") && path.file_name().is_some_and(|n| n != "cli.rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    assert!(!text.contains(concat!("cli ", "== \"")), "{} matches on a CLI name: add it to cli.rs instead", path.display());
                }
            }
        }
    }
}
