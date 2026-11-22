// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::{
    AgentError, Result, DEFAULT_CONTAINER_CPUS, DEFAULT_CONTAINER_MEMORY_GB,
    DEFAULT_CONTAINER_MEMORY_MB,
};

const FORBIDDEN_ARGV_TOKENS: &[&str] = &[
    "--api-key",
    "--apikey",
    "--token",
    "--secret",
    "--password",
    "anthropic_api_key=",
    "openai_api_key=",
    "gemini_api_key=",
    "bearer ",
    "sk-ant-",
    "sk-proj-",
    "ghp_",
];

/// How secrets are delivered into an agent container (NEVER via CLI argv or persistent host files).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum SecretDelivery {
    /// Mounted solely in an in-memory `tmpfs` at `/run/arima/secrets` with `0400` permissions.
    TmpfsMemory { mount_path: String },
    /// Piped over container stdin at startup and wiped immediately.
    StdinPipe,
    /// Passed as scoped container environment variables via the Docker Engine API create body.
    ContainerEnv,
}

/// Input parameters for constructing a hardened agent container specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSpecInput {
    pub project_slug: String,
    pub agent_id: String,
    pub image: String,
    pub program: String,
    pub args: Vec<String>,
    pub workspace_host_path: String,
    pub cpus: Option<u32>,
    pub memory_mb: Option<u32>,
    pub env: HashMap<String, String>,
    pub egress_proxy_url: Option<String>,
}

/// Validated Docker Engine container creation spec with mandatory CPU/RAM quotas and fixed `br-hq` IP.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerLaunchSpec {
    pub container_name: String,
    pub image: String,
    pub entrypoint: Vec<String>,
    pub cmd: Vec<String>,
    pub cpus: u32,
    pub nano_cpus: i64,
    pub memory_mb: u32,
    pub memory_bytes: i64,
    pub pids_limit: i64,
    pub network_name: String,
    pub fixed_ipv4: Ipv4Addr,
    pub tmpfs_mounts: HashMap<String, String>,
    pub env_list: Vec<String>,
    pub secret_delivery: SecretDelivery,
}

/// Static container IP registry (`172.30.0.10..=172.30.0.250` on `br-hq`) and Docker Engine
/// spec builder that eliminates 1s `docker network inspect` subprocess polling and enforces
/// default CPU/RAM quotas (`cpus: 2`, `memory_mb: 2048`).
#[derive(Debug, Clone, Default)]
pub struct DockerEngineLauncher {
    ip_allocations: Arc<Mutex<HashMap<String, Ipv4Addr>>>,
}

/// The launch checks every agent container shares: no shell interpolation and no secrets on the command line.
pub fn validate_launch(program: &str, args: &[String]) -> Result<()> {
    let prog = program.trim();
    if prog.is_empty() || matches!(prog, "sh" | "/bin/sh" | "bash" | "/bin/bash") && args.first().map(String::as_str) == Some("-c") {
        return Err(AgentError::SecurityViolation("shell interpolation ('sh -c' / 'bash -c') is forbidden in container specs".into()));
    }
    for arg in args {
        let lower = arg.to_ascii_lowercase();
        if let Some(pat) = FORBIDDEN_ARGV_TOKENS.iter().find(|p| lower.contains(*p)) {
            return Err(AgentError::SecurityViolation(format!("secret/token pattern '{pat}' is forbidden on container argv")));
        }
    }
    Ok(())
}

impl DockerEngineLauncher {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocates or returns the deterministic fixed `br-hq` IP (`172.30.0.10..=172.30.0.250`)
    /// for `container_name`.
    pub fn allocate_ip(&self, container_name: &str) -> Result<Ipv4Addr> {
        let mut guard = self
            .ip_allocations
            .lock()
            .map_err(|_| AgentError::InvalidConfig("container ip map lock poisoned".into()))?;
        if let Some(&existing) = guard.get(container_name) {
            return Ok(existing);
        }
        for host_octet in 10u8..=250u8 {
            let candidate = Ipv4Addr::new(172, 30, 0, host_octet);
            if !guard.values().any(|&ip| ip == candidate) {
                guard.insert(container_name.to_owned(), candidate);
                return Ok(candidate);
            }
        }
        Err(AgentError::InvalidConfig(
            "br-hq subnet 172.30.0.10..250 exhausted".into(),
        ))
    }

