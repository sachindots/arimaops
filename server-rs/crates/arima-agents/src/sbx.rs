// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};

use crate::{
    AgentError, Result, DEFAULT_CONTAINER_CPUS, DEFAULT_CONTAINER_MEMORY_GB,
    DEFAULT_CONTAINER_MEMORY_MB,
};

/// Safe `sbx` microVM sandbox command specification with mandatory CPU/RAM defaults
/// (`2 CPU / 2048 MB`) and stdin-only secret injection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SbxCommandSpec {
    pub binary: String,
    pub argv: Vec<String>,
    pub stdin_secret: Option<String>,
    pub cpus: u32,
    pub memory_mb: u32,
}

/// Adapter for constructing safe `sbx` CLI invocations with zero shell interpolation.
#[derive(Debug, Clone)]
pub struct SbxAdapter {
    binary_path: String,
}

impl Default for SbxAdapter {
    fn default() -> Self {
        Self::new("sbx")
    }
}

impl SbxAdapter {
    #[must_use]
    pub fn new(binary_path: impl Into<String>) -> Self {
        Self {
            binary_path: binary_path.into(),
        }
    }

    /// Builds a `sbx run` command spec enforcing default `cpus: 2` and `memory_mb: 2048` (`2 GB`)
    /// whenever unset (`None` or `0`).
    pub fn build_run_command(
        &self,
        sandbox_name: &str,
        cpus: Option<u32>,
        memory_gb: Option<u32>,
        agent_cli: &str,
        cli_args: &[String],
    ) -> Result<SbxCommandSpec> {
        if sandbox_name.trim().is_empty()
            || !sandbox_name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(AgentError::InvalidConfig(format!(
                "invalid sandbox name '{sandbox_name}'"
            )));
        }
        if agent_cli.trim().is_empty() {
            return Err(AgentError::InvalidConfig(
                "agent CLI binary cannot be empty".into(),
            ));
        }

        let effective_cpus = cpus.filter(|&c| c > 0).unwrap_or(DEFAULT_CONTAINER_CPUS);
        let effective_mem_gb = memory_gb
            .filter(|&m| m > 0)
            .unwrap_or(DEFAULT_CONTAINER_MEMORY_GB);
        let effective_mem_mb = effective_mem_gb
            .saturating_mul(1024)
            .max(DEFAULT_CONTAINER_MEMORY_MB);

        let mut argv = vec![
            "run".into(),
            "--name".into(),
            sandbox_name.to_owned(),
            "--cpus".into(),
            effective_cpus.to_string(),
            "--memory".into(),
            format!("{effective_mem_mb}M"),
            "--".into(),
            agent_cli.to_owned(),
        ];
        argv.extend_from_slice(cli_args);

        Ok(SbxCommandSpec {
            binary: self.binary_path.clone(),
            argv,
            stdin_secret: None,
            cpus: effective_cpus,
            memory_mb: effective_mem_mb,
        })
    }

    /// Builds a `sbx secret set` command that passes the secret value strictly over `stdin`
    /// and never places the secret on `argv`.
    pub fn build_set_secret_command(
        &self,
        sandbox_name: Option<&str>,
        service: &str,
        secret_value: &str,
    ) -> Result<SbxCommandSpec> {
        if service.trim().is_empty() {
            return Err(AgentError::InvalidConfig(
                "service name cannot be empty".into(),
            ));
        }
        if secret_value.is_empty() {
            return Err(AgentError::InvalidConfig(
                "secret value cannot be empty".into(),
            ));
        }

        let mut argv = vec!["secret".into(), "set".into()];
        if let Some(sbx) = sandbox_name {
            argv.push("--sandbox".into());
            argv.push(sbx.to_owned());
        }
        argv.push(service.to_owned());
        argv.push("--stdin".into());

        Ok(SbxCommandSpec {
            binary: self.binary_path.clone(),
            argv,
            stdin_secret: Some(secret_value.to_owned()),
            cpus: DEFAULT_CONTAINER_CPUS,
            memory_mb: DEFAULT_CONTAINER_MEMORY_MB,
        })
    }
}
