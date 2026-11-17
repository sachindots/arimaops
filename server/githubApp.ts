// SPDX-License-Identifier: AGPL-3.0-or-later
// GitHub App and webhooks (docs/agent-engine.md section 6). The owner creates the App with GitHub's manifest
// flow; its id goes to ~/.arima/github-app.json, its private key and webhook secret to the vault. GitHub reaches
// HQ through Tailscale Funnel on the webhook path only (deploy/github-webhook.sh). A delivery is a hint: HQ checks
// its signature, drops repeats, and has that repo's sync fetch again right away, so the `gh` snapshot stays the
// one source of truth. While deliveries arrive, the poll slows to every 5 minutes; after 10 quiet minutes it is
// back at its normal pace.

import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";
import { WEBHOOK_EVENTS, WEBHOOK_PATH } from "../src/data/githubApp";
import type { GitHubAppState } from "../src/data/types";
import { credentialsVault } from "./credentials/registry";
import { GhPolling, type GitHubEvent, type GitHubEvents, type GitHubWatch } from "./githubEvents";
import { readDoc, writeDoc } from "./lib/docs";
import { homeRoot } from "./paths";

export { WEBHOOK_PATH };
export const HEALTHY_MS = 10 * 60_000;
const SECRET_REF = "github-app:webhook-secret";
const KEY_REF = "github-app:private-key";
const appFile = () => join(homeRoot(), "github-app.json");

interface AppRecord {
  id: number;
  slug: string;
  htmlUrl: string;
  owner: string;
  createdAt: string;
}

// ---------------------------------------------------------------- deliveries

const lastDelivery = new Map<string, number>(); // repo (lowercase owner/name) → ms
const listeners = new Map<string, Set<() => void>>();
const seen: string[] = []; // recent delivery ids, oldest first
const SEEN_MAX = 500;

/** GitHub's `X-Hub-Signature-256` over the exact body, compared in constant time. */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** True while a delivery for this repo arrived in the last 10 minutes. */
export const webhooksHealthy = (repo: string, now = Date.now()) => now - (lastDelivery.get(repo.toLowerCase()) ?? 0) < HEALTHY_MS;

/** Calls `fn` on every accepted delivery for `repo`; returns the unsubscribe. */
export function onDelivery(repo: string, fn: () => void): () => void {
  const key = repo.toLowerCase();
  const set = listeners.get(key) ?? new Set();
  set.add(fn);
  listeners.set(key, set);
  return () => set.delete(fn);
}

/**
 * One POST to the webhook path. Returns the HTTP status: 401 for a bad or missing signature (nothing else is read),
 * 202 for an accepted or repeated delivery, 204 for events HQ doesn't use, 503 when no App is set up here.
 */
export function handleWebhook(headers: Record<string, string | string[] | undefined>, body: string, secret = webhookSecret(), now = Date.now()): number {
  if (!secret) return 503;
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  if (!verifySignature(secret, body, h("x-hub-signature-256"))) return 401;
  const id = h("x-github-delivery") ?? "";
  if (id && seen.includes(id)) return 202; // GitHub redelivers on timeouts
  if (id) {
    seen.push(id);
    if (seen.length > SEEN_MAX) seen.shift();
  }
  const event = h("x-github-event") ?? "";
  if (event === "ping") return 202;
  if (!WEBHOOK_EVENTS.includes(event)) return 204;
  let repo = "";
  try {
    repo = String((JSON.parse(body) as { repository?: { full_name?: string } }).repository?.full_name ?? "").toLowerCase();
  } catch {
    return 400;
  }
  if (!repo) return 204;
  lastDelivery.set(repo, now);
  for (const fn of listeners.get(repo) ?? []) fn();
  return 202;
}

/**
 * Webhooks with the poll as fallback: every delivery for the repo makes the poll fetch now (it keeps its minimum
 * gap and rate budget); while deliveries arrive the poll itself slows to 5 minutes.
 */
export class GitHubAppWebhooks implements GitHubEvents {
  constructor(private poll: GhPolling) {}

  watch(repo: string, on: (e: GitHubEvent) => void): GitHubWatch {
    const w = this.poll.watch(repo, on);
    const off = onDelivery(repo, () => w.nudge(1500));
    return {
      nudge: (ms) => w.nudge(ms),
      stop: () => {
        off();
        w.stop();
      },
    };
  }
}

// ---------------------------------------------------------------- the App

export function webhookSecret(): string | null {
  try {
    return readDoc<AppRecord>(appFile()) ? credentialsVault().get(SECRET_REF) : null;
  } catch {
    return null; // vault locked or unreadable: no webhooks
  }
}

export function githubAppState(): GitHubAppState {
  const app = readDoc<AppRecord>(appFile());
  const last = Math.max(0, ...lastDelivery.values());
  return {
    app: app ? { id: app.id, slug: app.slug, htmlUrl: app.htmlUrl, owner: app.owner, installUrl: `${app.htmlUrl}/installations/new` } : null,
    webhookPath: WEBHOOK_PATH,
    lastDeliveryAt: last ? new Date(last).toISOString() : null,
  };
}

/** Trades the manifest flow's one-time code for the App's credentials and saves them (owner only, from http.ts). */
export async function finishManifest(code: string, fetcher: typeof fetch = fetch): Promise<GitHubAppState> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new Error("That isn't a GitHub manifest code.");
  const r = await fetcher(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": BRAND.name },
  });
  if (!r.ok) throw new Error(`GitHub refused the code (${r.status}). Codes work once and for an hour: create the App again.`);
  const a = (await r.json()) as { id?: number; slug?: string; html_url?: string; owner?: { login?: string }; pem?: string; webhook_secret?: string };
  if (!a.id || !a.slug || !a.pem || !a.webhook_secret) throw new Error("GitHub's answer is missing the App's id, key or webhook secret.");
  const vault = credentialsVault();
  vault.set(KEY_REF, a.pem);
  vault.set(SECRET_REF, a.webhook_secret);
  writeDoc(appFile(), { id: a.id, slug: a.slug, htmlUrl: a.html_url ?? `https://github.com/apps/${a.slug}`, owner: a.owner?.login ?? "", createdAt: new Date().toISOString() } satisfies AppRecord);
  return githubAppState();
}
