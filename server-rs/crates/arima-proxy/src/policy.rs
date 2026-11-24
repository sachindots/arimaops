// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::ip_guard::is_imds_or_link_local_ip;

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("filesystem or network error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid proxy target: {0}")]
    InvalidTarget(String),
    #[error("policy error: {0}")]
    Policy(String),
}

/// Container identity mapped in-memory by HQ when launching containers on `br-hq`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerIdentity {
    pub project_id: String,
    pub agent_id: String,
    pub container_name: String,
}

/// Lock-free/low-contention in-memory registry replacing `docker network inspect` polling.
#[derive(Debug, Clone, Default)]
pub struct ContainerIpRegistry {
    map: Arc<RwLock<HashMap<IpAddr, ContainerIdentity>>>,
}

impl ContainerIpRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, ip: IpAddr, identity: ContainerIdentity) {
        if let Ok(mut guard) = self.map.write() {
            guard.insert(ip, identity);
        }
    }

    pub fn unregister(&self, ip: IpAddr) {
        if let Ok(mut guard) = self.map.write() {
            guard.remove(&ip);
        }
    }

    #[must_use]
    pub fn identify(&self, ip: IpAddr) -> Option<ContainerIdentity> {
        self.map.read().ok().and_then(|g| g.get(&ip).cloned())
    }
}

/// Per-agent proxy credentials HQ issues at each start. The proxy names its caller by the credential in the
/// proxy URL (`http://<agent>:<token>@hq:<port>`), never by source IP.
#[derive(Debug, Clone, Default)]
pub struct ProxyCredentials {
    /// SHA-256 hex of the token to the agent it names.
    map: Arc<RwLock<HashMap<String, ContainerIdentity>>>,
}

fn token_digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

impl ProxyCredentials {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A fresh token for this agent; any earlier one for the same project and agent stops working.
    pub fn issue(&self, identity: ContainerIdentity) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut map) = self.map.write() {
            map.retain(|_, id| !(id.project_id == identity.project_id && id.agent_id == identity.agent_id));
            map.insert(token_digest(&token), identity);
        }
        token
    }

    pub fn revoke(&self, project_id: &str, agent_id: &str) {
        if let Ok(mut map) = self.map.write() {
            map.retain(|_, id| !(id.project_id == project_id && id.agent_id == agent_id));
        }
    }

    /// The agent this credential names, if the token is current and the user name is that agent.
    #[must_use]
    pub fn identify(&self, user: &str, token: &str) -> Option<ContainerIdentity> {
        let id = self.map.read().ok()?.get(&token_digest(token)).cloned()?;
        (id.agent_id == user).then_some(id)
    }
}

/// Effective egress allow/deny policy evaluated for a single container or test peer.
#[derive(Debug, Clone, Default)]
pub struct EgressPolicy {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub scope_allow_targets: Vec<String>,
    pub drafts_only: bool,
    pub outbound_hosts: Vec<String>,
    pub allow_unknown_loopback_peer: bool,
    /// Observe mode: a request the policy would refuse goes through and is reported to
    /// [`PolicyProvider::record_would_block`] instead. Off (enforce), it is refused and reported to
    /// [`PolicyProvider::record_blocked`]. Private addresses are refused in both modes unless the host is
    /// explicitly scoped or in [`Self::private_allow`].
    pub observe: bool,
    /// Hosts the owner named in an explicit rule, which may resolve to a private (never loopback or metadata)
    /// address. Anything else reaching a private address goes nowhere: HQ sits on networks agents don't share,
    /// such as other projects' internal networks.
    pub private_allow: Vec<String>,
    /// Hosts the CLIs call on their own (telemetry): never reported.
    pub quiet: Vec<String>,
}

pub trait PolicyProvider: Send + Sync {
    fn policy_for<'a>(
        &'a self,
        peer_ip: IpAddr,
        identity: Option<&'a ContainerIdentity>,
    ) -> Pin<Box<dyn Future<Output = Option<EgressPolicy>> + Send + 'a>>;

    /// An observe-mode request that enforce would have refused.
    fn record_would_block(&self, _identity: &ContainerIdentity, _host: &str, _port: u16) {}

    /// An enforce-mode request refused because its host isn't listed (quiet hosts aren't reported).
    fn record_blocked(&self, _identity: &ContainerIdentity, _host: &str, _port: u16) {}
}

