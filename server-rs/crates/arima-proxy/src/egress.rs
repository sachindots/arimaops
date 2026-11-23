// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tracing::{debug, warn};

use crate::ip_guard::{is_imds_or_link_local_ip, is_restricted_ip};
use base64::Engine as _;

use crate::policy::{
    host_matches, host_matches_scope, is_imds_host_literal, normalize_host, parse_connect_authority, ContainerIdentity,
    EgressPolicy, PolicyProvider, ProxyCredentials, ProxyError,
};

const MAX_HEADER_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct EgressProxyHandle {
    addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
}

impl EgressProxyHandle {
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
}

impl Drop for EgressProxyHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// DNS-pinned L4/L7 container egress proxy defending against SSRF and DNS rebinding.
pub struct EgressProxy;

impl EgressProxy {
    pub async fn start(
        bind_addr: SocketAddr,
        credentials: ProxyCredentials,
        policy: Arc<dyn PolicyProvider>,
    ) -> Result<EgressProxyHandle, ProxyError> {
        let listener = TcpListener::bind(bind_addr).await?;
        let local_addr = listener.local_addr()?;
        let (tx, mut rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => {
                        debug!("egress proxy shutting down");
                        break;
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, peer)) => {
                                let reg = credentials.clone();
                                let pol = Arc::clone(&policy);
                                tokio::spawn(async move {
                                    if let Err(err) = handle_client(stream, peer, reg, pol).await {
                                        debug!("egress client closed ({peer}): {err}");
                                    }
                                });
                            }
                            Err(err) => {
                                warn!("egress accept error: {err}");
                            }
                        }
                    }
                }
            }
        });

        Ok(EgressProxyHandle {
            addr: local_addr,
            shutdown: Some(tx),
        })
    }
}

struct Decision {
    allowed: bool,
    explicitly_scoped: bool,
    reason: &'static str,
}

fn evaluate_policy(policy: &EgressPolicy, host: &str, port: u16) -> Decision {
    if host_matches(&policy.deny, host, port) || host_matches_scope(&policy.deny, host, port) {
        return Decision {
            allowed: false,
            explicitly_scoped: false,
            reason: "denied",
        };
    }
    if policy.drafts_only && host_matches(&policy.outbound_hosts, host, port) {
        return Decision {
            allowed: false,
            explicitly_scoped: false,
            reason: "drafts-only mode blocks outbound sends",
        };
    }
    let explicitly_scoped = host_matches_scope(&policy.scope_allow_targets, host, port);
    if explicitly_scoped || host_matches(&policy.allow, host, port) {
        return Decision {
            allowed: true,
            explicitly_scoped,
            reason: "",
        };
    }
    Decision {
        allowed: false,
        explicitly_scoped: false,
        reason: "host not in allowlist",
    }
}

/// In observe mode a refusal becomes a report, unless the host is a quiet one. Metadata and private addresses
/// stay blocked by [`resolve_pinned`] in every mode.
fn observed(
    decision: Decision,
    policy: &EgressPolicy,
    provider: &dyn PolicyProvider,
    identity: Option<&ContainerIdentity>,
    host: &str,
    port: u16,
) -> Decision {
    if decision.allowed || !policy.observe || is_imds_host_literal(host) {
        return decision;
    }
    if let Some(id) = identity.filter(|_| !host_matches(&policy.quiet, host, port)) {
        provider.record_would_block(id, &normalize_host(host), port);
    }
    Decision { allowed: true, explicitly_scoped: false, reason: "" }
}

/// `Basic base64(agent:token)` from the `Proxy-Authorization` header.
fn identify(credentials: &ProxyCredentials, header: &str) -> Option<ContainerIdentity> {
    let (scheme, encoded) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).ok()?;
    let text = String::from_utf8(raw).ok()?;
    let (user, token) = text.split_once(':')?;
    credentials.identify(user, token)
}

