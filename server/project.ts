// One project's runtime inside the shared server: its hub, agents, planner, sandbox and GitHub sync.
// main.ts starts one per registered project; http.ts routes browsers (by ?project=) and agents (by their own token) to it.

import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";
import { ActionItems } from "./actionItems";
import { Findings } from "./findings";
import { broadcastMemory, makeCommands, projectMemoryState } from "./commands";
import { GitHubSync } from "./githubSync";
import { Hub } from "./hub";
import { Inbox } from "./inbox";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { agentToken, sessionName } from "./paths";
import { Planner } from "./planner";
import { setLiveProject } from "./projectsRegistry";
import { accountsState } from "./credentials/registry";
import { accountHome, accountOf, markLimited, onAccountLimit, shareLimit } from "./accounts";
import { OnDemand } from "./onDemand";
import { githubAppState } from "./githubApp";
import { Overflow } from "./overflow";
import { capsOf, SpendGuard, spendPaused } from "./spendCaps";
import { detectRepo } from "./repo";
import { Sbx } from "./sbx";
import { SbxMcp } from "./sbxMcp";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan, slugOf } from "./store";
import { containerLogHome } from "./containers";
import { LoopGuard, toolEvent } from "./loopguard";
import { resolveUserSkillFolders } from "./skills";
import { sumModels, UsageMeter } from "./usage";
import { recordMeter } from "./usageEvents";
import { memoryStore, setMemoryScope } from "./memory";
import { memoryWorker } from "./memoryJobs";
import { MemoryReview } from "./memoryReview";
import { hqDb } from "./lib/db";
import { accounts } from "./credentials/registry";
import type { Provider } from "../src/data/providers";
import type { AgentCli } from "../src/data/types";

/** The CLIs whose logs HQ can meter, and whose model provider they bill. */
const METERED: Partial<Record<AgentCli, Provider>> = { claude: "anthropic", codex: "openai" };
/** An API-key or cloud account's provider; null for a subscription sign-in. */
const accountProvider = (id: string): Provider | null => {
  try {
    return accounts().get(id)?.provider ?? null;
  } catch {
    return null; // vault not open: fall back to the CLI's provider
  }
};
import { workspaceFor } from "./workspace";

export interface Runtime {
  slug: string;
  root: string;
  hub: Hub;
  inbox: Inbox;
  planner: Planner;
  /** Sees every finished tool call (hook route) to spot an agent stuck in a loop. */
  onToolDone(agentId: string, event: string, body: Record<string, unknown>): void;
  /** Project secret; each agent's token is derived from it (paths.agentTokenFor). */
  agentSecret: string;
  commands: Record<string, (...args: unknown[]) => unknown>;
  /** Memories waiting for the user's check, and their pushes. */
  memoryReview: MemoryReview;
  isNew: boolean;
  paused: boolean;
  recheckSetup(): Promise<void>;
  /** Plain-text screen previews of running agents (last `lines` lines each). */
  screens(lines: number): Promise<Record<string, string>>;
  pause(): void;
  resume(): void;
  shutdown(): void;
}

/**
 * Moves a project's older folders to the ArimaOps names, once:
 * - <repo>/.hq or .jsmhq → <repo>/.arima, but only when git doesn't track it (a committed folder keeps
 *   working where it is; moving it would leave changes in your repo). `git mv .hq .arima` when convenient.
 * - ~/.jsmhq/<slug> → ~/.arima/<slug> (the whole ~/.arima is moved at start-up, see migrateHome).
 * Skipped while that project's agents run in tmux (their folders are in use); the fallbacks in paths/store still find it.
 */