/// Simple static policy provider for deterministic setups and tests.
#[derive(Debug, Clone)]
pub struct StaticPolicyProvider {
    pub policy: EgressPolicy,
}

impl PolicyProvider for StaticPolicyProvider {
    fn policy_for<'a>(
        &'a self,
        peer_ip: IpAddr,
        identity: Option<&'a ContainerIdentity>,
    ) -> Pin<Box<dyn Future<Output = Option<EgressPolicy>> + Send + 'a>> {
        Box::pin(async move {
            if identity.is_some() || (self.policy.allow_unknown_loopback_peer && peer_ip.is_loopback())
            {
                Some(self.policy.clone())
            } else {
                None
            }
        })
    }
}

/// Result of evaluating a target against a project's synchronized security scope & egress policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeCheckResult {
    pub target: String,
    pub host: String,
    pub port: u16,
    pub allowed: bool,
    pub in_scope: bool,
    pub out_of_scope: bool,
    pub blocked_imds: bool,
    pub reason: String,
}

/// Live per-project policy provider synchronized whenever an Owner updates engagement scope.
///
/// Unconditionally denies cloud IMDS / link-local targets (`169.254.0.0/16`, `fe80::/10`,
/// `fd00:ec2::254`, `metadata.google.internal`) even if an operator attempts to add them to scope.
#[derive(Debug, Clone)]
pub struct DynamicScopePolicyProvider {
    projects: Arc<RwLock<HashMap<String, EgressPolicy>>>,
    default_policy: Arc<RwLock<EgressPolicy>>,
}

impl Default for DynamicScopePolicyProvider {
    fn default() -> Self {
        Self::new(EgressPolicy::default())
    }
}

impl DynamicScopePolicyProvider {
    #[must_use]
    pub fn new(default_policy: EgressPolicy) -> Self {
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            default_policy: Arc::new(RwLock::new(default_policy)),
        }
    }

    /// Synchronizes a project's engagement `in_scope` and `out_of_scope` targets into its live
    /// [`EgressPolicy`], returning any IMDS / link-local entries that were forcefully stripped.
    pub fn sync_project_scope(
        &self,
        project_id: &str,
        in_scope: &[String],
        out_of_scope: &[String],
        allow_unknown_loopback_peer: bool,
    ) -> Vec<String> {
        let mut sanitized_allow = Vec::new();
        let mut stripped_imds = Vec::new();

        for raw in in_scope {
            if let Some(norm) = normalize_scope_rule(raw) {
                let (host, _) = split_rule_host_port(&norm);
                if is_imds_host_literal(host) {
                    stripped_imds.push(raw.trim().to_owned());
                    continue;
                }
                if !sanitized_allow.contains(&norm) {
                    sanitized_allow.push(norm);
                }
            }
        }

        let mut deny = vec![
            "169.254.169.254".to_owned(),
            "metadata.google.internal".to_owned(),
            "metadata.goog".to_owned(),
            "fd00:ec2::254".to_owned(),
        ];
        for raw in out_of_scope {
            if let Some(norm) = normalize_scope_rule(raw) {
                if !deny.contains(&norm) {
                    deny.push(norm);
                }
            }
        }

        let base_allow = self
            .default_policy
            .read()
            .map(|p| p.allow.clone())
            .unwrap_or_default();
        let policy = EgressPolicy {
            allow: base_allow,
            deny,
            scope_allow_targets: sanitized_allow,
            drafts_only: false,
            outbound_hosts: vec![],
            allow_unknown_loopback_peer,
            ..EgressPolicy::default()
        };

        if let Ok(mut guard) = self.projects.write() {
            guard.insert(project_id.to_owned(), policy);
        }
        stripped_imds
    }

    #[must_use]
    pub fn policy_for_project(&self, project_id: &str) -> Option<EgressPolicy> {
        self.projects
            .read()
            .ok()
            .and_then(|g| g.get(project_id).cloned())
    }

    /// Evaluates a raw target (URL, `host:port`, or bare host) against the project's live scope.
    #[must_use]
    pub fn check_target(&self, project_id: &str, target: &str) -> ScopeCheckResult {
        let Some((host, port)) = parse_target_host_port(target) else {
            return ScopeCheckResult {
                target: target.to_owned(),
                host: String::new(),
                port: 0,
                allowed: false,
                in_scope: false,
                out_of_scope: false,
                blocked_imds: false,
                reason: "invalid target host or URL".into(),
            };
        };

        if is_imds_host_literal(&host) {
            return ScopeCheckResult {
                target: target.to_owned(),
                host,
                port,
                allowed: false,
                in_scope: false,
                out_of_scope: true,
                blocked_imds: true,
                reason: "cloud metadata / link-local address is unconditionally blocked".into(),
            };
        }

        let policy = self
            .policy_for_project(project_id)
            .or_else(|| self.default_policy.read().ok().map(|p| p.clone()))
            .unwrap_or_default();

        if host_matches(&policy.deny, &host, port) || host_matches_scope(&policy.deny, &host, port) {
            return ScopeCheckResult {
                target: target.to_owned(),
                host,
                port,
                allowed: false,
                in_scope: false,
                out_of_scope: true,
                blocked_imds: false,
                reason: "target is explicitly out of scope".into(),
            };
        }

        if host_matches_scope(&policy.scope_allow_targets, &host, port) {
            return ScopeCheckResult {
                target: target.to_owned(),
                host,
                port,
                allowed: true,
                in_scope: true,
                out_of_scope: false,
                blocked_imds: false,
                reason: "target matches in-scope rules".into(),
            };
        }

        ScopeCheckResult {
            target: target.to_owned(),
            host,
            port,
            allowed: false,
            in_scope: false,
            out_of_scope: false,
            blocked_imds: false,
            reason: "target is not in the project's approved scope".into(),
        }
    }
}

