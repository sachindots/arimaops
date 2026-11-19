// Agents that were intentionally started come back up after an HQ restart or host reboot.
// Intent is tracked on explicit start/stop calls rather than live session state, so containers or
// tmux sessions that die on a host reboot stay in the list instead of wiping it during shutdown.
import { join } from "node:path";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { readDoc, writeDoc } from "./lib/docs";
import { projectHome } from "./paths";

const RESUME_AFTER_MS = 8000; // the first poll has reattached any session that survived

export interface ResumeTracker {
  markStarted(agentId: string): void;
  markStopped(agentId: string): void;
  stop(): void;
}

export function resumeAgents(
  hub: Hub,
  start: (agentId: string) => Promise<void>,
  opts: number | { delayMs?: number; autoStart?: boolean } = RESUME_AFTER_MS,
): ResumeTracker {
  const delayMs = typeof opts === "number" ? opts : (opts.delayMs ?? RESUME_AFTER_MS);
  const autoStart = typeof opts === "number" ? true : (opts.autoStart ?? true);
  const file = join(projectHome(hub.slug), "running-agents.json");
  const wanted = new Set<string>(readDoc<{ running?: string[] }>(file)?.running ?? []);

  let last = "";
  const persist = () => {
    const team = new Set(hub.snap.config.team.map((a) => a.id));
    const list = [...wanted].filter((id) => team.has(id)).sort();
    const now = JSON.stringify(list);
    if (now === last) return;
    last = now;
    writeDoc(file, { running: list });
  };

  const timer = autoStart
    ? setTimeout(async () => {
        const team = new Set(hub.snap.config.team.map((a) => a.id));
        for (const a of hub.snap.agents) {
          if (team.has(a.agentId) && (a.session.state === "running" || a.session.state === "starting")) wanted.add(a.agentId);
        }
        const down = [...wanted].filter((id) => team.has(id) && hub.status(id)?.session.state !== "running" && hub.status(id)?.session.state !== "starting");
        if (down.length) log.info(`${hub.slug}: restarting ${down.length} agent(s) that were running before HQ restarted`);
        for (const id of down) {
          hub.activity("session", id, `${hub.name(id)} restarted after HQ restarted`);
          await start(id).catch((e) => log.warn(`${hub.slug}: couldn't restart ${id}: ${e instanceof Error ? e.message : e}`));
        }
        persist();
      }, delayMs)
    : null;

  return {
    markStarted(agentId: string) {
      wanted.add(agentId);
      persist();
    },
    markStopped(agentId: string) {
      wanted.delete(agentId);
      persist();
    },
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}
