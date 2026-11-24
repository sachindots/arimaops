// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use arima_proxy::{
    ContainerIdentity, EgressPolicy, EgressProxy, PolicyProvider, ProxyCredentials,
    StaticPolicyProvider,
};
use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn spawn_echo_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 64];
                if let Ok(n) = sock.read(&mut buf).await {
                    let _ = sock.write_all(&buf[..n]).await;
                }
            });
        }
    });
    addr
}

fn basic(user: &str, token: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("{user}:{token}"))
}

async fn send_connect(proxy_addr: SocketAddr, authority: &str, cred: &str) -> (String, TcpStream) {
    let mut stream = TcpStream::connect(proxy_addr).await.unwrap();
    let req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: Basic {cred}\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();

    let mut buf = Vec::new();
    let mut tmp = [0u8; 256];
    loop {
        let n = stream.read(&mut tmp).await.unwrap();
        assert!(n > 0, "proxy closed before response headers");
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..pos]).to_string();
            return (head, stream);
        }
    }
}

#[tokio::test]
async fn blocks_ssrf_loopback_imds_ipv6_and_dns_rebind_while_allowing_scoped_target() {
    let echo_addr = spawn_echo_server().await;
    let registry = ProxyCredentials::new();
    let cred = basic("coder", &registry.issue(ContainerIdentity {
        project_id: "p1".into(),
        agent_id: "coder".into(),
        container_name: "hq-p1-coder".into(),
    }));

    // Even if `localhost:<port>` or `127.0.0.1:<port>` appears in normal `allow`,
    // DNS-pinned restricted-IP defense must block it unless in `scope_allow_targets`.
    let normal_provider = Arc::new(StaticPolicyProvider {
        policy: EgressPolicy {
            allow: vec![
                format!("localhost:{}", echo_addr.port()),
                format!("127.0.0.1:{}", echo_addr.port()),
                "169.254.169.254:80".into(),
                "[::1]:443".into(),
            ],
            deny: vec![],
            scope_allow_targets: vec![],
            drafts_only: false,
            outbound_hosts: vec![],
            allow_unknown_loopback_peer: false,
            ..EgressPolicy::default()
        },
    });
    let normal_proxy = EgressProxy::start(
        "127.0.0.1:0".parse().unwrap(),
        registry.clone(),
        normal_provider,
    )
    .await
    .unwrap();

    let (head_loopback, _) =
        send_connect(normal_proxy.addr(), &format!("127.0.0.1:{}", echo_addr.port()), &cred).await;
    assert!(head_loopback.starts_with("HTTP/1.1 403 Forbidden"), "{head_loopback}");

    let (head_imds, _) = send_connect(normal_proxy.addr(), "169.254.169.254:80", &cred).await;
    assert!(head_imds.starts_with("HTTP/1.1 403 Forbidden"), "{head_imds}");

    let (head_ipv6, _) = send_connect(normal_proxy.addr(), "[::1]:443", &cred).await;
    assert!(head_ipv6.starts_with("HTTP/1.1 403 Forbidden"), "{head_ipv6}");

    let (head_dns, _) =
        send_connect(normal_proxy.addr(), &format!("localhost:{}", echo_addr.port()), &cred).await;
    assert!(head_dns.starts_with("HTTP/1.1 403 Forbidden"), "{head_dns}");

    // Explicitly authorized engagement scope target IS permitted.
    let scoped_provider = Arc::new(StaticPolicyProvider {
        policy: EgressPolicy {
            allow: vec![],
            deny: vec![],
            scope_allow_targets: vec![format!("127.0.0.1:{}", echo_addr.port())],
            drafts_only: false,
            outbound_hosts: vec![],
            allow_unknown_loopback_peer: false,
            ..EgressPolicy::default()
        },
    });
    let scoped_proxy =
        EgressProxy::start("127.0.0.1:0".parse().unwrap(), registry, scoped_provider)
            .await
            .unwrap();

    let (head_scoped, mut tunnel) =
        send_connect(scoped_proxy.addr(), &format!("127.0.0.1:{}", echo_addr.port()), &cred).await;
    assert!(
        head_scoped.starts_with("HTTP/1.1 200 Connection Established"),
        "{head_scoped}"
    );
    tunnel.write_all(b"ping").await.unwrap();
    let mut reply = [0u8; 4];
    tunnel.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"ping");
}

