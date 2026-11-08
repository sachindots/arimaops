// Security engagement scope: what agents may touch. Entries are domains ("example.com", "*.example.com"),
// IPv4 addresses or CIDRs ("10.0.0.0/24"), optionally with a port ("example.com:8443"). Out of scope wins.

import type { Scope } from "../src/data/types";

export const emptyScope = (): Scope => ({ inScope: [], outOfScope: [], rules: "" });

const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipNum(ip: string): number | null {
  const m = ip.match(IPV4);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** A target as the agent gave it (URL, host, host:port, IP) → host and port (port null if none given). */
export function parseTarget(raw: string): { host: string; port: number | null } | null {
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
      const u = new URL(v);
      return { host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : null };
    }
  } catch {
    return null;
  }
  v = v.replace(/\/.*$/, "");
  const m = v.match(/^(.+?)(?::(\d{1,5}))?$/);
  if (!m) return null;
  return { host: m[1].replace(/\.$/, ""), port: m[2] ? Number(m[2]) : null };
}

/** Normalizes one scope entry, or null if it isn't a domain, IPv4 or IPv4 CIDR (with optional :port). */
export function cleanEntry(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/$/, "");
  const m = v.match(/^([^:\s]+?)(?:\/(\d{1,2}))?(?::(\d{1,5}))?$/);
  if (!m) return null;
  const [, host, bits, port] = m;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (bits !== undefined) return ipNum(host) !== null && Number(bits) <= 32 ? `${host}/${bits}${port ? `:${port}` : ""}` : null;
  if (ipNum(host) !== null || DOMAIN.test(host)) return `${host}${port ? `:${port}` : ""}`;
  return null;
}

function entryMatches(entry: string, host: string, port: number | null): boolean {
  const m = entry.match(/^([^:/]+)(?:\/(\d{1,2}))?(?::(\d+))?$/);
  if (!m) return false;
  const [, pat, bits, p] = m;
  if (p && port !== null && Number(p) !== port) return false;
  const ip = ipNum(host);
  if (bits !== undefined) {
    const net = ipNum(pat);
    if (ip === null || net === null) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return ((ip & mask) >>> 0) === ((net & mask) >>> 0);
  }
  if (pat.startsWith("*.")) return host.endsWith(pat.slice(1));
  return host === pat;
}

/** Whether a target may be touched: in scope and not out of scope. `why` explains a refusal. */
export function checkScope(scope: Scope | undefined, rawTarget: string): { ok: boolean; why: string } {
  const t = parseTarget(rawTarget);
  if (!t) return { ok: false, why: `"${rawTarget}" isn't a host, IP or URL.` };
  if (!scope?.inScope.length) return { ok: false, why: "This engagement has no scope yet. Ask the user to set it (Settings → Project → Scope)." };
  if (scope.outOfScope.some((e) => entryMatches(e, t.host, t.port))) return { ok: false, why: `${t.host} is explicitly out of scope.` };
  if (scope.inScope.some((e) => entryMatches(e, t.host, t.port))) return { ok: true, why: "" };
  return { ok: false, why: `${t.host} isn't in scope. In scope: ${scope.inScope.join(", ")}.` };
}

/** In-scope IPs/CIDRs (for firewall rules; domains are resolved by the caller). */
export const scopeNetworks = (scope: Scope | undefined) => (scope?.inScope ?? []).map((e) => e.replace(/:\d+$/, "")).filter((e) => ipNum(e.split("/")[0]) !== null);
/** In-scope domains without ports (for the proxy and sbx allow rules). */
export const scopeDomains = (scope: Scope | undefined) => (scope?.inScope ?? []).map((e) => e.replace(/:\d+$/, "")).filter((e) => DOMAIN.test(e));
export const outOfScopeDomains = (scope: Scope | undefined) => (scope?.outOfScope ?? []).map((e) => e.replace(/:\d+$/, "")).filter((e) => DOMAIN.test(e));

/**
 * Host firewall commands for raw tools (nmap, nuclei…) in Container mode: each agent's fixed IP may reach each
 * in-scope network. Tagged per project, so the first command removes this project's old rules (idempotent).
 */
export function firewallCommands(slug: string, agentIps: string[], targets: string[], bridge: string): string[] {
  const tag = `hq-scope-${slug}`;
  const clear = `sudo iptables -S DOCKER-USER | grep -- '${tag}' | sed 's/^-A/-D/' | xargs -r -L1 sudo iptables`;
  const adds = agentIps.flatMap((src) => targets.map((dst) => `sudo iptables -I DOCKER-USER -i ${bridge} -s ${src} -d ${dst} -m comment --comment ${tag} -j ACCEPT`));
  return [clear, ...adds];
}
