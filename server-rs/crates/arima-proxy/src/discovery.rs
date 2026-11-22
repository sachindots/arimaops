// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use arima_core::{PreviewMode, PreviewTarget, PreviewTargetStatus};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;

use crate::policy::ContainerIpRegistry;

/// Normalizes a configured wildcard preview base domain (e.g. `"*.Example.com"` -> `"example.com"`).
#[must_use]
pub fn normalize_preview_domain(raw: &str) -> Option<String> {
    let trimmed = raw
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .trim_start_matches("*.")
        .trim_start_matches('.');
    if trimmed.is_empty()
        || !trimmed.contains('.')
        || trimmed.len() > 200
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// Builds a wildcard subdomain preview origin `https://preview-<slug>.<domain>` (or `http://`).
#[must_use]
pub fn build_subdomain_preview_origin(slug: &str, preview_domain: &str, https: bool) -> Option<String> {
    let domain = normalize_preview_domain(preview_domain)?;
    let clean_slug = slug.trim().to_ascii_lowercase();
    if clean_slug.is_empty()
        || clean_slug.len() > 50
        || !clean_slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let dns_label = clean_slug.replace('_', "-");
    let scheme = if https { "https" } else { "http" };
    Some(format!("{scheme}://preview-{dns_label}.{domain}"))
}

/// Default local dev-server ports scanned during automatic Local target discovery.
pub const DEFAULT_LOCAL_PROBE_PORTS: &[u16] = &[5173, 5174, 3000, 3001, 4173, 8080, 8000];

/// Upstream network descriptor registered for reverse-proxying through the isolated preview server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredUpstream {
    pub id: String,
    pub project_id: String,
    pub project_slug: String,
    pub agent_id: Option<String>,
    pub label: String,
    pub mode: PreviewMode,
    pub upstream_host: String,
    pub port: u16,
}

impl RegisteredUpstream {
    /// Converts this upstream descriptor into a UI-facing [`PreviewTarget`].
    #[must_use]
    pub fn to_preview_target(
        &self,
        preview_origin: &str,
        status: PreviewTargetStatus,
    ) -> PreviewTarget {
        PreviewTarget {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            agent_id: self.agent_id.clone(),
            label: self.label.clone(),
            mode: self.mode,
            port: self.port,
            preview_url: format!("{}/", preview_origin.trim_end_matches('/')),
            status,
        }
    }

    /// Returns the `host:port` authority for the upstream dev server.
    #[must_use]
    pub fn upstream_authority(&self) -> String {
        if self.upstream_host.contains(':') && !self.upstream_host.starts_with('[') {
            format!("[{}]:{}", self.upstream_host, self.port)
        } else {
            format!("{}:{}", self.upstream_host, self.port)
        }
    }
}

/// Thread-safe registry and auto-discovery service for Local, Container (`br-hq`),
/// and Sandbox preview targets.
#[derive(Debug, Clone, Default)]
pub struct PreviewRegistry {
    targets: Arc<RwLock<HashMap<String, RegisteredUpstream>>>,
    containers: ContainerIpRegistry,
}

impl PreviewRegistry {
    #[must_use]
    pub fn new(containers: ContainerIpRegistry) -> Self {
        Self {
            targets: Arc::new(RwLock::new(HashMap::new())),
            containers,
        }
    }

    /// Registers or replaces a preview target upstream.
    pub fn register(&self, upstream: RegisteredUpstream) {
        if let Ok(mut guard) = self.targets.write() {
            guard.insert(upstream.id.clone(), upstream);
        }
    }

    /// Removes a target by `target_id`.
    pub fn remove(&self, target_id: &str) {
        if let Ok(mut guard) = self.targets.write() {
            guard.remove(target_id);
        }
    }

    /// Removes all targets associated with `project_id`.
    pub fn remove_project(&self, project_id: &str) {
        if let Ok(mut guard) = self.targets.write() {
            guard.retain(|_, v| v.project_id != project_id);
        }
    }

    /// Fetches a registered upstream by `target_id`.
    #[must_use]
    pub fn get(&self, target_id: &str) -> Option<RegisteredUpstream> {
        self.targets
            .read()
            .ok()
            .and_then(|g| g.get(target_id).cloned())
    }

    /// Finds the first registered target matching subdomain routing `preview-<slug>.<host>`.
    #[must_use]
    pub fn find_by_project_slug(&self, slug: &str) -> Option<RegisteredUpstream> {
        self.targets.read().ok().and_then(|g| {
            g.values()
                .find(|t| t.project_slug.eq_ignore_ascii_case(slug))
                .cloned()
        })
    }

