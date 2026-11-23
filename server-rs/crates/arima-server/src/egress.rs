// SPDX-License-Identifier: AGPL-3.0-or-later

//! Agent egress: each project's mode, the policy an agent gets at start, its proxy credential, and the hosts
//! enforce mode would block. Agents reach the internet through HQ's egress proxy, which names them by the
//! credential in their proxy URL.
//!
//! shortcut: `enforce` is stored but behaves like `observe` until agents move to an internal network (step 3c).

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::RwLock;

use arima_db::DbError;
use arima_proxy::{is_imds_host_literal, normalize_scope_rule, ContainerIdentity, EgressPolicy, PolicyProvider, ProxyCredentials};
use chrono::{TimeZone, Utc};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::state::AppState;

/// Git over HTTPS and the package registries (npm, PyPI, crates.io, Go proxy, Docker Hub), for every agent.
pub const BASE: &[&str] = &[
    "github.com", "*.github.com", "*.githubusercontent.com", "gitlab.com", "*.gitlab.com", "bitbucket.org", "*.bitbucket.org",
    "registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com",
    "pypi.org", "files.pythonhosted.org",
    "crates.io", "*.crates.io",
    "proxy.golang.org", "sum.golang.org",
    "*.docker.io", "production.cloudflare.docker.com",
];

/// Hosts the CLIs call on their own (telemetry, crash reports, profile pictures): never needed for the work, never recorded.
pub const QUIET: &[&str] = &["*.datadoghq.com", "*.datadoghq.eu", "*.sentry.io", "*.statsig.com", "api.segment.io", "lh3.googleusercontent.com"];

/// Cloud metadata, denied whatever else says (the proxy also refuses link-local addresses outright).
const METADATA: &[&str] = &["169.254.169.254", "metadata.google.internal", "metadata.goog"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressMode {
    /// No proxy: agents go straight out, as before observe mode.
    Off,
    /// Everything goes through; each host enforce would block is recorded.
    Observe,
    /// Stored, and for now the same as observe.
    Enforce,
}

impl EgressMode {
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Self::Off),
            "observe" => Some(Self::Observe),
            "enforce" => Some(Self::Enforce),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Observe => "observe",
            Self::Enforce => "enforce",
        }
    }
}

#[must_use]
pub fn mode(state: &AppState, project_id: &str) -> EgressMode {
    state
        .inner
        .db
        .read(|conn| conn.query_row("SELECT egress_mode FROM projects WHERE id = ?1", [project_id], |r| r.get::<_, String>(0)).optional().map_err(DbError::from))
        .ok()
        .flatten()
        .and_then(|m| EgressMode::parse(&m))
        .unwrap_or(EgressMode::Observe)
}

#[must_use]
pub fn project_rules(state: &AppState, project_id: &str) -> Vec<String> {
    state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare("SELECT rule FROM egress_rules WHERE project_id = ?1 ORDER BY rule")?;
            let rows = stmt.query_map([project_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok::<_, DbError>(rows)
        })
        .unwrap_or_default()
}

/// The policy an agent gets at start, never stored: the shared base, its CLI's hosts, the project's rules and
/// the seat's own allow list; the seat's deny list and cloud metadata are denied.
#[must_use]
pub fn policy(cli_egress: &[&str], project_rules: &[String], seat: &Value) -> EgressPolicy {
    let seat_list = |key: &str| seat["sandbox"][key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let mut allow: Vec<String> = BASE.iter().chain(cli_egress).map(|h| (*h).to_owned()).collect();
    allow.extend(project_rules.iter().cloned());
    allow.extend(seat_list("allow"));
    let mut deny: Vec<String> = METADATA.iter().map(|h| (*h).to_owned()).collect();
    deny.extend(seat_list("deny"));
    EgressPolicy { allow, deny, quiet: QUIET.iter().map(|h| (*h).to_owned()).collect(), observe: true, ..EgressPolicy::default() }
}

/// The proxy variables for one agent's container. Node's own `fetch` ignores the proxy without `NODE_USE_ENV_PROXY`.
#[must_use]
pub fn proxy_env(hq_url: &str, port: u16, agent_id: &str, token: &str) -> Vec<(String, String)> {
    let Some(host) = url::Url::parse(hq_url).ok().and_then(|u| u.host_str().map(str::to_owned)) else { return Vec::new() };
    let proxy = format!("http://{agent_id}:{token}@{host}:{port}");
    // Private ranges stay direct for clients that read CIDR entries, as they were before the proxy.
    let no_proxy = format!("localhost,127.0.0.1,::1,{},10.0.0.0/8,172.16.0.0/12,192.168.0.0/16", host.trim_matches(['[', ']']));
    let mut env: Vec<(String, String)> = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].iter().map(|k| ((*k).to_owned(), proxy.clone())).collect();
    env.extend([("NO_PROXY".to_owned(), no_proxy.clone()), ("no_proxy".to_owned(), no_proxy), ("NODE_USE_ENV_PROXY".to_owned(), "1".to_owned())]);
    env
}

