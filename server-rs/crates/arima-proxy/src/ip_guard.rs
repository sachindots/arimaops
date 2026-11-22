// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::IpAddr;

/// Returns `true` if `ip` belongs to cloud instance metadata / link-local ranges
/// (`169.254.0.0/16` including AWS/GCP/Azure IMDS `169.254.169.254`, IPv6 `fe80::/10`,
/// AWS IPv6 IMDS `fd00:ec2::254`, unspecified `0.0.0.0/8` / `::`, multicast, or broadcast),
/// including IPv4-mapped IPv6 addresses.
///
/// These addresses are **NEVER** permitted even when an engagement scope explicitly allows
/// private/lab targets.
#[must_use]
pub fn is_imds_or_link_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_link_local()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
                || v4.is_multicast()
                || v4.is_broadcast()
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_imds_or_link_local_ip(IpAddr::V4(mapped));
            }
            let segs = v6.segments();
            let is_aws_imds_v6 = segs == [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];
            v6.is_unicast_link_local()
                || is_aws_imds_v6
                || v6.is_unspecified()
                || v6.is_multicast()
        }
    }
}

/// Returns `true` if `ip` belongs to loopback, RFC 1918 private, link-local / cloud IMDS
/// (`169.254.0.0/16`, `fe80::/10`), ULA (`fc00::/7`), unspecified (`0.0.0.0/8`, `::`),
/// multicast, or broadcast ranges — including IPv4-mapped IPv6 addresses.
#[must_use]
pub fn is_restricted_ip(ip: IpAddr) -> bool {
    if is_imds_or_link_local_ip(ip) {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_restricted_ip(IpAddr::V4(mapped));
            }
            v6.is_loopback() || v6.is_unique_local()
        }
    }
}
