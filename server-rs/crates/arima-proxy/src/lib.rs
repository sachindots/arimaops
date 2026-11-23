// SPDX-License-Identifier: AGPL-3.0-or-later

//! Hardened L4/L7 proxies for ArimaOps v2.0:
//! 1. DNS-pinned SSRF-safe container egress proxy (Milestone 1).
//! 2. Origin-isolated live preview reverse proxy (`:7421` / subdomain mode) with
//!    HTTP + WebSocket/HMR forwarding and `ArimaBridge` injection (Milestone 3).

pub mod bridge;
pub mod discovery;
pub mod egress;
pub mod ip_guard;
pub mod policy;
pub mod preview;

pub use bridge::{inject_bridge_html, normalize_strict_origin, render_bridge_script};
pub use discovery::{
    build_subdomain_preview_origin, normalize_preview_domain, PreviewRegistry, RegisteredUpstream,
    DEFAULT_LOCAL_PROBE_PORTS,
};
pub use egress::{EgressProxy, EgressProxyHandle};
pub use ip_guard::{is_imds_or_link_local_ip, is_restricted_ip};
pub use policy::{
    host_matches, host_matches_scope, is_imds_host_literal, normalize_scope_rule,
    parse_connect_authority, ContainerIdentity, ContainerIpRegistry, DynamicScopePolicyProvider,
    EgressPolicy, PolicyProvider, ProxyCredentials, ProxyError, ScopeCheckResult, StaticPolicyProvider,
};
pub use preview::{
    rewrite_csp_frame_ancestors, strip_arima_cookies, PreviewClaims, PreviewError, PreviewProxy,
    PreviewProxyConfig, PreviewProxyHandle, PreviewTokenSigner, PREVIEW_COOKIE_NAME,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn blocks_imds_loopback_and_private_ips() {
        assert!(is_restricted_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_restricted_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
        assert!(is_restricted_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))));
        assert!(is_restricted_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_restricted_ip(IpAddr::V4(Ipv4Addr::new(172, 30, 0, 1))));
        assert!(is_restricted_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_restricted_ip(IpAddr::V6(
            "::ffff:169.254.169.254".parse().unwrap()
        )));
        assert!(!is_restricted_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }

    #[test]
    fn parses_ipv4_ipv6_and_host_connect_authorities() {
        assert_eq!(
            parse_connect_authority("[::1]:443").unwrap(),
            ("::1".into(), 443)
        );
        assert_eq!(
            parse_connect_authority("[2001:db8::1]:8443").unwrap(),
            ("2001:db8::1".into(), 8443)
        );
        assert_eq!(
            parse_connect_authority("169.254.169.254:80").unwrap(),
            ("169.254.169.254".into(), 80)
        );
        assert_eq!(
            parse_connect_authority("github.com:443").unwrap(),
            ("github.com".into(), 443)
        );
        assert!(parse_connect_authority("[::1:443").is_err());
        assert!(parse_connect_authority("example.com:0").is_err());
    }
}