/// The running agents' proxy credentials and the policy each got at start.
#[derive(Default)]
pub struct AgentEgress {
    pub credentials: ProxyCredentials,
    policies: RwLock<HashMap<(String, String), EgressPolicy>>,
}

impl AgentEgress {
    /// Lets an agent through the proxy with this policy; returns its credential's token.
    pub fn admit(&self, project_id: &str, agent_id: &str, container: &str, policy: EgressPolicy) -> String {
        if let Ok(mut map) = self.policies.write() {
            map.insert((project_id.to_owned(), agent_id.to_owned()), policy);
        }
        self.credentials.issue(ContainerIdentity { project_id: project_id.to_owned(), agent_id: agent_id.to_owned(), container_name: container.to_owned() })
    }

    pub fn revoke(&self, project_id: &str, agent_id: &str) {
        self.credentials.revoke(project_id, agent_id);
        if let Ok(mut map) = self.policies.write() {
            map.remove(&(project_id.to_owned(), agent_id.to_owned()));
        }
    }

    fn policy(&self, project_id: &str, agent_id: &str) -> Option<EgressPolicy> {
        self.policies.read().ok()?.get(&(project_id.to_owned(), agent_id.to_owned())).cloned()
    }

    /// A rule the owner just allowed applies to the project's running agents at once, not only at their next start.
    fn allow_running(&self, project_id: &str, rule: &str) {
        if let Ok(mut map) = self.policies.write() {
            for ((p, _), policy) in map.iter_mut() {
                if p == project_id && !policy.allow.iter().any(|r| r == rule) {
                    policy.allow.push(rule.to_owned());
                }
            }
        }
    }
}

/// What HQ's egress proxy asks: the caller's policy (plus the project's engagement scope) and where to record.
pub struct ProxyPolicy(pub AppState);

impl PolicyProvider for ProxyPolicy {
    fn policy_for<'a>(&'a self, _peer_ip: IpAddr, identity: Option<&'a ContainerIdentity>) -> Pin<Box<dyn Future<Output = Option<EgressPolicy>> + Send + 'a>> {
        Box::pin(async move {
            let id = identity?;
            let mut policy = self.0.inner.egress.policy(&id.project_id, &id.agent_id)?;
            if let Some(scope) = self.0.inner.egress_policy.policy_for_project(&id.project_id) {
                policy.scope_allow_targets = scope.scope_allow_targets;
                policy.deny.extend(scope.deny);
            }
            // Read per request, so an approved or removed pack's hosts apply to running agents at once.
            policy.allow.extend(crate::packs::egress_hosts(&self.0, &id.project_id));
            Some(policy)
        })
    }

    fn record_would_block(&self, identity: &ContainerIdentity, host: &str, port: u16) {
        if record(&self.0, &identity.project_id, &identity.agent_id, host, port) {
            broadcast(&self.0, &identity.project_id);
        }
    }
}

/// Counts one request enforce would block; true when the host is new for this agent.
pub fn record(state: &AppState, project_id: &str, agent_id: &str, host: &str, port: u16) -> bool {
    let now = Utc::now().timestamp_millis();
    let count = state.inner.db.transaction(|conn| {
        conn.query_row(
            "INSERT INTO egress_would_block (project_id, agent_id, host, port, count, first_seen, last_seen, ignored)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, EXISTS(SELECT 1 FROM egress_would_block WHERE project_id = ?1 AND host = ?3 AND port = ?4 AND ignored = 1))
             ON CONFLICT(project_id, agent_id, host, port) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen
             RETURNING count",
            rusqlite::params![project_id, agent_id, host, port, now],
            |r| r.get::<_, i64>(0),
        )
        .map_err(DbError::from)
    });
    match count {
        Ok(n) => n == 1,
        Err(e) => {
            tracing::warn!(project_id, agent_id, host, "couldn't record a would-block host: {e}");
            false
        }
    }
}

fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().map_or_else(String::new, |d| d.to_rfc3339())
}