/// Records what observe mode lets through.
#[derive(Default)]
struct Observing {
    policy: EgressPolicy,
    seen: Mutex<Vec<(String, String, u16)>>,
    blocked: Mutex<Vec<(String, String, u16)>>,
}

impl PolicyProvider for Observing {
    fn policy_for<'a>(
        &'a self,
        _peer: std::net::IpAddr,
        identity: Option<&'a ContainerIdentity>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<EgressPolicy>> + Send + 'a>> {
        Box::pin(async move { identity.map(|_| self.policy.clone()) })
    }

    fn record_would_block(&self, identity: &ContainerIdentity, host: &str, port: u16) {
        self.seen.lock().unwrap().push((identity.agent_id.clone(), host.to_owned(), port));
    }

    fn record_blocked(&self, identity: &ContainerIdentity, host: &str, port: u16) {
        self.blocked.lock().unwrap().push((identity.agent_id.clone(), host.to_owned(), port));
    }
}

#[tokio::test]
async fn names_the_caller_by_credential_and_observe_mode_records_instead_of_blocking() {
    let echo = spawn_echo_server().await;
    let creds = ProxyCredentials::new();
    let token = creds.issue(ContainerIdentity { project_id: "p1".into(), agent_id: "ada".into(), container_name: "hq-p1-ada".into() });
    let provider = Arc::new(Observing {
        policy: EgressPolicy {
            observe: true,
            allow: vec!["127.0.0.4".into()],
            quiet: vec!["127.0.0.3".into()],
            // The echo server is on loopback: only a scope target may reach it, as in every mode.
            scope_allow_targets: vec![format!("127.0.0.1:{}", echo.port())],
            ..EgressPolicy::default()
        },
        ..Observing::default()
    });
    let proxy = EgressProxy::start("127.0.0.1:0".parse().unwrap(), creds.clone(), Arc::clone(&provider) as Arc<dyn PolicyProvider>).await.unwrap();

    for bad in [basic("ada", "wrong-token"), basic("grace", &token), "not base64!".into()] {
        let (head, _) = send_connect(proxy.addr(), &format!("127.0.0.1:{}", echo.port()), &bad).await;
        assert!(head.starts_with("HTTP/1.1 407"), "{head}");
    }
    let mut stream = TcpStream::connect(proxy.addr()).await.unwrap();
    stream.write_all(b"CONNECT example.test:443 HTTP/1.1\r\n\r\n").await.unwrap();
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf).await.unwrap();
    assert!(buf[..n].starts_with(b"HTTP/1.1 407"), "no credential is refused too");

    let cred = basic("ada", &token);
    let (head, _) = send_connect(proxy.addr(), &format!("127.0.0.1:{}", echo.port()), &cred).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    // Not in the allow list: observe records it and lets it on to the address check (which refuses loopback, so
    // no test request leaves this machine).
    let _ = send_connect(proxy.addr(), "LOCALHOST:8443", &cred).await;
    let _ = send_connect(proxy.addr(), "127.0.0.3:443", &cred).await;
    let _ = send_connect(proxy.addr(), "127.0.0.4:443", &cred).await;
    // Metadata stays blocked in observe mode.
    let (imds, _) = send_connect(proxy.addr(), "169.254.169.254:80", &cred).await;
    assert!(imds.starts_with("HTTP/1.1 403"), "{imds}");
    let seen = provider.seen.lock().unwrap().clone();
    assert_eq!(seen, [("ada".to_owned(), "localhost".to_owned(), 8443)], "quiet and allowed hosts aren't recorded");

    creds.revoke("p1", "ada");
    let (head, _) = send_connect(proxy.addr(), &format!("127.0.0.1:{}", echo.port()), &cred).await;
    assert!(head.starts_with("HTTP/1.1 407"), "a revoked credential is refused: {head}");
}

