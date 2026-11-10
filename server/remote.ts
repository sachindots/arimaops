// Remote control safety (tablet/phone):
//  - Push: ntfy notification when something waits on you (action item, sandbox approval, access request).
//  - Step-up: risky commands from a non-local client need a TOTP code (authenticator app), once a day per device.
//  - Devices: logging in with a link token sets a cookie stored in ~/.hq/devices.json, so links survive restarts.
//  - Audit: every UI command is appended to ~/.hq/audit.log (never terminal input or secret values).
//  One server serves every project, so the TOTP secret, devices and audit log are server-wide (~/.hq/).

import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";
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
  "saveAccount",
  "removeAccount",
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
const REDACT_ARGS = new Set(["setSecret", "setProxy", "saveAccount"]);

const STEP_UP_MS = 24 * 60 * 60 * 1000;
const DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BAD_CODES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

/** owner: everything, including accounts and people. operator: runs the teams. viewer: watches and chats. */
export type Role = "owner" | "operator" | "viewer";
export const canOperate = (r: Role) => r === "owner" || r === "operator";
interface Device {
  role: Role;
  /** The person signed in on this device; missing for token-link devices. */
  userId?: string;
  created: number;
  lastSeen: number;
  elevatedUntil: number;
  label: string;
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
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

export function totp(secret: Buffer, step: number): string {
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
  private usedSteps = new Set<string>(); // "<who>:<step>": a code can't be replayed
  private auditFile: string;
  private devicesFile: string;
  private devices: Record<string, Device> = {};
  private badCodes = 0;
  private lockedUntil = 0;

  /** `adoptFrom`: a project whose older per-project totp-secret becomes the server's, so an authenticator entry you already added keeps working. */
  constructor(home = join(homedir(), BRAND.homeDir), adoptFrom?: string) {
    mkdirSync(home, { recursive: true });
    const file = join(home, "totp-secret");
    const old = adoptFrom ? join(projectHome(adoptFrom), "totp-secret") : "";
    if (!existsSync(file) && old && existsSync(old)) copyFileSync(old, file);
    if (!existsSync(file)) writeFileSync(file, base32Encode(randomBytes(20)), { mode: 0o600 });
    this.secretB32 = readFileSync(file, "utf8").trim();
    this.secret = base32Decode(this.secretB32);
    this.auditFile = join(home, "audit.log");
    this.devicesFile = join(home, "devices.json");
    try {
      this.devices = JSON.parse(readFileSync(this.devicesFile, "utf8")) as Record<string, Device>;
    } catch {
      this.devices = {};
    }
    const now = Date.now();
    for (const [id, d] of Object.entries(this.devices)) if (now - d.lastSeen > DEVICE_MS) delete this.devices[id];
  }

  private saveDevices() {
    try {
      writeFileSync(this.devicesFile, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    } catch (err) {
      log.warn("devices write failed:", err instanceof Error ? err.message : err);
    }
  }

  /** New device session after a valid link token. Returns the cookie value. Revoke by deleting it from devices.json and restarting. */
  addDevice(role: Role, label: string, userId?: string): string {
    const id = randomBytes(32).toString("hex");
    const now = Date.now();
    this.devices[id] = { role, created: now, lastSeen: now, elevatedUntil: 0, label: label.slice(0, 120), ...(userId ? { userId } : {}) };
    this.saveDevices();
    return id;
  }

  device(id: string): (Device & { id: string }) | null {
    const d = id ? this.devices[id] : undefined;
    if (!d || Date.now() - d.lastSeen > DEVICE_MS) return null;
    const now = Date.now();
    const stale = now - d.lastSeen > 60 * 60 * 1000;
    d.lastSeen = now;
    if (stale) this.saveDevices(); // persist lastSeen at most hourly
    return { ...d, id };
  }

  /** Ties a token-link device to the person it just created (the first owner). */
  bindDevice(id: string, userId: string) {
    const d = this.devices[id];
    if (!d) return;
    d.userId = userId;
    this.saveDevices();
  }

  /** Sign out: the cookie stops working. */
  removeDevice(id: string) {
    if (!(id in this.devices)) return;
    delete this.devices[id];
    this.saveDevices();
  }

  elevateDevice(id: string, until: number) {
    const d = this.devices[id];
    if (!d) return;
    d.elevatedUntil = until;
    this.saveDevices();
  }

  deviceElevatedUntil(id: string): number {
    return this.devices[id]?.elevatedUntil ?? 0;
  }

  readonly cookieMaxAge = DEVICE_MS / 1000;

  otpauthUrl() {
    const label = encodeURIComponent("dot hq:server");
    return `otpauth://totp/${label}?secret=${this.secretB32}&issuer=dot%20hq&digits=6&period=30`;
  }

  /** Accepts the current code ±1 step (clock drift); each step is usable once. `secretB32`: a person's own secret (default: the server's). */
  verify(code: string, secretB32?: string): boolean {
    // Brute-force guard: 5 wrong codes lock step-up for 5 minutes (a 6-digit code is otherwise guessable).
    if (Date.now() < this.lockedUntil) return false;
    const ok = this.check(code, secretB32 ? base32Decode(secretB32) : this.secret, secretB32 ?? "server");
    if (ok) this.badCodes = 0;
    else if (++this.badCodes >= MAX_BAD_CODES) {
      this.badCodes = 0;
      this.lockedUntil = Date.now() + LOCKOUT_MS;
      log.warn("step-up locked for 5 minutes after repeated wrong codes");
    }
    return ok;
  }

  private check(code: string, secret: Buffer, who: string): boolean {
    const clean = String(code ?? "").replace(/\D/g, "");
    if (clean.length !== 6) return false;
    const now = Math.floor(Date.now() / 30_000);
    for (const step of [now - 1, now, now + 1]) {
      const used = `${who}:${step}`;
      if (!this.usedSteps.has(used) && totp(secret, step) === clean) {
        this.usedSteps.add(used);
        for (const s of this.usedSteps) if (Number(s.slice(s.lastIndexOf(":") + 1)) < now - 2) this.usedSteps.delete(s);
        return true;
      }
    }
    return false;
  }

  stepUpUntil(): number {
    return Date.now() + STEP_UP_MS;
  }

  audit(entry: { project?: string; role: string; user?: string; origin: string; remote: boolean; cmd: string; args: unknown[]; result: "ok" | "blocked" | "step-up-required" | "error" | "elevated" | "bad-code" | "bad-password" | "throttled" }) {
    if (QUIET.has(entry.cmd) && entry.result === "ok") return;
    const args = REDACT_ARGS.has(entry.cmd) ? ["[redacted]"] : QUIET.has(entry.cmd) ? [] : entry.args;
    let argStr = "";
    try {
      argStr = JSON.stringify(args).slice(0, 500);
    } catch {
      argStr = "[unserializable]";
    }
    const line = `${new Date().toISOString()}\t${entry.result}\t${entry.user ? `${entry.user.replace(/\s/g, "_")}/` : ""}${entry.role}${entry.remote ? "@remote" : ""}\t${entry.origin || "-"}\t${entry.project ?? "-"}\t${entry.cmd}\t${argStr}\n`;
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
  // Tapping the notification opens this project on the right page (the app reads ?project= and ?open=).
  const link = (open: string) => (openUrl ? `${openUrl.replace(/\/$/, "")}/?project=${encodeURIComponent(hub.slug)}&open=${encodeURIComponent(open)}` : null);
  const push = (key: string, title: string, body: string, priority: "default" | "high", open = "actions") => {
    if (seen.has(key)) return;
    seen.add(key);
    const headers: Record<string, string> = { Title: `.hq ${hub.snap.config.project.name}: ${title}`.slice(0, 200), Priority: priority, Tags: "rotating_light" };
    const click = link(open);
    if (click) headers.Click = click;
    fetch(`${server.replace(/\/$/, "")}/${encodeURIComponent(topic)}`, { method: "POST", headers, body: body.slice(0, 1000) }).catch((err) =>
      log.warn("ntfy push failed:", err instanceof Error ? err.message : err),
    );
  };

  hub.subscribe((e: OfficeEvent) => {
    if (e.type === "action.updated" && e.item.status === "open") {
      push(`action:${e.item.id}`, `${name(e.item.fromId)} needs you`, e.item.title, e.item.waiting ? "high" : "default");
    } else if (e.type === "access.updated" && e.request.status === "pending") {
      push(`access:${e.request.id}`, `${name(e.request.agentId)} wants ${e.request.domain}`, e.request.reason || "Network access request", "high", `agent:${e.request.agentId}`);
    } else if (e.type === "sbx.updated") {
      for (const [agentId, st] of Object.entries(e.sbx.agents ?? {}))
        for (const ap of st.approvals ?? []) push(`sbx:${ap.id}`, `${name(agentId)} blocked: ${ap.host}`, ap.title ?? ap.detail, "high", `agent:${agentId}`);
    }
  });
  log.info(`push notifications → ${server}/${topic}`);
}