/// The egress part of the snapshot: the mode, the project's rules, and the hosts enforce would block (not ignored).
#[must_use]
pub fn snapshot(state: &AppState, project_id: &str) -> Value {
    // A host no grant declares, reached by an agent that uses a pack, is flagged with that pack.
    let by_agent = crate::packs::packs_by_agent(state, project_id);
    let rows = state
        .inner
        .db
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT host, port, group_concat(agent_id, ','), SUM(count), MIN(first_seen), MAX(last_seen) FROM egress_would_block
                 WHERE project_id = ?1 AND ignored = 0 GROUP BY host, port ORDER BY MAX(last_seen) DESC LIMIT 200",
            )?;
            let rows = stmt
                .query_map([project_id], |r| {
                    let agents: String = r.get(2)?;
                    let mut packs: Vec<&String> = agents.split(',').filter_map(|a| by_agent.get(a)).flatten().collect();
                    packs.sort();
                    packs.dedup();
                    Ok(json!({
                        "host": r.get::<_, String>(0)?, "port": r.get::<_, i64>(1)?,
                        "agents": agents.split(',').collect::<Vec<_>>(), "count": r.get::<_, i64>(3)?,
                        "firstSeen": iso(r.get(4)?), "lastSeen": iso(r.get(5)?), "packs": packs,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok::<_, DbError>(rows)
        })
        .unwrap_or_default();
    json!({ "mode": mode(state, project_id).as_str(), "rules": project_rules(state, project_id), "wouldBlock": rows })
}

fn broadcast(state: &AppState, project_id: &str) {
    let snapshot = crate::ws::build_initial_snapshot(state, Some(project_id));
    state.inner.ws_hub.broadcast_snapshot(project_id, &snapshot);
}

fn host_port(args: &[Value]) -> Result<(String, u16), String> {
    let host = args.first().and_then(Value::as_str).map(str::trim).unwrap_or("").to_ascii_lowercase();
    let port = args.get(1).and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).ok_or("A port is required.")?;
    if host.is_empty() || host.len() > 253 || host.contains(['/', ' ', '@']) {
        return Err("That isn't a host name.".into());
    }
    Ok((host, port))
}

/// `setEgressMode [mode]` (owner only). Applies at each agent's next start.
pub fn set_mode(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let mode = args.first().and_then(Value::as_str).and_then(EgressMode::parse).ok_or("The mode is off, observe or enforce.")?;
    state
        .inner
        .db
        .transaction(|conn| conn.execute("UPDATE projects SET egress_mode = ?1 WHERE id = ?2", rusqlite::params![mode.as_str(), project_id]).map_err(DbError::from))
        .map_err(|e| e.to_string())?;
    broadcast(state, project_id);
    Ok(())
}

/// `allowEgressHost [host, port]` (owner only): a project rule for that host, which drops it from the list.
pub fn allow_host(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let (host, port) = host_port(args)?;
    let raw = if matches!(port, 80 | 443) { host.clone() } else { format!("{host}:{port}") };
    let rule = normalize_scope_rule(&raw).filter(|_| !is_imds_host_literal(&host)).ok_or("That host can't be allowed.")?;
    state
        .inner
        .db
        .transaction(|conn| {
            conn.execute("INSERT OR IGNORE INTO egress_rules (project_id, rule, created_at) VALUES (?1, ?2, ?3)", rusqlite::params![project_id, rule, Utc::now().timestamp_millis()])?;
            conn.execute("DELETE FROM egress_would_block WHERE project_id = ?1 AND host = ?2 AND port = ?3", rusqlite::params![project_id, host, port])?;
            Ok::<_, DbError>(())
        })
        .map_err(|e| e.to_string())?;
    state.inner.egress.allow_running(project_id, &rule);
    broadcast(state, project_id);
    Ok(())
}

/// `removeEgressRule [rule]` (owner only). Running agents keep it until their next start.
pub fn remove_rule(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let rule = args.first().and_then(Value::as_str).unwrap_or("");
    state
        .inner
        .db
        .transaction(|conn| conn.execute("DELETE FROM egress_rules WHERE project_id = ?1 AND rule = ?2", rusqlite::params![project_id, rule]).map_err(DbError::from))
        .map_err(|e| e.to_string())?;
    broadcast(state, project_id);
    Ok(())
}

/// `ignoreEgressHost [host, port]` (owner only): hidden from the list for every agent; still counted.
pub fn ignore_host(state: &AppState, project_id: &str, args: &[Value]) -> Result<(), String> {
    let (host, port) = host_port(args)?;
    state
        .inner
        .db
        .transaction(|conn| conn.execute("UPDATE egress_would_block SET ignored = 1 WHERE project_id = ?1 AND host = ?2 AND port = ?3", rusqlite::params![project_id, host, port]).map_err(DbError::from))
        .map_err(|e| e.to_string())?;
    broadcast(state, project_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arima_proxy::host_matches;

    fn demo() -> (AppState, String) {
        let state = AppState::new(arima_db::Db::open_in_memory().unwrap(), arima_auth::VaultKey::from_bytes([7u8; 32]), crate::ServerConfig::default());
        state.ensure_default_project("Demo", "demo", "/w/demo").unwrap();
        let pid = state.default_project().unwrap().0;
        (state, pid)
    }

    #[test]
    fn the_policy_joins_base_cli_project_and_seat_rules() {
        let seat = json!({ "sandbox": { "allow": ["api.stripe.com"], "deny": ["registry.npmjs.org"] } });
        let p = policy(crate::cli::adapter("claude").unwrap().egress, &["auth.example.dev:8443".into()], &seat);
        let allowed = |h: &str, port| host_matches(&p.allow, h, port);
        assert!(allowed("api.anthropic.com", 443) && allowed("github.com", 443) && allowed("index.crates.io", 443) && allowed("proxy.golang.org", 443));
        assert!(allowed("registry-1.docker.io", 443) && allowed("files.pythonhosted.org", 443));
        assert!(allowed("api.stripe.com", 443) && allowed("auth.example.dev", 8443) && !allowed("auth.example.dev", 443));
        assert!(!allowed("api.openai.com", 443), "another CLI's hosts aren't in this one's policy");
        assert!(host_matches(&p.deny, "registry.npmjs.org", 443) && host_matches(&p.deny, "169.254.169.254", 80), "seat deny and metadata");
        assert!(host_matches(&p.quiet, "o123.ingest.sentry.io", 443) && p.observe);
        for a in &crate::cli::ADAPTERS {
            assert!(!a.egress.is_empty(), "{} lists its provider hosts", a.id);
        }
    }

    #[test]
    fn projects_start_in_observe_and_would_blocks_are_counted_allowed_and_ignored() {
        let (state, pid) = demo();
        assert_eq!(mode(&state, &pid), EgressMode::Observe);
        assert!(set_mode(&state, &pid, &[json!("lockdown")]).is_err());
        set_mode(&state, &pid, &[json!("enforce")]).unwrap();
        assert_eq!(mode(&state, &pid), EgressMode::Enforce);

        assert!(record(&state, &pid, "ada", "api.stripe.com", 443), "first sighting");
        assert!(!record(&state, &pid, "ada", "api.stripe.com", 443));
        assert!(record(&state, &pid, "grace", "api.stripe.com", 443));
        assert!(record(&state, &pid, "ada", "telemetry.example", 443));
        let snap = snapshot(&state, &pid);
        let stripe = snap["wouldBlock"].as_array().unwrap().iter().find(|r| r["host"] == "api.stripe.com").unwrap().clone();
        assert_eq!((stripe["count"].clone(), stripe["port"].clone()), (json!(3), json!(443)));
        assert_eq!(stripe["agents"].as_array().unwrap().len(), 2);
        assert!(!stripe["firstSeen"].as_str().unwrap().is_empty());

        let token = state.inner.egress.admit(&pid, "ada", "hq-demo-ada", policy(&[], &[], &json!({})));
        assert!(state.inner.egress.credentials.identify("ada", &token).is_some());
        allow_host(&state, &pid, &[json!("api.stripe.com"), json!(443)]).unwrap();
        assert_eq!(project_rules(&state, &pid), ["api.stripe.com"]);
        assert!(host_matches(&state.inner.egress.policy(&pid, "ada").unwrap().allow, "api.stripe.com", 443), "a running agent gets the rule at once");
        assert!(allow_host(&state, &pid, &[json!("169.254.169.254"), json!(80)]).is_err());

        ignore_host(&state, &pid, &[json!("telemetry.example"), json!(443)]).unwrap();
        assert!(record(&state, &pid, "grace", "telemetry.example", 443), "a new agent's row inherits the ignore");
        assert_eq!(snapshot(&state, &pid)["wouldBlock"], json!([]));

        remove_rule(&state, &pid, &[json!("api.stripe.com")]).unwrap();
        assert!(project_rules(&state, &pid).is_empty());
        state.inner.egress.revoke(&pid, "ada");
        assert!(state.inner.egress.credentials.identify("ada", &token).is_none());
    }

    #[test]
    fn proxy_env_names_the_agent_and_keeps_hq_direct() {
        let env: HashMap<String, String> = proxy_env("http://arima-hq:7420", 8420, "ada", "tok").into_iter().collect();
        assert_eq!(env["HTTPS_PROXY"], "http://ada:tok@arima-hq:8420");
        assert_eq!(env["http_proxy"], env["HTTPS_PROXY"]);
        assert!(env["NO_PROXY"].split(',').any(|h| h == "arima-hq") && env["no_proxy"].contains("localhost"));
        assert_eq!(env["NODE_USE_ENV_PROXY"], "1");
    }
}
