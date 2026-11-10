// One project's runtime inside the shared server: its hub, agents, planner, sandbox and GitHub sync.
// main.ts starts one per registered project; http.ts routes browsers (by ?project=) and agents (by their own token) to it.

import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";
import { ActionItems } from "./actionItems";
import { Findings } from "./findings";
import { makeCommands } from "./commands";
import { GitHubSync } from "./githubSync";
import { Hub } from "./hub";
import { Inbox } from "./inbox";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { agentToken } from "./paths";
import { Planner } from "./planner";
import { setLiveProject } from "./projectsRegistry";
import { markLimited, onAccountLimit, shareLimit } from "./accounts";
import { detectRepo } from "./repo";
import { Sbx } from "./sbx";
import { SbxMcp } from "./sbxMcp";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan, slugOf } from "./store";
import { askHaiku } from "./lib/haiku";
import { JUDGE_PROMPT, LoopGuard, toolEvent, type Verdict } from "./loopguard";
import { resolveUserSkillFolders } from "./skills";
import { UsageMeter } from "./usage";
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
  isNew: boolean;
  paused: boolean;
  recheckSetup(): Promise<void>;
  pause(): void;
  resume(): void;
  shutdown(): void;
}

/**
 * Moves legacy JSM HQ folders to .hq names, once: <repo>/.jsmhq → <repo>/.hq and ~/.jsmhq/<slug> → ~/.hq/<slug>.
 * Skipped while that project's agents run in tmux (their folders are in use); the legacy fallbacks in paths/store still find it.
 */
export async function migrateLegacy(root: string, slug: string): Promise<void> {
  const repoOld = join(root, BRAND.legacyRepoDir);
  const repoNew = join(root, BRAND.repoDir);
  if (existsSync(repoOld) && !existsSync(repoNew)) {
    renameSync(repoOld, repoNew);
    log.info(`migrated ${repoOld} → ${repoNew}`);
  }
  const homeOld = join(homedir(), BRAND.legacyHomeDir, slug);
  const homeNew = join(homedir(), BRAND.homeDir, slug);
  if (!existsSync(homeOld) || existsSync(homeNew)) return;
  const tmux = await run("tmux", ["ls", "-F", "#{session_name}"]);
  if (tmux.ok && tmux.stdout.split("\n").some((s) => s.startsWith(`hq-${slug}-`))) {
    log.warn(`not migrating ${homeOld}: agents of ${slug} are running. Stop them and restart HQ to migrate.`);
    return;
  }
  renameSync(homeOld, homeNew);
  log.warn(`migrated ${homeOld} → ${homeNew}. Sandboxed agents of ${slug} need "Recreate sandbox" once (their folder moved).`);
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

  const hub = new Hub(repo, slug, config, loadPlan(repo.root), setup);
  hub.snap.welcome = isNew;
  hub.snap.customSkills = [...resolveUserSkillFolders(repo.root, ["*"]).keys()].sort();
  const sessions = new Sessions(hub, secret);
  const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id) });
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
  const usageOf = (id: string) => {
    const a = hub.cfg(id);
    return a ? meter.read(a.cli, workspaceFor(a, slug)) : null;
  };
  planner.usageOf = usageOf;
  planner.lastActivityAt = (id) => inbox.lastHookAt(id);
  inbox.isStale = (agentId, taskId) => {
    const t = planner.task(taskId);
    return !t || t.ownerId !== agentId || t.status === "done";
  };
  const refreshUsage = () => {
    planner.checkStalls(Date.now());
    for (const a of hub.snap.config.team) {
      const u = usageOf(a.id);
      if (JSON.stringify(u) !== JSON.stringify(hub.status(a.id)?.usage ?? null)) hub.setStatus(a.id, { usage: u });
    }
  };
  const guard = new LoopGuard(
    async (digest) => {
      const a = await askHaiku<Verdict>(JUDGE_PROMPT + digest);
      if (a) hub.activity("config", null, `Loop check (Claude Haiku, ${a.tokens.input + a.tokens.cached + a.tokens.output} tokens): ${a.json.stuck ? "stuck" : "making progress"}`);
      return a?.json ?? null;
    },
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
  planner.findings = new Findings(hub);
  // A usage limit is the account's, not the agent's: every agent on that CLI, in every project, stops too.
  const stopListening = onAccountLimit((cli, until, from) => {
    const marked = markLimited(hub, cli, until, from);
    if (!marked.length) return;
    const at = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    hub.activity("agent.needs-input", null, `${marked.join(", ")} paused until ${at}: the ${cli} account hit its usage limit (${from.name}${from.project === slug ? "" : ` in ${from.project}`}).`);
    const lead = hub.snap.config.team.find((a) => a.isLead);
    if (lead && !marked.includes(lead.name))
      planner.notify(lead.id, `The ${cli} subscription hit its usage limit until ${at}, so ${marked.join(", ")} can't work until then. Move urgent tasks to agents on another CLI, or wait.`);
  });
  sessions.onLimit = (id, until) => {
    const agentCfg = hub.cfg(id);
    if (agentCfg) shareLimit(agentCfg.cli, until, { project: slug, agentId: id, name: agentCfg.name });
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
    shutdown() {
      rt.pause();
      inbox.stop();
      clearInterval(usageTimer);
      stopListening();
      sessions.shutdown();
    },
  };
  if (!paused) rt.resume();
  setLiveProject(repo.root, rt);
  return rt;
}
