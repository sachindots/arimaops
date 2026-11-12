// SPDX-License-Identifier: AGPL-3.0-or-later
// Where GitHub news comes from (docs/core-model.md section 8). GitHubSync only listens; it never
// fetches. Today that is GhPolling (the `gh` GraphQL poll, paced to HQ's share of the rate limit).
// Phase 3 adds GitHub App webhooks as a second implementation, with polling as its fallback.

import { fetchPrs, RateLimited, type GhPr } from "./github";
import { log } from "./lib/log";

export type GitHubEvent =
  /** The repo's open PRs, recently merged ones, and numbers of recently closed ones. */
  | { type: "prs"; open: GhPr[]; merged: GhPr[]; closed: number[] }
  | { type: "rate-limited"; until: Date }
  | { type: "error"; message: string };

export interface GitHubWatch {
  /** Look again soon: an agent may have just opened a PR. Sources that push news may ignore it. */
  nudge(delayMs?: number): void;
  stop(): void;
}

export interface GitHubEvents {
  watch(repo: string, on: (e: GitHubEvent) => void): GitHubWatch;
}

const MIN_POLL_MS = 20_000; // never more often than this (nudges included)
const MAX_POLL_MS = 5 * 60_000;
const HQ_BUDGET = 1200; // GraphQL points per hour HQ may use; the rest of the 5,000 is left for the agents' gh commands
const LOW_REMAINING = 800; // below this, poll at most every 2 minutes

/** Polls with `gh`. `ready` says whether gh is signed in (the setup check); until then nothing is fetched. */
export class GhPolling implements GitHubEvents {
  constructor(private ready: () => boolean = () => true, private fetch = fetchPrs) {}

  watch(repo: string, on: (e: GitHubEvent) => void): GitHubWatch {
    let running = true;
    let busy = false;
    let lastFetch = 0;
    let interval = MIN_POLL_MS;
    let pausedUntil = 0;
    let lastError: string | null = null;
    let timer: NodeJS.Timeout | null = null;
    let nudgeTimer: NodeJS.Timeout | null = null;

    const poll = async () => {
      if (!running || busy || Date.now() < pausedUntil) return;
      // Never closer together than the minimum gap (a nudge can land right after a regular poll).
      if (Date.now() - lastFetch < MIN_POLL_MS - 1000 || !this.ready()) return;
      busy = true;
      lastFetch = Date.now();
      try {
        const { open, merged, closed, rate } = await this.fetch(repo);
        if (lastError) log.info("GitHub reachable again");
        lastError = null;
        if (rate) {
          const forBudget = Math.ceil((Math.max(1, rate.cost) * 3_600_000) / HQ_BUDGET);
          const low = rate.remaining < LOW_REMAINING ? 120_000 : 0;
          interval = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, forBudget, low));
        }
        on({ type: "prs", open, merged, closed });
      } catch (err) {
        if (err instanceof RateLimited) {
          pausedUntil = err.resetAt.getTime() + 5000;
          on({ type: "rate-limited", until: err.resetAt });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message !== lastError) on({ type: "error", message });
        lastError = message;
      } finally {
        busy = false;
      }
    };
    const tick = async () => {
      await poll();
      if (!running) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), Math.max(interval, pausedUntil - Date.now()));
    };
    void tick();

    return {
      nudge(delayMs = 3000) {
        if (!running) return;
        if (nudgeTimer) clearTimeout(nudgeTimer);
        const wait = Math.max(delayMs, lastFetch + MIN_POLL_MS - Date.now(), pausedUntil - Date.now());
        nudgeTimer = setTimeout(() => void poll(), wait);
      },
      stop() {
        running = false;
        if (timer) clearTimeout(timer);
        if (nudgeTimer) clearTimeout(nudgeTimer);
      },
    };
  }
}