impl PolicyProvider for DynamicScopePolicyProvider {
    fn policy_for<'a>(
        &'a self,
        peer_ip: IpAddr,
        identity: Option<&'a ContainerIdentity>,
    ) -> Pin<Box<dyn Future<Output = Option<EgressPolicy>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(ident) = identity {
                if let Some(proj_policy) = self.policy_for_project(&ident.project_id) {
                    return Some(proj_policy);
                }
                return self.default_policy.read().ok().map(|p| p.clone());
            }
            if peer_ip.is_loopback() {
                if let Ok(guard) = self.projects.read() {
                    if let Some(p) = guard.values().find(|p| p.allow_unknown_loopback_peer) {
                        return Some(p.clone());
                    }
                }
                if let Ok(default) = self.default_policy.read() {
                    if default.allow_unknown_loopback_peer {
                        return Some(default.clone());
                    }
                }
            }
            None
        })
    }
}

/// Returns `true` if `host` is a literal cloud IMDS / link-local IP or metadata hostname.
#[must_use]
pub fn is_imds_host_literal(host: &str) -> bool {
    let clean = normalize_host(host);
    if clean.is_empty() {
        return false;
    }
    if matches!(
        clean.as_str(),
        "metadata.google.internal" | "metadata.goog" | "instance-data"
    ) {
        return true;
    }
    if clean.starts_with("169.254.") || clean.starts_with("fe80:") || clean.starts_with("fe80%") {
        return true;
    }
    // Strip optional IPv6 zone index (`fe80::1%eth0`).
    let without_zone = clean.split('%').next().unwrap_or(&clean);
    if let Ok(ip) = without_zone.parse::<IpAddr>() {
        return is_imds_or_link_local_ip(ip);
    }
    false
}

/// Normalizes a scope entry (URL, `host:port`, `[ipv6]:port`, or `*.domain`) into a canonical host/port rule.
#[must_use]
pub fn normalize_scope_rule(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let authority = stripped.split('/').next().unwrap_or("").trim();
    if authority.is_empty() {
        return None;
    }
    let (host, port) = split_rule_host_port(authority);
    let clean_host = normalize_host(host);
    if clean_host.is_empty() {
        return None;
    }
    if clean_host.contains(':') {
        match port {
            Some(p) => Some(format!("[{clean_host}]:{p}")),
            None => Some(format!("[{clean_host}]")),
        }
    } else {
        match port {
            Some(p) => Some(format!("{clean_host}:{p}")),
            None => Some(clean_host),
        }
    }
}

