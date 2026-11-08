// Remote control safety (tablet/phone):
//  - Push: ntfy notification when something waits on you (action item, sandbox approval, access request).
//  - Step-up: risky commands from a non-local client need a fresh TOTP code (authenticator app).
//  - Audit: every UI command is appended to ~/.hq/<project>/audit.log (never terminal input or secret values).

import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OfficeEvent } from "../src/data/source";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";

/** Commands that can run code on the host, leak secrets, widen the sandbox or approve agent requests. */
export const RISKY_COMMANDS = new Set([
  "openShell",
  "openHostShell",
  "sendTerminalInput",
  "runSetupFix",
  "recreateSandbox",
  "removeAgent",
  "updateAgent",
  "updateSandbox",
  "setSecret",
  "removeSecret",
  "setProxy",
  "openEnvFile",
  "addMcp",
  "removeMcp",
  "authMcp",
  "answerApproval",
  "resolveAccess",
  "resolveActionItem",
  "updateWorkflow",
  "updateProject",
  "forwardPort",
]);

/** Never written to the audit log with arguments. */
const QUIET = new Set(["sendTerminalInput", "resizeTerminal"]);
const REDACT_ARGS = new Set(["setSecret", "setProxy"]);

const STEP_UP_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

export class RemoteGuard {
  private secret: Buffer;
  readonly secretB32: string;
  private usedSteps = new Set<number>(); // one-time: a code can't be replayed
  private auditFile: string;

  constructor(
    slug: string,
    private projectName: string,
  ) {
    const file = join(projectHome(slug), "totp-secret");
    if (!existsSync(file)) writeFileSync(file, base32Encode(randomBytes(20)), { mode: 0o600 });
    this.secretB32 = readFileSync(file, "utf8").trim();
    this.secret = base32Decode(this.secretB32);
    this.auditFile = join(projectHome(slug), "audit.log");
  }

  otpauthUrl() {
    const label = encodeURIComponent(`dot hq:${this.projectName}`);
    return `otpauth://totp/${label}?secret=${this.secretB32}&issuer=dot%20hq&digits=6&period=30`;
  }

  /** Accepts the current code ±1 step (clock drift); each step is usable once. */
  verify(code: string): boolean {
    const clean = String(code ?? "").replace(/\D/g, "");
    if (clean.length !== 6) return false;
    const now = Math.floor(Date.now() / 30_000);
    for (const step of [now - 1, now, now + 1]) {
      if (!this.usedSteps.has(step) && totp(this.secret, step) === clean) {
        this.usedSteps.add(step);
        for (const s of this.usedSteps) if (s < now - 2) this.usedSteps.delete(s);
        return true;
      }
    }
    return false;
  }

  stepUpUntil(): number {
    return Date.now() + STEP_UP_MS;
  }

  audit(entry: { role: string; origin: string; remote: boolean; cmd: string; args: unknown[]; result: "ok" | "blocked" | "step-up-required" | "error" | "elevated" | "bad-code" }) {
    if (QUIET.has(entry.cmd) && entry.result === "ok") return;
    const args = REDACT_ARGS.has(entry.cmd) ? ["[redacted]"] : QUIET.has(entry.cmd) ? [] : entry.args;
    let argStr = "";
    try {
      argStr = JSON.stringify(args).slice(0, 500);
    } catch {
      argStr = "[unserializable]";
    }
    const line = `${new Date().toISOString()}\t${entry.result}\t${entry.role}${entry.remote ? "@remote" : ""}\t${entry.origin || "-"}\t${entry.cmd}\t${argStr}\n`;
    try {
      appendFileSync(this.auditFile, line, { mode: 0o600 });
    } catch (err) {
      log.warn("audit write failed:", err instanceof Error ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------- Push (ntfy)

/**
 * Sends a push when something starts waiting on you. Topic from --ntfy / HQ_NTFY_TOPIC;
 * server from HQ_NTFY_URL (default https://ntfy.sh). Pick a long random topic: ntfy topics are public.
 */
export function startPushNotifier(hub: Hub, topic: string, server = process.env.HQ_NTFY_URL ?? "https://ntfy.sh", openUrl?: string) {
  const seen = new Set<string>();
  // Don't push what was already pending at startup.
  for (const a of hub.snap.actionItems ?? []) if (a.status === "open") seen.add(`action:${a.id}`);
  for (const r of hub.snap.accessRequests ?? []) if (r.status === "pending") seen.add(`access:${r.id}`);
  for (const [, st] of Object.entries(hub.snap.sbx?.agents ?? {})) for (const ap of st.approvals ?? []) seen.add(`sbx:${ap.id}`);

  const name = (id: string) => hub.cfg(id)?.name ?? id;
  const push = (key: string, title: string, body: string, priority: "default" | "high") => {
    if (seen.has(key)) return;
    seen.add(key);
    const headers: Record<string, string> = { Title: `.hq ${hub.snap.config.project.name}: ${title}`.slice(0, 200), Priority: priority, Tags: "rotating_light" };
    if (openUrl) headers.Click = openUrl;
    fetch(`${server.replace(/\/$/, "")}/${encodeURIComponent(topic)}`, { method: "POST", headers, body: body.slice(0, 1000) }).catch((err) =>
      log.warn("ntfy push failed:", err instanceof Error ? err.message : err),
    );
  };

  hub.subscribe((e: OfficeEvent) => {
    if (e.type === "action.updated" && e.item.status === "open") {
      push(`action:${e.item.id}`, `${name(e.item.fromId)} needs you`, e.item.title, e.item.waiting ? "high" : "default");
    } else if (e.type === "access.updated" && e.request.status === "pending") {
      push(`access:${e.request.id}`, `${name(e.request.agentId)} wants ${e.request.domain}`, e.request.reason || "Network access request", "high");
    } else if (e.type === "sbx.updated") {
      for (const [agentId, st] of Object.entries(e.sbx.agents ?? {}))
        for (const ap of st.approvals ?? []) push(`sbx:${ap.id}`, `${name(agentId)} blocked: ${ap.host}`, ap.title ?? ap.detail, "high");
    }
  });
  log.info(`push notifications → ${server}/${topic}`);
}