    /// Extracts a project slug from a `Host` header formatted as `preview-<slug>.<domain>[:port]`.
    #[must_use]
    pub fn parse_subdomain_slug(host_header: &str) -> Option<String> {
        let host_only = host_header.split(':').next()?.trim();
        let first_label = host_only.split('.').next()?;
        let slug = first_label.strip_prefix("preview-")?;
        if !slug.is_empty()
            && slug
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            Some(slug.to_owned())
        } else {
            None
        }
    }

    /// Registers a Container target using the static `br-hq` IP registry (`172.30.0.x`).
    pub fn register_container_target(
        &self,
        project_id: &str,
        project_slug: &str,
        agent_id: &str,
        container_ip: std::net::IpAddr,
        port: u16,
        label: impl Into<String>,
    ) -> RegisteredUpstream {
        let id = format!("container-{project_slug}-{agent_id}-{port}");
        let up = RegisteredUpstream {
            id: id.clone(),
            project_id: project_id.to_owned(),
            project_slug: project_slug.to_owned(),
            agent_id: Some(agent_id.to_owned()),
            label: label.into(),
            mode: PreviewMode::Container,
            upstream_host: container_ip.to_string(),
            port,
        };
        self.register(up.clone());
        up
    }

    /// Registers a Sandbox target descriptor (`sbx ports` published localhost port).
    pub fn register_sandbox_target(
        &self,
        project_id: &str,
        project_slug: &str,
        agent_id: &str,
        published_port: u16,
        label: impl Into<String>,
    ) -> RegisteredUpstream {
        let id = format!("sandbox-{project_slug}-{agent_id}-{published_port}");
        let up = RegisteredUpstream {
            id: id.clone(),
            project_id: project_id.to_owned(),
            project_slug: project_slug.to_owned(),
            agent_id: Some(agent_id.to_owned()),
            label: label.into(),
            mode: PreviewMode::Sandbox,
            upstream_host: "127.0.0.1".into(),
            port: published_port,
        };
        self.register(up.clone());
        up
    }

    /// Lists currently registered targets for `project_id` without probing.
    #[must_use]
    pub fn list_registered(&self, project_id: &str, preview_origin: &str) -> Vec<PreviewTarget> {
        let mut out: Vec<PreviewTarget> = self
            .targets
            .read()
            .map(|g| {
                g.values()
                    .filter(|t| t.project_id == project_id)
                    .map(|t| t.to_preview_target(preview_origin, PreviewTargetStatus::Live))
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// Probes candidate local TCP ports (`127.0.0.1:<port>`) plus registered targets and
    /// returns live [`PreviewTarget`] entries for `project_id`, excluding `excluded_ports`
    /// (such as HQ's own port and the preview proxy port).
    pub async fn discover_for_project(
        &self,
        project_id: &str,
        project_slug: &str,
        preview_origin: &str,
        candidate_ports: &[u16],
        excluded_ports: &[u16],
    ) -> Vec<PreviewTarget> {
        let _ = &self.containers;
        let ports: Vec<u16> = candidate_ports
            .iter()
            .copied()
            .filter(|p| *p > 0 && !excluded_ports.contains(p))
            .collect();

        let mut handles = Vec::with_capacity(ports.len());
        for port in ports {
            handles.push(tokio::spawn(async move {
                let live = probe_tcp("127.0.0.1", port, Duration::from_millis(120)).await;
                (port, live)
            }));
        }

        for h in handles {
            if let Ok((port, live)) = h.await {
                let id = format!("local-{project_slug}-{port}");
                if live {
                    let already = self.get(&id).is_some();
                    if !already {
                        self.register(RegisteredUpstream {
                            id,
                            project_id: project_id.to_owned(),
                            project_slug: project_slug.to_owned(),
                            agent_id: None,
                            label: format!("Local dev server (:{port})"),
                            mode: PreviewMode::Local,
                            upstream_host: "127.0.0.1".into(),
                            port,
                        });
                    }
                }
            }
        }

        // Probe all registered targets for this project to compute fresh liveness status.
        let snapshot: Vec<RegisteredUpstream> = self
            .targets
            .read()
            .map(|g| {
                g.values()
                    .filter(|t| t.project_id == project_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        let mut status_handles = Vec::with_capacity(snapshot.len());
        for up in snapshot {
            status_handles.push(tokio::spawn(async move {
                let live =
                    probe_tcp(&up.upstream_host, up.port, Duration::from_millis(120)).await;
                let status = if live {
                    PreviewTargetStatus::Live
                } else {
                    PreviewTargetStatus::Stopped
                };
                (up, status)
            }));
        }

        let mut results = Vec::new();
        for h in status_handles {
            if let Ok((up, status)) = h.await {
                results.push(up.to_preview_target(preview_origin, status));
            }
        }
        results.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.id.cmp(&b.id)));
        results
    }
}

async fn probe_tcp(host: &str, port: u16, timeout: Duration) -> bool {
    let addr_str = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let Ok(addr) = addr_str.parse::<SocketAddr>() else {
        return tokio::time::timeout(timeout, TcpStream::connect((host, port)))
            .await
            .is_ok_and(|res| res.is_ok());
    };
    tokio::time::timeout(timeout, TcpStream::connect(addr))
        .await
        .is_ok_and(|res| res.is_ok())
}