fn parse_target_host_port(raw: &str) -> Option<(String, u16)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (default_port, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        (443u16, r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        (80u16, r)
    } else {
        (443u16, trimmed)
    };
    let authority = rest.split('/').next().unwrap_or("").trim();
    if authority.is_empty() {
        return None;
    }
    let (host, explicit_port) = split_rule_host_port(authority);
    let clean_host = normalize_host(host);
    if clean_host.is_empty() {
        return None;
    }
    Some((clean_host, explicit_port.unwrap_or(default_port)))
}

/// Parses `CONNECT` authority (`host:port`, `[ipv6]:port`, or bare `host`/`[ipv6]`).
pub fn parse_connect_authority(raw: &str) -> Result<(String, u16), ProxyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProxyError::InvalidTarget("empty authority".into()));
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        let Some((ip_part, after_bracket)) = rest.split_once(']') else {
            return Err(ProxyError::InvalidTarget(format!("unclosed IPv6 bracket: {trimmed}")));
        };
        if ip_part.is_empty() {
            return Err(ProxyError::InvalidTarget("empty IPv6 literal".into()));
        }
        let port = if after_bracket.is_empty() {
            443
        } else if let Some(port_str) = after_bracket.strip_prefix(':') {
            parse_port(port_str)?
        } else {
            return Err(ProxyError::InvalidTarget(format!("bad IPv6 authority: {trimmed}")));
        };
        return Ok((ip_part.to_owned(), port));
    }

    if let Some((host, port_str)) = trimmed.rsplit_once(':') {
        if host.contains(':') {
            // Unbracketed IPv6 literal without explicit port.
            return Ok((trimmed.to_owned(), 443));
        }
        if host.is_empty() {
            return Err(ProxyError::InvalidTarget("empty host".into()));
        }
        return Ok((normalize_host(host), parse_port(port_str)?));
    }

    Ok((normalize_host(trimmed), 443))
}

fn parse_port(raw: &str) -> Result<u16, ProxyError> {
    let port: u16 = raw
        .parse()
        .map_err(|_| ProxyError::InvalidTarget(format!("invalid port: {raw}")))?;
    if port == 0 {
        return Err(ProxyError::InvalidTarget("port 0 not allowed".into()));
    }
    Ok(port)
}

#[must_use]
pub fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// Matches rules (`example.com`, `*.example.com`, `host:port`, `[::1]:443`).
/// Bare host rules default to HTTP/HTTPS ports (`80` and `443`).
#[must_use]
pub fn host_matches(rules: &[String], host: &str, port: u16) -> bool {
    host_matches_internal(rules, host, port, false)
}

/// Same as [`host_matches`], except bare scope targets (without `:port`) match any port.
#[must_use]
pub fn host_matches_scope(rules: &[String], host: &str, port: u16) -> bool {
    host_matches_internal(rules, host, port, true)
}

fn host_matches_internal(rules: &[String], host: &str, port: u16, allow_any_port: bool) -> bool {
    let h = normalize_host(host);
    rules.iter().any(|raw| {
        let trimmed = raw.trim();
        let (pattern, rule_port) = split_rule_host_port(trimmed);
        if let Some(rp) = rule_port {
            if rp != port {
                return false;
            }
        } else if !allow_any_port && port != 80 && port != 443 {
            return false;
        }
        let pat = normalize_host(pattern);
        if let Some(suffix) = pat.strip_prefix("*.") {
            !suffix.is_empty() && (h == suffix || h.ends_with(&format!(".{suffix}")))
        } else {
            h == pat
        }
    })
}

fn split_rule_host_port(rule: &str) -> (&str, Option<u16>) {
    if let Some(rest) = rule.strip_prefix('[') {
        if let Some((ip_part, after)) = rest.split_once(']') {
            if let Some(p) = after.strip_prefix(':') {
                if let Ok(port) = p.parse::<u16>() {
                    return (ip_part, Some(port));
                }
            }
            return (ip_part, None);
        }
    }
    if let Some((host, p)) = rule.rsplit_once(':') {
        if !host.contains(':') {
            if let Ok(port) = p.parse::<u16>() {
                return (host, Some(port));
            }
        }
    }
    (rule, None)
}
