// Agents that were running when HQ went down come back up. In Docker, tmux lives inside the HQ container, so a
// restart ends every session without a "stopped" event: the list saved on each session change still names them.
import { join } from "node:path";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { readDoc, writeDoc } from "./lib/docs";
import { projectHome } from "./paths";

const RESUME_AFTER_MS = 8000; // the first poll has reattached any session that survived

export function resumeAgents(hub: Hub, start: (agentId: string) => Promise<void>, delayMs = RESUME_AFTER_MS) {
  const file = join(projectHome(hub.slug), "running-agents.json");
  const saved = new Set(readDoc<{ running?: string[] }>(file)?.running ?? []);
  const running = () => hub.snap.agents.filter((a) => a.session.state === "running" || a.session.state === "starting").map((a) => a.agentId);

  let last = "";
  const save = () => {
    const now = JSON.stringify(running().sort());
    if (now === last) return;
    last = now;
    writeDoc(file, { running: JSON.parse(now) });
  };
  const timer = setTimeout(async () => {
    const team = new Set(hub.snap.config.team.map((a) => a.id));
    const down = [...saved].filter((id) => team.has(id) && hub.status(id)?.session.state !== "running" && hub.status(id)?.session.state !== "starting");
    if (down.length) log.info(`${hub.slug}: restarting ${down.length} agent(s) that were running before HQ restarted`);
    for (const id of down) {
      hub.activity("session", id, `${hub.name(id)} restarted after HQ restarted`);
      await start(id).catch((e) => log.warn(`${hub.slug}: couldn't restart ${id}: ${e instanceof Error ? e.message : e}`));
    }
    // Only now track changes: before this, "stopped" is HQ's starting state, not something the owner did.
    hub.subscribe((e) => e.type === "agent.updated" && save());
    save();
  }, delayMs);
  return () => clearTimeout(timer);
}
