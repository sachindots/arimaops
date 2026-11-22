// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use arima_proxy::{
    ContainerIdentity, ContainerIpRegistry, EgressPolicy, EgressProxy, StaticPolicyProvider,
};
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

async fn send_connect(proxy_addr: SocketAddr, authority: &str) -> (String, TcpStream) {
    let mut stream = TcpStream::connect(proxy_addr).await.unwrap();
    let req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
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
    let registry = ContainerIpRegistry::new();
    registry.register(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        ContainerIdentity {
            project_id: "p1".into(),
            agent_id: "coder".into(),
            container_name: "hq-p1-coder".into(),
        },
    );

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
        send_connect(normal_proxy.addr(), &format!("127.0.0.1:{}", echo_addr.port())).await;
    assert!(head_loopback.starts_with("HTTP/1.1 403 Forbidden"), "{head_loopback}");

    let (head_imds, _) = send_connect(normal_proxy.addr(), "169.254.169.254:80").await;
    assert!(head_imds.starts_with("HTTP/1.1 403 Forbidden"), "{head_imds}");

    let (head_ipv6, _) = send_connect(normal_proxy.addr(), "[::1]:443").await;
    assert!(head_ipv6.starts_with("HTTP/1.1 403 Forbidden"), "{head_ipv6}");

    let (head_dns, _) =
        send_connect(normal_proxy.addr(), &format!("localhost:{}", echo_addr.port())).await;
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
        },
    });
    let scoped_proxy =
        EgressProxy::start("127.0.0.1:0".parse().unwrap(), registry, scoped_provider)
            .await
            .unwrap();

    let (head_scoped, mut tunnel) =
        send_connect(scoped_proxy.addr(), &format!("127.0.0.1:{}", echo_addr.port())).await;
    assert!(
        head_scoped.starts_with("HTTP/1.1 200 Connection Established"),
        "{head_scoped}"
    );
    tunnel.write_all(b"ping").await.unwrap();
    let mut reply = [0u8; 4];
    tunnel.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"ping");
}