export async function migrateLegacy(root: string, slug: string): Promise<void> {
  const repoNew = join(root, BRAND.repoDir);
  for (const old of BRAND.legacyRepoDirs.map((d) => join(root, d))) {
    if (!existsSync(old) || existsSync(repoNew)) continue;
    const tracked = await run("git", ["ls-files", "--error-unmatch", "--", old.slice(root.length + 1)], { cwd: root });
    if (tracked.ok) {
      log.info(`${old} is committed in git, so it stays; HQ reads it there. Rename it with: git mv ${old.slice(root.length + 1)} ${BRAND.repoDir}`);
      break;
    }
    renameSync(old, repoNew);
    log.info(`migrated ${old} → ${repoNew}`);
  }
  const homeNew = join(homedir(), BRAND.homeDir, slug);
  // An old folder that is now a link to ~/.arima (after migrateHome) is the same place, not a legacy copy.
  const realOld = (d: string) => existsSync(join(homedir(), d)) && !lstatSync(join(homedir(), d)).isSymbolicLink();
  const homeOld = BRAND.legacyHomeDirs.filter(realOld).map((d) => join(homedir(), d, slug)).find((d) => existsSync(d));
  if (!homeOld || existsSync(homeNew)) return;
  const tmux = await run("tmux", ["ls", "-F", "#{session_name}"]);
  if (tmux.ok && tmux.stdout.split("\n").some((s) => s.startsWith(`hq-${slug}-`))) {
    log.warn(`not migrating ${homeOld}: agents of ${slug} are running. Stop them and restart HQ to migrate.`);
    return;
  }
  mkdirSync(join(homedir(), BRAND.homeDir), { recursive: true });
  renameSync(homeOld, homeNew);
  log.warn(`migrated ${homeOld} → ${homeNew}. Sandboxed agents of ${slug} need "Recreate sandbox" once (their folder moved).`);
}

/**
 * Moves the whole machine folder ~/.arima → ~/.arima at start-up (people, vault, devices, audit log, ports,
 * agents' folders) and leaves a link at ~/.arima, so anything still pointing there keeps working. Only when
 * ~/.arima doesn't exist yet: two folders are never merged.
 */
export function migrateHome(home = homedir()): "moved" | "none" | "both" {
  const next = join(home, BRAND.homeDir);
  const old = join(home, BRAND.legacyHomeDirs[0]);
  if (!existsSync(old) || lstatSync(old).isSymbolicLink()) return "none";
  if (existsSync(next)) {
    log.warn(`both ${old} and ${next} exist; HQ uses ${next}. Move anything you still need from ${old} by hand.`);
    return "both";
  }
  renameSync(old, next);
  symlinkSync(BRAND.homeDir, old);
  log.info(`moved ${old} → ${next} (a link stays at ${old})`);
  return "moved";
}

