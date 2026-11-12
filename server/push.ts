import { createPrivateKey, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BRAND } from "../src/data/brand";
import type { OfficeEvent } from "../src/data/source";
import type { Hub } from "./hub";
import type { UserRole } from "./users";
import { credentialsVault, redactor } from "./credentials/registry";
import { log } from "./lib/log";
import { readDoc, writeDoc } from "./lib/docs";

const serviceAccount = z.object({
  type: z.literal("service_account"),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  client_email: z.email().endsWith(".gserviceaccount.com"),
  private_key: z.string().min(100),
});
type ServiceAccount = z.infer<typeof serviceAccount>;

export function parseServiceAccount(raw: string): ServiceAccount {
  try {
    const account = serviceAccount.parse(JSON.parse(raw));
    if (createPrivateKey(account.private_key).asymmetricKeyType !== "rsa") throw new Error();
    return account;
  } catch {
    throw new Error("Invalid Firebase service-account JSON or RSA key.");
  }
}

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const oauthResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

export class FcmSender {
  private cached: { credential: string; token: string; expires: number } | null = null;
  constructor(private readonly credential: () => string | null, private readonly request: typeof fetch = fetch) {}

  async accessToken() {
    const raw = this.credential();
    if (!raw) return null;
    const account = parseServiceAccount(raw);
    if (this.cached?.credential === raw && this.cached.expires > Date.now() + 60_000) return { account, token: this.cached.token };
    const now = Math.floor(Date.now() / 1000);
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const claims = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: OAUTH_URL, iat: now, exp: now + 3600 })}`;
    const assertion = `${claims}.${sign("RSA-SHA256", Buffer.from(claims), account.private_key).toString("base64url")}`;
    const response = await this.request(OAUTH_URL, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!response.ok) throw new Error(`Firebase authorization failed (HTTP ${response.status}).`);
    const data = oauthResponse.safeParse(await response.json());
    if (!data.success) throw new Error("Invalid Firebase authorization response.");
    this.cached = { credential: raw, token: data.data.access_token, expires: Date.now() + data.data.expires_in * 1000 };
    return { account, token: data.data.access_token };
  }

  /** False means FCM permanently removed this device token. Other failures retain it. */
  async send(token: string, server: string, alert: PushAlert, canSend = () => true): Promise<"sent" | "unregistered" | "unconfigured" | "skipped"> {
    const auth = await this.accessToken();
    if (!auth) return "unconfigured";
    if (!canSend()) return "skipped";
    const response = await this.request(`https://fcm.googleapis.com/v1/projects/${auth.account.project_id}/messages:send`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token, android: { priority: "high", ttl: "3600s" }, data: { title: alert.title, body: alert.body, path: alert.path, server } } }),
    });
    if (response.ok) return "sent";
    if (response.status === 401) this.cached = null;
    const failure = z.object({ error: z.object({ details: z.array(z.object({ errorCode: z.string().optional() }).passthrough()).optional() }) }).safeParse(await response.json().catch(() => null));
    if (failure.success && failure.data.error.details?.some((d) => d.errorCode === "UNREGISTERED")) return "unregistered";
    // FCM errors can echo tokens and message bodies; never log the response.
    throw new Error(`Firebase delivery failed (HTTP ${response.status}).`);
  }
}

export interface PushAlert {
  key: string;
  title: string;
  body: string;
  path: string;
  operatorsOnly: boolean;
}

export function pushAlert(hub: Pick<Hub, "slug" | "snap">, event: OfficeEvent): PushAlert | null {
  const path = (open: string) => `/?${new URLSearchParams({ project: hub.slug, open })}`;
  const alert = (key: string, title: string, body: string, open: string, operatorsOnly = false): PushAlert => ({
    key, title: `${BRAND.name} · ${hub.snap.config.project.name}: ${title}`.slice(0, 160),
    body: redactor().redact(body).slice(0, 400), path: path(open), operatorsOnly,
  });
  if (event.type === "agent.updated" && event.agent.state === "needs-input")
    return alert(`agent:${event.agent.agentId}:${event.agent.stateSince}`, "Agent needs you", event.agent.note ?? "Open HQ to check the agent.", `agent:${event.agent.agentId}`, true);
  if (event.type === "action.updated" && event.item.status === "open")
    return alert(`action:${event.item.id}`, "Action needed", event.item.title, "actions", true);
  if (event.type === "access.updated" && event.request.status === "pending")
    return alert(`access:${event.request.id}`, "Access requested", event.request.reason || event.request.domain, `agent:${event.request.agentId}`, true);
  if (event.type === "finding.updated" && ["critical", "high"].includes(event.finding.severity) && ["open", "confirmed"].includes(event.finding.status))
    return alert(`finding:${event.finding.id}:${event.finding.severity}`, `${event.finding.severity} finding`, event.finding.title, "findings");
  if (event.type === "activity") {
    if (event.event.type === "agent.needs-input")
      return alert(`activity:${event.event.id}:${event.event.at}`, "Agent needs attention", event.event.text, event.event.agentId ? `agent:${event.event.agentId}` : "actions", true);
    if (event.event.type === "pr.merged" || event.event.type === "deploy")
      return alert(`activity:${event.event.id}:${event.event.at}`, event.event.type === "pr.merged" ? "Pull request merged" : "Release deployed", event.event.text, "board");
  }
  if (event.type === "env.updated" && event.env.status === "live")
    return alert(`deploy:${event.env.name}:${event.env.lastDeployAt}`, "Release deployed", event.env.name, "board");
  return null;
}