async fn resolve_pinned(
    host: &str,
    port: u16,
    allow_restricted: bool,
) -> Result<SocketAddr, &'static str> {
    let clean = normalize_host(host);
    if let Ok(ip) = clean.parse::<IpAddr>() {
        if is_imds_or_link_local_ip(ip) {
            return Err("cloud metadata / link-local IP is unconditionally blocked");
        }
        if is_restricted_ip(ip) && !allow_restricted {
            return Err("restricted loopback/private/metadata IP blocked");
        }
        return Ok(SocketAddr::new(ip, port));
    }

    let addrs = tokio::net::lookup_host((clean.as_str(), port))
        .await
        .map_err(|_| "DNS lookup failed")?;

    let mut chosen: Option<SocketAddr> = None;
    for sa in addrs {
        if is_imds_or_link_local_ip(sa.ip()) {
            return Err("hostname resolved to unconditionally blocked cloud metadata / link-local IP");
        }
        if is_restricted_ip(sa.ip()) && !allow_restricted {
            // Never permit a hostname that resolves to loopback, RFC1918, or IMDS!
            return Err("hostname resolved to restricted loopback/private/metadata IP");
        }
        if chosen.is_none() {
            chosen = Some(sa);
        }
    }

    chosen.ok_or("no DNS records for target host")
}

async fn handle_client(
    stream: TcpStream,
    peer: SocketAddr,
    credentials: ProxyCredentials,
    provider: Arc<dyn PolicyProvider>,
) -> Result<(), ProxyError> {
    let mut reader = BufReader::new(stream);
    let mut lines = Vec::new();
    let mut total_bytes = 0usize;

    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(());
        }
        total_bytes += n;
        if total_bytes > MAX_HEADER_BYTES {
            let mut inner = reader.into_inner();
            let _ = inner
                .write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n")
                .await;
            return Ok(());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        lines.push(line.trim_end_matches(['\r', '\n']).to_owned());
    }

    let Some(req_line) = lines.first().cloned() else {
        return Ok(());
    };
    let mut parts = req_line.split_whitespace();
    let (Some(method), Some(target), Some(_version)) =
        (parts.next(), parts.next(), parts.next())
    else {
        let mut inner = reader.into_inner();
        let _ = inner
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\nbad request\n")
            .await;
        return Ok(());
    };

    let auth = lines.iter().skip(1).find_map(|h| {
        let (name, value) = h.split_once(':')?;
        name.trim().eq_ignore_ascii_case("proxy-authorization").then(|| value.trim().to_owned())
    });
    let identity = auth.as_deref().and_then(|a| identify(&credentials, a));
    let policy = if auth.is_some() && identity.is_none() {
        None
    } else {
        provider.policy_for(peer.ip(), identity.as_ref()).await
    };
    let Some(policy) = policy else {
        let mut inner = reader.into_inner();
        write_auth_required(&mut inner).await?;
        return Ok(());
    };

    if method.eq_ignore_ascii_case("CONNECT") {
        let Ok((host, port)) = parse_connect_authority(target) else {
            let mut inner = reader.into_inner();
            let _ = inner
                .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                .await;
            return Ok(());
        };

        let decision = observed(evaluate_policy(&policy, &host, port), &policy, &*provider, identity.as_ref(), &host, port);
        if !decision.allowed {
            let mut inner = reader.into_inner();
            write_forbidden(&mut inner, decision.reason).await?;
            return Ok(());
        }

        let pinned_addr = match resolve_pinned(&host, port, decision.explicitly_scoped).await {
            Ok(sa) => sa,
            Err(why) => {
                let mut inner = reader.into_inner();
                write_forbidden(&mut inner, why).await?;
                return Ok(());
            }
        };

        let mut upstream = match TcpStream::connect(pinned_addr).await {
            Ok(s) => s,
            Err(_) => {
                let mut inner = reader.into_inner();
                let _ = inner
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nupstream connect failed\n")
                    .await;
                return Ok(());
            }
        };

        // Drain any already-buffered bytes from BufReader before converting back to TcpStream.
        let buffered = reader.buffer().to_vec();
        let mut client = reader.into_inner();
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
        if !buffered.is_empty() {
            upstream.write_all(&buffered).await?;
        }
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        return Ok(());
    }

    // Plain HTTP proxy request (`METHOD http://host[:port]/path HTTP/1.1`).
    let Some(parsed) = parse_http_proxy_url(target) else {
        let mut inner = reader.into_inner();
        let _ = inner
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\nabsolute http:// URL required\n")
            .await;
        return Ok(());
    };

    let decision = observed(evaluate_policy(&policy, &parsed.host, parsed.port), &policy, &*provider, identity.as_ref(), &parsed.host, parsed.port);
    if !decision.allowed {
        let mut inner = reader.into_inner();
        write_forbidden(&mut inner, decision.reason).await?;
        return Ok(());
    }

    let pinned_addr = match resolve_pinned(&parsed.host, parsed.port, decision.explicitly_scoped).await {
        Ok(sa) => sa,
        Err(why) => {
            let mut inner = reader.into_inner();
            write_forbidden(&mut inner, why).await?;
            return Ok(());
        }
    };

    let mut upstream = match TcpStream::connect(pinned_addr).await {
        Ok(s) => s,
        Err(_) => {
            let mut inner = reader.into_inner();
            let _ = inner
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nupstream connect failed\n")
                .await;
            return Ok(());
        }
    };

    let mut forward = format!("{method} {} HTTP/1.1\r\n", parsed.path_and_query);
    let mut has_host = false;
    for h in lines.iter().skip(1) {
        if let Some((name, _)) = h.split_once(':') {
            let lower = name.trim().to_ascii_lowercase();
            if lower == "proxy-connection" || lower == "proxy-authorization" || lower == "connection" {
                continue;
            }
            if lower == "host" {
                has_host = true;
            }
        }
        forward.push_str(h);
        forward.push_str("\r\n");
    }
    if !has_host {
        forward.push_str(&format!("Host: {}\r\n", parsed.host));
    }
    forward.push_str("Connection: close\r\n\r\n");
    upstream.write_all(forward.as_bytes()).await?;

    let buffered = reader.buffer().to_vec();
    if !buffered.is_empty() {
        upstream.write_all(&buffered).await?;
    }
    let mut client = reader.into_inner();
    let mut buf = [0u8; 8192];
    loop {
        let n = upstream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        client.write_all(&buf[..n]).await?;
    }
    Ok(())
}