export async function startProject(path: string, port: number, paused: boolean): Promise<Runtime> {
  const repo = await detectRepo(path);
  await migrateLegacy(repo.root, slugOf(repo));
  const { config, isNew } = loadConfig(repo, port);
  config.project.hqPort = port;
  const slug = config.project.id;
  const secret = agentToken(slug);

  const setup = await runSetupChecks(repo, config.team, port, config.project);
  const bad = setup.checks.filter((c) => c.status !== "ok");
  log.info(`project ${slug}  ${repo.root}${bad.length ? `  (${bad.length} setup checks need attention)` : ""}`);

  const hub = new Hub(repo, slug, config, loadPlan(repo.root, config), setup);
  hub.snap.accounts = accountsState();
  hub.snap.githubApp = githubAppState();
  hub.snap.welcome = isNew;
  hub.snap.customSkills = [...resolveUserSkillFolders(repo.root, ["*"]).keys()].sort();
  const sessions = new Sessions(hub, secret);
  const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id), promptReady: (id) => sessions.promptReady(id) });
  sessions.onSessionDown = (id) => inbox.sessionDown(id);
  sessions.onSessionReattached = (id) => inbox.sessionReattached(id);
  sessions.lastHookAt = (id) => inbox.lastHookAt(id);
  const sbx = new Sbx(hub);
  sessions.envFileFor = (id) => (existsSync(sbx.envFile(id)) ? sbx.envFile(id) : null);
  const mcp = new SbxMcp(hub, (id, file, args, onExit) => sessions.runTerminal(id, file, args, onExit));
  sessions.onSandboxReady = (id) => {
    void sbx.syncRules(id);
    void mcp.attachAll(id);
    void sbx.refreshPorts(id);
  };
  sessions.onSessionDown = ((down) => (id: string) => {
    down(id);
    void sbx.refreshPorts(id);
  })(sessions.onSessionDown);
  sessions.onSandboxRemoved = (id) => {
    mcp.forget(id);
    void sbx.refreshPorts(id);
  };
  void sbx.refresh();
  void mcp.refresh();
  const planner = new Planner(hub, inbox);
  const meter = new UsageMeter();
  const byModelOf = (id: string) => {
    const a = hub.cfg(id);
    if (!a) return null;
    const home = a.mode === "container" ? containerLogHome(sessionName(slug, a.id)) : accountHome(a.cli, accountOf(a));
    return meter.readByModel(a.cli, a.mode === "container" ? "/work" : workspaceFor(a, slug), home, a.model || a.cli);
  };
  planner.lastActivityAt = (id) => inbox.lastHookAt(id);
  const onDemand = new OnDemand(hub, sessions, () => (spendPaused(slug) ? "the spend cap to lift (the project is paused)" : null));
  const overflow = new Overflow(hub, planner, sessions);
  const spendGuard = new SpendGuard(slug, hqDb(), () => capsOf(hub.snap.config.project.spendCaps), () => {
    try {
      return accounts().views().map((a) => a.id); // API-key and cloud accounts: the ones with a bill
    } catch {
      return []; // vault locked: nothing to count
    }
  }, {
    stopWorkers: async () => {
      for (const a of hub.snap.config.team) {
        const s = hub.status(a.id)?.session.state;
        if (!a.isLead && (s === "running" || s === "starting")) await sessions.stop(a.id);
      }
    },
    tellLead: (text) => {
      const lead = hub.snap.config.team.find((a) => a.isLead);
      if (lead) planner.notify(lead.id, text);
    },
    alert: (id, title, details) => planner.actions?.addSpend(id, title, details),
    changed: (spend) => {
      hub.snap.spend = spend;
      hub.emit({ type: "spend.updated", spend });
    },
  });
  planner.onReady = (id) => onDemand.ready(id);
  inbox.holds = (agentId, item) => {
    if (!onDemand.onDemand(agentId) || item.kind !== "message" || item.fromId === "you") return false;
    return !hub.cfg(item.fromId)?.isLead;
  };
  inbox.isStale = (agentId, taskId) => {
    const t = planner.task(taskId);
    return !t || t.ownerId !== agentId || t.status === "done";
  };
  const refreshUsage = () => {
    planner.checkStalls(Date.now());
    void onDemand.tick();
    overflow.tick();
    for (const a of hub.snap.config.team) {
      const m = byModelOf(a.id);
      const u = m && sumModels(m);
      if (JSON.stringify(u) !== JSON.stringify(hub.status(a.id)?.usage ?? null)) hub.setStatus(a.id, { usage: u });
      const provider = METERED[a.cli];
      if (!m || !provider) continue;
      const account = accountOf(a);
      try {
        recordMeter(hqDb(), { projectId: slug, agentId: a.id, taskId: hub.status(a.id)?.currentTaskId ?? null, account, provider: accountProvider(account) ?? provider, cli: a.cli }, m);
      } catch (err) {
        log.warn(`couldn't record usage for ${a.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    void spendGuard.check().catch((err) => log.warn(`spend check failed: ${err instanceof Error ? err.message : err}`));
  };
  const guard = new LoopGuard(
    async () => null, // no model judge: the repeated-failure rule decides
    (agentId, taskId, nudge, reason) => {
      planner.notify(agentId, nudge);
      const lead = hub.snap.config.team.find((a) => a.isLead);
      if (lead && lead.id !== agentId) planner.notify(lead.id, `${hub.name(agentId)} looks stuck on ${taskId} (${reason}). HQ nudged it once; step in if it doesn't recover.`);
      hub.activity("agent.needs-input", agentId, `${hub.name(agentId)} looks stuck on ${taskId}: ${reason}`);
    },
  );
  refreshUsage();
  const usageTimer = setInterval(refreshUsage, 30_000);
  planner.actions = new ActionItems(hub, planner);
  planner.actions.onMove = (m) => overflow.move(m);
  planner.onLeadApproval = (task, gateId, stageId, note) => {
    const lead = hub.snap.config.team.find((a) => a.isLead);
    if (lead) planner.actions?.addApproval(lead.id, task.id, task.title, gateId, stageId, note);
  };
  const memoryReview = new MemoryReview(hub, planner.actions, memoryStore());
  void memoryReview.sync();
  planner.findings = new Findings(hub);
  planner.memory = memoryStore();
  memoryStore().onChange ??= broadcastMemory;
  planner.memoryJobs = memoryWorker();
  setMemoryScope(hub.snap.config.project.id, () => hub.snap.config.project.scope);
  hub.snap.memory = projectMemoryState(hub.snap.config.project.id);
  // A usage limit is the account's, not the agent's: every agent on that CLI, in every project, stops too.
  const stopListening = onAccountLimit((cli, until, from) => {
    const marked = markLimited(hub, cli, until, from);
    if (!marked.length) return;
    const at = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const acct = `${cli}${from.account === "default" ? "" : ` (${from.account})`}`;
    hub.activity("agent.needs-input", null, `${marked.join(", ")} paused until ${at}: the ${acct} account hit its usage limit (${from.name}${from.project === slug ? "" : ` in ${from.project}`}).`);
    const lead = hub.snap.config.team.find((a) => a.isLead);
    if (lead && !marked.includes(lead.name))
      planner.notify(lead.id, `The ${acct} subscription hit its usage limit until ${at}, so ${marked.join(", ")} can't work until then. Move urgent tasks to agents on another CLI, or wait.`);
  });
  sessions.onLimit = (id, until) => {
    const agentCfg = hub.cfg(id);
    if (agentCfg) shareLimit(agentCfg.cli, until, { project: slug, agentId: id, name: agentCfg.name, account: accountOf(agentCfg) });
    if (overflow.offer(id, until)) return; // the owner decides: Move to the fallback, or Wait
    const lead = hub.snap.config.team.find((a) => a.isLead);
    const agent = hub.cfg(id);
    if (!lead || !agent || lead.id === id) return;
    const task = planner.currentTask(id);
    planner.notify(
      lead.id,
      `${agent.name} (${agent.cli}) hit its usage limit until ${until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${task ? ` Its task ${task.id} is stuck: reassign it to a free agent on another CLI (update_task cli if it was pinned), or wait.` : ""} Don't assign ${agent.name} new work until then.`,
    );
  };
  const github = new GitHubSync(hub, planner, repo.github);
  // Terminal polling always runs: agents left in tmux must keep reporting. Pause stops GitHub and sbx approval polling.
  sessions.startPolling();

  const rt: Runtime = {
    onToolDone(agentId, event, body) {
      const ev = toolEvent(event, body);
      const task = planner.currentTask(agentId);
      if (ev && task?.status === "in-progress") guard.record(agentId, task.id, task.title, ev);
    },
    slug,
    root: repo.root,
    hub,
    inbox,
    planner,
    agentSecret: secret,
    commands: makeCommands(hub, sessions, planner, inbox, sbx, mcp),
    isNew,
    paused: true,
    recheckSetup: () => sessions.recheckSetup(),
    pause() {
      if (rt.paused) return;
      github.stop();
      sbx.stopApprovalPolling();
      rt.paused = true;
      setLiveProject(repo.root, rt);
    },
    resume() {
      if (!rt.paused) return;
      github.start();
      sbx.startApprovalPolling();
      rt.paused = false;
      setLiveProject(repo.root, rt);
    },
    screens: (lines) => sessions.screens(lines),
    memoryReview,
    shutdown() {
      rt.pause();
      inbox.stop();
      clearInterval(usageTimer);
      stopListening();
      memoryReview.stop();
      sessions.shutdown();
    },
  };
  if (!paused) rt.resume();
  setLiveProject(repo.root, rt);
  return rt;
}