const registration = z.object({
  deviceId: z.string().min(1), userId: z.string().min(1),
  token: z.string().min(20).max(4096).regex(/^\S+$/),
  server: z.url(),
});
type Registration = z.infer<typeof registration>;
export const pushRegistrationBody = registration.pick({ token: true });

export class PushDevices {
  private devices: Registration[];
  constructor(
    private readonly authorize: (deviceId: string, userId: string) => UserRole | null,
    private readonly sender = new FcmSender(() => existsSync(join(homedir(), BRAND.homeDir, "vault.json")) ? credentialsVault().get("push:fcm") : null),
    private readonly file = join(homedir(), BRAND.homeDir, "push-devices.json"),
  ) {
    this.devices = z.array(registration).parse(readDoc(file) ?? []);
  }

  register(input: Registration) {
    const device = registration.parse(input);
    const url = new URL(device.server);
    if (url.origin !== device.server || url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
      throw new Error("Push registration needs an HTTPS origin or localhost.");
    this.devices = this.devices.filter((d) => d.deviceId !== device.deviceId && d.token !== device.token);
    this.devices.push(device);
    this.save();
  }

  remove(deviceId: string, token?: string) {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId || (token !== undefined && d.token !== token));
    this.save();
  }

  async notify(alert: PushAlert) {
    for (const device of [...this.devices]) {
      const role = this.authorize(device.deviceId, device.userId);
      if (!role) { this.remove(device.deviceId, device.token); continue; }
      if (role === "viewer" && alert.operatorsOnly) continue;
      // Check the live session for each alert; sign-out and role changes apply without restarting HQ.
      try {
        const result = await this.sender.send(device.token, device.server, alert, () => {
          const current = this.authorize(device.deviceId, device.userId);
          return current !== null && !(current === "viewer" && alert.operatorsOnly)
            && this.devices.some((d) => d.deviceId === device.deviceId && d.token === device.token);
        });
        if (result === "unregistered") this.remove(device.deviceId, device.token);
        else if (result === "unconfigured") log.warn("Firebase push is not configured. Store a service account under push:fcm.");
      } catch (error) {
        log.warn(error instanceof Error ? error.message : "Firebase delivery failed.");
      }
    }
  }

  watch(hub: Pick<Hub, "slug" | "snap" | "subscribe">) {
    const seen = new Set<string>();
    for (const a of hub.snap.agents) if (a.state === "needs-input") seen.add(`agent:${a.agentId}:${a.stateSince}`);
    for (const a of hub.snap.actionItems ?? []) if (a.status === "open") seen.add(`action:${a.id}`);
    for (const r of hub.snap.accessRequests ?? []) if (r.status === "pending") seen.add(`access:${r.id}`);
    for (const f of hub.snap.findings ?? []) seen.add(`finding:${f.id}:${f.severity}`);
    for (const e of hub.snap.environments) seen.add(`deploy:${e.name}:${e.lastDeployAt}`);
    const attention = new Map<string, number>();
    return hub.subscribe((event) => {
      const alert = pushAlert(hub, event);
      if (!alert || seen.has(alert.key)) return;
      seen.add(alert.key);
      // Both state and activity events describe the same wait; also limit repeated stall warnings.
      const agent = event.type === "agent.updated" ? event.agent.agentId : event.type === "activity" && event.event.type === "agent.needs-input" ? event.event.agentId ?? "all" : null;
      if (agent) {
        if (Date.now() - (attention.get(agent) ?? 0) < 60_000) return;
        attention.set(agent, Date.now());
      }
      const oldest = seen.values().next().value;
      if (seen.size > 2000 && oldest) seen.delete(oldest);
      void this.notify(alert).catch(() => log.warn("Could not update push device registrations."));
    });
  }

  private save() {
    writeDoc(this.file, this.devices);
  }
}
