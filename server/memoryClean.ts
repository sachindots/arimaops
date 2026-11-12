// SPDX-License-Identifier: AGPL-3.0-or-later
// What never goes into the team's memory (docs/memory-core.md section 6): secrets and personal data.
// Every memory write passes through cleanMemory first. Exploit techniques and payloads are allowed;
// only the secrets and people inside them are masked.
//
// Pure: the vault's secrets, the project's scope and its keep-out names come in through MemoryContext.

import type { Scope } from "../src/data/types";
import { checkScope } from "./scope";

export interface MemoryContext {
  /** Masks every value stored in the vault (the server's Redactor). */
  redact: (text: string) => string;
  /** Network targets of a security project: their IPs may be remembered. */
  scope?: Scope;
  /** Names (people, handles) the team asked to keep out of memory. */
  keepOut: string[];
}

/** Well-known credential shapes. Each match is replaced whole. */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];
/** `password=…`, `api_key: …`, `"secret": "…"`: the name stays, the value goes. */
const NAMED_SECRET = /\b((?:[A-Za-z_]*_)?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi;
/** Credentials inside a URL: scheme://user:pass@host. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Phone numbers only in shapes that dates, versions, ports and ids don't take.
const PHONES: RegExp[] = [
  /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,5}){2,4}\b/g, // +91 98765 43210, +1 (415) 555-0100
  /\(\d{3}\)\s?\d{3}[\s.-]\d{4}\b/g, // (415) 555-0100
  /\b\d{3}[.-]\d{3}[.-]\d{4}\b/g, // 415-555-0100
  /\b[6-9]\d{4}\s?\d{5}\b/g, // Indian mobiles: 98765 43210, 9876543210
];
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Loopback, private, link-local, CGNAT (Tailscale) and documentation ranges: about machines, not people. */
function isLocalIp(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text with secrets and personal data masked: [secret], [email], [phone], [ip], [name].
 * shortcut: IPv6 addresses and names nobody put on the keep-out list pass through; extraction's prompt forbids names,
 * and certification is the human check (docs/memory-core.md section 6).
 */
export function cleanMemory(text: string, ctx: MemoryContext): string {
  let out = ctx.redact(text);
  for (const re of SECRETS) out = out.replace(re, "[secret]");
  out = out.replace(URL_CREDENTIALS, "$1[secret]@").replace(NAMED_SECRET, (_, name: string) => `${name}[secret]`);
  out = out.replace(EMAIL, "[email]");
  for (const re of PHONES) out = out.replace(re, "[phone]");
  out = out.replace(IPV4, (ip) => (ip.split(".").some((p) => Number(p) > 255) || isLocalIp(ip) || (ctx.scope && checkScope(ctx.scope, ip).ok) ? ip : "[ip]"));
  for (const name of [...ctx.keepOut].sort((a, b) => b.length - a.length)) {
    const n = name.trim();
    if (n.length >= 2) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"), "[name]");
  }
  return out;
}

/** After masking, whether anything worth remembering is left (a memory that was only a key is dropped). */
export function saysSomething(cleaned: string): boolean {
  return cleaned.replace(/\[(?:secret|email|phone|ip|name)\]|••••\S{0,4}/g, "").replace(/[^\p{L}\p{N}]+/gu, "").length >= 12;
}