struct ParsedHttpTarget {
    host: String,
    port: u16,
    path_and_query: String,
}

fn parse_http_proxy_url(raw: &str) -> Option<ParsedHttpTarget> {
    let rest = raw.strip_prefix("http://")?;
    let (authority, path_and_query) = match rest.find('/') {
        Some(idx) => (&rest[..idx], rest[idx..].to_owned()),
        None => (rest, "/".to_owned()),
    };
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let (ip, after) = inner.split_once(']')?;
        let port = if let Some(p) = after.strip_prefix(':') {
            p.parse().ok()?
        } else if after.is_empty() {
            80
        } else {
            return None;
        };
        (ip.to_owned(), port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        (normalize_host(h), p.parse().ok()?)
    } else {
        (normalize_host(authority), 80)
    };
    if host.is_empty() || port == 0 {
        return None;
    }
    Some(ParsedHttpTarget {
        host,
        port,
        path_and_query,
    })
}

async fn write_auth_required(stream: &mut TcpStream) -> std::io::Result<()> {
    let body = "ArimaOps proxy: a valid agent proxy credential is required.\n";
    let resp = format!(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"ArimaOps\"\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await
}

async fn write_forbidden(stream: &mut TcpStream, why: &str) -> std::io::Result<()> {
    let body = format!("ArimaOps proxy: {why}.\n");
    let resp = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await
}