    /// Releases a container's static IP allocation (e.g., on `forget_project` or agent removal).
    pub fn release_ip(&self, container_name: &str) -> Option<Ipv4Addr> {
        self.ip_allocations
            .lock()
            .ok()
            .and_then(|mut g| g.remove(container_name))
    }

    /// Looks up a container's assigned `br-hq` IP in O(1) memory without spawning `docker inspect`.
    #[must_use]
    pub fn lookup_ip(&self, container_name: &str) -> Option<Ipv4Addr> {
        self.ip_allocations
            .lock()
            .ok()
            .and_then(|g| g.get(container_name).copied())
    }

    /// Builds a hardened [`ContainerLaunchSpec`] enforcing:
    /// 1. Mandatory default quotas (`cpus: 2`, `memory_mb: 2048` / `2 GB`) whenever unset or `0`
    /// 2. Zero shell interpolation (`entrypoint` + `cmd` argv arrays directly)
    /// 3. Zero secrets or bearer tokens on `cmd` argv
    /// 4. Ephemeral `tmpfs` secret delivery at `/run/arima/secrets` (`rw,noexec,nosuid,size=4m,mode=0700`).
    pub fn build_spec(&self, input: &ContainerSpecInput) -> Result<ContainerLaunchSpec> {
        let slug = input.project_slug.trim();
        let agent = input.agent_id.trim();
        if slug.is_empty()
            || !slug
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(AgentError::InvalidConfig(format!(
                "invalid project slug '{slug}'"
            )));
        }
        if agent.is_empty()
            || !agent
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(AgentError::InvalidConfig(format!(
                "invalid agent id '{agent}'"
            )));
        }
        let prog = input.program.trim();
        if prog.is_empty() || matches!(prog, "sh" | "/bin/sh" | "bash" | "/bin/bash") && input.args.first().map(String::as_str) == Some("-c") {
            return Err(AgentError::SecurityViolation(
                "shell interpolation ('sh -c' / 'bash -c') is forbidden in container specs".into(),
            ));
        }

        for arg in &input.args {
            let lower = arg.to_ascii_lowercase();
            for pat in FORBIDDEN_ARGV_TOKENS {
                if lower.contains(pat) {
                    return Err(AgentError::SecurityViolation(format!(
                        "secret/token pattern '{pat}' is forbidden on container argv"
                    )));
                }
            }
        }

        let cpus = input
            .cpus
            .filter(|&c| c > 0)
            .unwrap_or(DEFAULT_CONTAINER_CPUS);
        let memory_mb = input
            .memory_mb
            .filter(|&m| m > 0)
            .unwrap_or(DEFAULT_CONTAINER_MEMORY_MB);

        let nano_cpus = i64::from(cpus) * 1_000_000_000;
        let memory_bytes = i64::from(memory_mb) * 1024 * 1024;
        debug_assert_eq!(DEFAULT_CONTAINER_MEMORY_MB, DEFAULT_CONTAINER_MEMORY_GB * 1024);

        let container_name = format!("hq-{slug}-{agent}");
        let fixed_ipv4 = self.allocate_ip(&container_name)?;

        let mut env_list: Vec<String> = input
            .env
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        if let Some(ref proxy) = input.egress_proxy_url {
            env_list.push(format!("HTTP_PROXY={proxy}"));
            env_list.push(format!("HTTPS_PROXY={proxy}"));
        }
        env_list.sort();

        let mut tmpfs_mounts = HashMap::new();
        tmpfs_mounts.insert(
            "/run/arima/secrets".into(),
            "rw,noexec,nosuid,nodev,size=4m,mode=0700".into(),
        );

        Ok(ContainerLaunchSpec {
            container_name,
            image: input.image.clone(),
            entrypoint: vec![
                "/usr/local/bin/arima-shim".into(),
                "run".into(),
                "--state-file".into(),
                "/run/arima/shim-state.json".into(),
                "--agent".into(),
                agent.to_owned(),
                "--program".into(),
                prog.to_owned(),
                "--".into(),
            ],
            cmd: input.args.clone(),
            cpus,
            nano_cpus,
            memory_mb,
            memory_bytes,
            pids_limit: 512,
            network_name: "br-hq".into(),
            fixed_ipv4,
            tmpfs_mounts,
            env_list,
            secret_delivery: SecretDelivery::TmpfsMemory {
                mount_path: "/run/arima/secrets".into(),
            },
        })
    }
}