/// The whole reply to a CONNECT the proxy refuses (it closes the connection after the body).
async fn connect_reply(proxy_addr: SocketAddr, authority: &str, cred: &str) -> String {
    let mut stream = TcpStream::connect(proxy_addr).await.unwrap();
    let req = format!("CONNECT {authority} HTTP/1.1\r\nProxy-Authorization: Basic {cred}\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply).await;
    reply
}

#[tokio::test]
async fn enforce_refuses_unlisted_hosts_with_an_inbox_answer_and_private_addresses_unless_scoped() {
    let echo = spawn_echo_server().await;
    let creds = ProxyCredentials::new();
    let token = creds.issue(ContainerIdentity { project_id: "p1".into(), agent_id: "ada".into(), container_name: "hq-p1-ada".into() });
    let provider = Arc::new(Observing {
        policy: EgressPolicy {
            observe: false,
            allow: vec!["10.255.255.1".into()],
            deny: vec!["denied.example".into()],
            quiet: vec!["quiet.example".into()],
            scope_allow_targets: vec![format!("127.0.0.1:{}", echo.port())],
            ..EgressPolicy::default()
        },
        ..Observing::default()
    });
    let proxy = EgressProxy::start("127.0.0.1:0".parse().unwrap(), creds, Arc::clone(&provider) as Arc<dyn PolicyProvider>).await.unwrap();
    let cred = basic("ada", &token);

    let reply = connect_reply(proxy.addr(), "Unlisted.Example:443", &cred).await;
    assert!(reply.starts_with("HTTP/1.1 403") && reply.contains("unlisted.example:443") && reply.contains("Inbox"), "{reply}");

    let (plain, _) = send_connect(proxy.addr(), "quiet.example:443", &cred).await;
    assert!(plain.starts_with("HTTP/1.1 403"), "quiet hosts are refused too, without a request");
    let (denied, _) = send_connect(proxy.addr(), "denied.example:443", &cred).await;
    assert!(denied.starts_with("HTTP/1.1 403"));
    // Listed but private, with no owner rule naming it: refused.
    let private = connect_reply(proxy.addr(), "10.255.255.1:80", &cred).await;
    assert!(private.starts_with("HTTP/1.1 403") && private.contains("restricted"), "{private}");
    let (scoped, _) = send_connect(proxy.addr(), &format!("127.0.0.1:{}", echo.port()), &cred).await;
    assert!(scoped.starts_with("HTTP/1.1 200"), "an explicit scope target still gets through: {scoped}");

    assert_eq!(*provider.blocked.lock().unwrap(), [("ada".to_owned(), "unlisted.example".to_owned(), 443)], "only the unlisted host files a request");
    assert!(provider.seen.lock().unwrap().is_empty(), "enforce doesn't report would-blocks");
}

#[tokio::test]
async fn observe_mode_records_private_targets_but_never_bridges_to_them_without_an_owner_rule() {
    let creds = ProxyCredentials::new();
    let token = creds.issue(ContainerIdentity { project_id: "p1".into(), agent_id: "ada".into(), container_name: "hq-p1-ada".into() });
    let provider = Arc::new(Observing { policy: EgressPolicy { observe: true, ..EgressPolicy::default() }, ..Observing::default() });
    let proxy = EgressProxy::start("127.0.0.1:0".parse().unwrap(), creds, Arc::clone(&provider) as Arc<dyn PolicyProvider>).await.unwrap();
    let cred = basic("ada", &token);

    // Another project's internal network, which HQ is attached to and this agent is not.
    let reply = connect_reply(proxy.addr(), "172.30.0.5:5432", &cred).await;
    assert!(reply.starts_with("HTTP/1.1 403") && reply.contains("restricted"), "{reply}");
    assert_eq!(*provider.seen.lock().unwrap(), [("ada".to_owned(), "172.30.0.5".to_owned(), 5432)], "the owner sees it in the would-block list");
}
