import { agentPalette } from "../../theme/tokens";
import { readTemplateFile, toTemplateFile } from "../templateFile";
import { BUILTIN_TEMPLATES } from "../templates";
import type { OfficeDataSource, OfficeEvent, SimSpeed } from "../source";
import { stackDomains } from "../stack";
import { HOST_TERMINAL, type AccessRequest, type GitHubAppState, AgentConfig, AgentPatch, Board, NewAgentInput, RolePatch, ProjectConfig, SandboxSettings, WorkflowPatch } from "../types";
import { defaultPresetId, presets, type Preset } from "./presets";
import { Simulation } from "./simulation";
import * as T from "./terminalScripts";
import { mockSbx, mockSession, mockSetup, World } from "./world";

const TICK_MS = 50;
const TERM_MS = 30;


export function createMockSource(): OfficeDataSource {
  let presetId = (typeof location !== "undefined" && new URL(location.href).searchParams.get("preset")) || defaultPresetId;
  let world = new World(findPreset(presetId));
  let sim = new Simulation(world);
  let listener: ((e: OfficeEvent) => void) | null = null;
  let timers: number[] = [];
  let last = 0;
  let inputBuf = new Map<string, string>();
  let githubApp: GitHubAppState | undefined; // machine-wide, like the real one: survives a reconnect

  function findPreset(id: string): Preset {
    return presets.find((p) => p.id === id) ?? presets[0];
  }

  /** Fresh world for the current preset (keeps the speed). */
  function reset() {
    const speed = world.speed;
    world.clearTimers();
    world.setEmitter(null);
    world = new World(findPreset(presetId));
    world.speed = speed;
    sim = new Simulation(world);
    inputBuf = new Map();
    openShells.clear();
  }

  function boot() {
    if (githubApp) world.snap.githubApp = githubApp;
    world.setEmitter((e) => listener?.(e));
    listener?.({ type: "snapshot", snapshot: structuredClone(world.snap) });
    sim.start();
  }

  function loop() {
    const t = performance.now();
    const dt = Math.min(0.25, (t - last) / 1000) * world.speed;
    last = t;
    world.advance(dt);
    sim.tick(dt);
  }

  /** Rebuilds the mock "sbx" state from config, keeping any keys set in the UI. */
  function syncSbx() {
    const old = world.snap.sbx;
    const next = mockSbx(world.snap.config.team, world.snap.config.project.name);
    next.globalKeys = old.globalKeys;
    next.projectEnv = old.projectEnv;
    next.egress = old.egress;
    for (const id of Object.keys(next.agents))
      if (old.agents[id]) {
        next.agents[id].keys = old.agents[id].keys;
        next.agents[id].envFile = old.agents[id].envFile;
        next.agents[id].approvals = old.agents[id].approvals;
      }
    world.snap.sbx = next;
    world.emit({ type: "sbx.updated", sbx: structuredClone(next) });
  }

  function hostCmd(agentId: string, text: string) {
    world.write(agentId, [{ text: `\x1b[38;2;102;114;159mhq ▸ ${text}\x1b[0m` }]);
  }

  /** Demo "Shell" tab: a pretend shell inside the agent's sandbox. */
  const shellPrompt = (id: string) =>
    id === HOST_TERMINAL
      ? `\x1b[38;2;108;240;138myou@mac\x1b[0m:\x1b[38;2;41;173;255m${hostDir}\x1b[0m$ `
      : `\x1b[38;2;108;240;138m${id.slice(6)}@sandbox\x1b[0m:\x1b[38;2;41;173;255m~/workspace\x1b[0m$ `;
  let hostDir = "~/askwell";
  const shellOut = (id: string, data: string) => listener?.({ type: "terminal.output", agentId: id, data });
  const DEMO_SHELL: Record<string, string> = {
    ls: "README.md  app  components  lib  package.json  pnpm-lock.yaml",
    pwd: "/Users/you/.arima/askwell/workspace",
    "git status": "On branch p3-t02-chat-route\r\nChanges not staged for commit:\r\n  modified:   app/api/chat/route.ts",
    "node -v": "v22.11.0",
    whoami: "agent",
    "npm run dev": "\x1b[1m  ▲ Next.js 15.1\x1b[0m\r\n  - Local:   http://localhost:3000\r\n\r\n ✓ Ready in 1.2s",
  };
  function demoShell(id: string, data: string) {
    let buf = inputBuf.get(id) ?? "";
    for (const ch of data) {
      if (ch === "\r") {
        const cmd = buf.trim();
        buf = "";
        shellOut(id, "\r\n");
        if (cmd) shellOut(id, `${DEMO_SHELL[cmd] ?? `(demo shell) ${cmd}: try ls, pwd, git status, node -v, npm run dev`}\r\n`);
        shellOut(id, shellPrompt(id));
      } else if (ch === "\x7f") {
        if (buf.length) (buf = buf.slice(0, -1)), shellOut(id, "\b \b");
      } else if (ch >= " ") {
        buf += ch;
        shellOut(id, ch);
      }
    }
    inputBuf.set(id, buf);
  }
  const openShells = new Set<string>();

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      listener = onEvent;
      onStatus?.("open");
      last = performance.now();
      reset();
      boot();
      timers = [
        window.setInterval(loop, TICK_MS),
        window.setInterval(() => world.flushTerminals(Math.max(1, Math.round(world.speed * 1.3))), TERM_MS),
      ];
      return () => {
        timers.forEach((id) => window.clearInterval(id));
        timers = [];
        world.clearTimers();
        world.setEmitter(null);
        listener = null;
      };
    },

    sendTerminalInput(agentId, data) {
      if (agentId.startsWith("shell:")) return openShells.has(agentId) ? demoShell(agentId, data) : undefined;
      // Echo printable input; act on Enter.
      let buf = inputBuf.get(agentId) ?? "";
      for (const ch of data) {
        if (ch === "\r") {
          const text = buf.trim();
          buf = "";
          listener?.({ type: "terminal.output", agentId, data: "\r\n" });
          if (!text) continue;
          const st = world.status(agentId);
          if (st?.state === "needs-input") {
            world.after(0.6, () => sim.answer(agentId, "you"));
          } else {
            world.after(1, () => world.write(agentId, T.cannedReply(!!world.cfg(agentId)?.isLead, text.length)));
          }
        } else if (ch === "\x7f") {
          if (buf.length) {
            buf = buf.slice(0, -1);
            listener?.({ type: "terminal.output", agentId, data: "\b \b" });
          }
        } else if (ch >= " ") {
          buf += ch;
          listener?.({ type: "terminal.output", agentId, data: ch });
        }
      }
      inputBuf.set(agentId, buf);
    },

    sendMessage(toId, text) {
      if (!world.cfg(toId) || !text.trim()) return;
      world.message("you", toId, text.trim());
      world.after(1.2, () => world.write(toId, T.cannedReply(!!world.cfg(toId)?.isLead, text.length)));
    },

    askTeam(text) {
      const lead = world.snap.config.team.find((a) => a.isLead);
      if (!lead || !text.trim()) return;
      world.message("you", lead.id, text.trim(), true);
      const helper = world.snap.config.team.find((a) => !a.isLead);
      // The lead asks one teammate, then answers once with what it heard (the shape the real lead is told to follow).
      if (helper) world.after(1, () => world.message(lead.id, helper.id, `Quick one from the owner: ${text.trim().slice(0, 120)}. What do you know?`));
      if (helper) world.after(2.2, () => world.message(helper.id, lead.id, "From my side: it's covered in the task I just finished; one risk left, noted in my handoff."));
      world.after(3.4, () => world.message(lead.id, "you", `Team answer: ${helper ? `${helper.name} says it's covered, with one risk in their handoff. ` : ""}I'll keep an eye on it.`));
    },

    addGoal(goal) {
      const goals = world.snap.goals ?? [];
      world.snap.goals = [...goals, { id: `G${goals.length + 1}`, title: goal.title.trim(), metric: goal.metric, target: goal.target, status: "active", done: 0, total: 0, usd: 0 }];
      world.emit({ type: "goals.updated", goals: world.snap.goals });
    },

    updateGoal(id, patch) {
      world.snap.goals = (world.snap.goals ?? []).map((g) => (g.id === id ? { ...g, ...patch } : g));
      world.emit({ type: "goals.updated", goals: world.snap.goals });
    },

    setTaskGoal(taskId, goalId) {
      const t = world.snap.tasks.find((x) => x.id === taskId);
      if (!t) return;
      t.goalId = goalId;
      world.emit({ type: "task.updated", task: { ...t } });
      world.snap.goals = (world.snap.goals ?? []).map((g) => {
        const mine = world.snap.tasks.filter((x) => x.goalId === g.id);
        return { ...g, total: mine.length, done: mine.filter((x) => x.status === "done").length };
      });
      world.emit({ type: "goals.updated", goals: world.snap.goals });
    },

    saveConnection(input) {
      const all = world.snap.connections ?? [];
      const old = all.find((c) => c.name === input.name);
      const next = { name: input.name, url: input.url ?? old?.url ?? "", roles: input.roles ?? old?.roles ?? [], read: input.read ?? old?.read ?? [], send: input.send === undefined ? (old?.send ?? null) : input.send, tools: old?.tools ?? [], probedAt: old?.probedAt ?? null, hasKey: input.apiKey !== undefined ? !!input.apiKey : !!old?.hasKey };
      world.snap.connections = [...all.filter((c) => c.name !== input.name), next];
      world.emit({ type: "connections.updated", connections: world.snap.connections });
    },

    removeConnection(name) {
      world.snap.connections = (world.snap.connections ?? []).filter((c) => c.name !== name);
      world.emit({ type: "connections.updated", connections: world.snap.connections });
    },

    checkConnection(name) {
      // The demo's pretend CRM: two tools that read and one that sends.
      const tools = [
        { name: "search_contacts", description: "Find contacts by name or company." },
        { name: "get_deal", description: "Read one deal with its stage and amount." },
        { name: "send_email", description: "Send an email from the connected mailbox." },
      ];
      world.snap.connections = (world.snap.connections ?? []).map((c) => (c.name === name ? { ...c, tools, probedAt: new Date().toISOString() } : c));
      world.emit({ type: "connections.updated", connections: world.snap.connections });
    },

    sendProposal(itemId) {
      const item = world.snap.actionItems?.find((i) => i.id === itemId);
      if (!item?.send) return;
      const done = { ...item, status: "done" as const, send: { ...item.send, sentAt: new Date().toISOString() }, closedAt: new Date().toISOString() };
      world.snap.actionItems = world.snap.actionItems!.map((i) => (i.id === itemId ? done : i));
      world.emit({ type: "action.updated", item: done });
    },

    setCompany(text) {
      world.snap.company = text.trim().slice(0, 3000);
      world.emit({ type: "company.updated", company: world.snap.company });
    },

    resizeTerminal() {
      // The mock streams plain lines, so size doesn't matter.
    },

    startAgent(id) {
      const st = world.status(id);
      if (!st || st.session.state === "running") return;
      world.setStatus(id, { session: { ...st.session, state: "running", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session started`);
      if (!world.cfg(id)?.isLead) sim.startWorker(id, 1.5);
    },

    stopAgent(id) {
      const st = world.status(id);
      if (!st) return;
      if (openShells.has(`shell:${id}`)) source.closeShell(id);
      sim.stopAgent(id);
      world.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped", session: { ...st.session, state: "stopped", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session stopped`);
    },

    recreateSandbox(id) {
      const st = world.status(id);
      const r = world.cfg(id)?.sandbox.resources;
      if (!st || !r) return;
      world.setStatus(id, { session: { ...st.session, sandbox: { cpus: r.cpus ?? 8, memoryGb: r.memoryGb ?? 8 } } });
      hostCmd(id, `sbx rm hq-…-${id} && sbx run --cpus ${r.cpus ?? "auto"} --memory ${r.memoryGb ?? "auto"}g … (mock)`);
      world.activity("session", id, `Recreated ${world.name(id)}'s sandbox`);
    },

    openWorkspace(id) {
      hostCmd(id, `open ${world.status(id)?.session.workspace ?? "?"} (mock: nothing opens)`);
    },

    recheckSetup() {
      world.snap.setup = mockSetup();
      world.emit({ type: "setup.updated", setup: world.snap.setup });
    },

    runSetupFix() {
      // Everything is installed in the mock.
    },

    updateFinding(id, patch) {
      const f = world.snap.findings?.find((x) => x.id === id);
      if (!f) return;
      Object.assign(f, patch);
      world.emit({ type: "finding.updated", finding: { ...f } });
    },
    setTaskRunsOn(taskId, cli, model) {
      const task = world.task(taskId);
      if (!task) return;
      task.cli = cli;
      task.model = model;
      world.emit({ type: "task.updated", task: { ...task } });
    },
    assignTask(taskId, agentId) {
      const task = world.task(taskId);
      const agent = world.cfg(agentId);
      if (!task || !agent || agent.isLead || task.status !== "todo") return;
      world.patchTask(taskId, { ownerId: agentId });
      world.activity("task.assigned", null, `You assigned ${taskId} ${task.title} to ${agent.name}`);
      if (!sim.hasJob(agentId) && world.status(agentId)?.state === "idle") {
        world.message(world.lead().id, agentId, `Pull main, start ${taskId}.`);
        world.after(1, () => sim.begin(agentId, taskId), agentId);
      }
    },

    addAgent(input: NewAgentInput) {
      const team = world.snap.config.team;
      const base = T.slug(input.name) || "agent";
      let id = base;
      for (let i = 2; team.some((a) => a.id === id); i++) id = `${base}-${i}`;
      const used = new Set(team.map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team.length % agentPalette.length];
      const lead = world.lead();
      const name = input.name.trim() || "Agent";
      const role = world.snap.config.template?.roles.find((r) => r.id === input.roleId && !r.isLead);
      if (!role) return;
      const agent: AgentConfig = {
        id,
        name,
        roleId: role.id,
        role: role.title,
        isLead: false,
        cli: role.cli,
        model: role.model,
        mode: input.mode,
        color,
        skills: [...role.skills],
        roleMd: role.roleMd,
        sandbox: structuredClone(lead.sandbox),
        workspacePath: null,
      };
      team.push(agent);
      world.snap.agents.push({
        agentId: id, state: "idle", currentTaskId: null, stateSince: new Date().toISOString(), note: null,
        session: mockSession(world.snap.config.project.name, id),
      });
      world.configChanged();
      world.emit({ type: "agent.updated", agent: { ...world.snap.agents[world.snap.agents.length - 1] } });
      world.syncEnvironments();
      world.activity("config", null, `Added ${agent.name} (${agent.role}) — new sandbox starting`);
      world.write(id, T.banner(agent.name, agent.role, world.snap.config.project.repo, agent.mode));
      hostCmd(id, `sbx run ${agent.cli} · allow host.docker.internal:${world.snap.config.project.hqPort}`);
      syncSbx();
      sim.startWorker(id, 2);
    },

    updateAgent(id, patch: AgentPatch) {
      const agent = world.cfg(id);
      if (!agent) return;
      Object.assign(agent, patch);
      world.configChanged();
    },

    updateRole(roleId, patch: RolePatch) {
      const t = world.snap.config.template;
      const role = t?.roles.find((r) => r.id === roleId);
      if (!t || !role) return;
      Object.assign(role, structuredClone(patch));
      for (const a of world.snap.config.team)
        if (a.roleId === roleId) Object.assign(a, { role: role.title, cli: role.cli, model: role.model, skills: [...role.skills], roleMd: role.roleMd });
      world.configChanged();
    },

    updateProjectTemplate(template) {
      world.snap.config.template = structuredClone(template);
      world.configChanged();
    },

    inspectWorkspace(id) {
      const st = world.status(id);
      if (!st) return;
      listener?.({
        type: "workspace.info",
        info: { agentId: id, path: st.session.workspace ?? "", managed: true, exists: true, changedFiles: 1, unpushedCommits: 2, sandboxName: `hq-mock-${id}`, sandboxExists: true },
      });
    },

    removeAgent(id) {
      const agent = world.cfg(id);
      if (!agent || agent.isLead) return;
      if (openShells.has(`shell:${id}`)) source.closeShell(id);
      sim.stopAgent(id);
      world.snap.config.team = world.snap.config.team.filter((a) => a.id !== id);
      world.snap.agents = world.snap.agents.filter((a) => a.agentId !== id);
      for (const t of world.snap.tasks)
        if (t.ownerId === id && t.status !== "done") world.patchTask(t.id, { ownerId: null, status: t.status === "in-progress" ? "todo" : t.status });
      world.emit({ type: "agent.removed", agentId: id });
      world.configChanged();
      world.syncEnvironments();
      world.activity("config", null, `Removed ${agent.name} — sandbox stopped`);
    },

    updateSandbox(agentId, patch: Partial<SandboxSettings>) {
      const agent = world.cfg(agentId);
      if (!agent) return;
      Object.assign(agent.sandbox, structuredClone(patch));
      world.configChanged();
      if (patch.allow || patch.deny) {
        hostCmd(agentId, `sbx policy allow/deny network --sandbox hq-mock-${agentId} … (mock)`);
        syncSbx();
      }
      world.activity("config", agentId, `Updated ${agent.name}'s sandbox settings`);
    },

    setSecret(agentId, service, value) {
      void value; // A real source pipes this to `sbx secret set`; HQ never keeps it.
      const sbx = world.snap.sbx;
      if (agentId === null) sbx.globalKeys = [...new Set([...sbx.globalKeys, service])];
      else if (sbx.agents[agentId]) sbx.agents[agentId].keys = [...new Set([...sbx.agents[agentId].keys, service])];
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
      world.activity("config", agentId, `Stored the ${service} key ${agentId ? `for ${world.name(agentId)}` : "for every sandbox"} (mock)`);
    },

    removeSecret(agentId, service) {
      const sbx = world.snap.sbx;
      if (agentId === null) sbx.globalKeys = sbx.globalKeys.filter((k) => k !== service);
      else if (sbx.agents[agentId]) sbx.agents[agentId].keys = sbx.agents[agentId].keys.filter((k) => k !== service);
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
    },

    setEnvVar(agentId, name, value) {
      void value; // Never persisted in mock state; write-only like real HQ.
      const key = name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !value.trim()) return;
      const sbx = world.snap.sbx;
      if (agentId === null) {
        const cur = sbx.projectEnv ?? { path: "~/.arima/demo/project.env", exists: true, keys: [] };
        sbx.projectEnv = { ...cur, exists: true, keys: [...new Set([...cur.keys, key])].sort() };
      } else if (sbx.agents[agentId]) {
        const cur = sbx.agents[agentId].envFile;
        sbx.agents[agentId].envFile = { ...cur, exists: true, keys: [...new Set([...(cur.keys ?? []), key])].sort() };
      }
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
      world.activity("config", agentId, `Saved ${key} in App variables (${agentId ? world.name(agentId) : "all agents"}) (mock)`);
    },

    removeEnvVar(agentId, name) {
      const key = name.trim();
      const sbx = world.snap.sbx;
      if (agentId === null && sbx.projectEnv) {
        sbx.projectEnv.keys = sbx.projectEnv.keys.filter((k) => k !== key);
      } else if (agentId && sbx.agents[agentId]) {
        const cur = sbx.agents[agentId].envFile;
        cur.keys = (cur.keys ?? []).filter((k) => k !== key);
      }
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
    },

    setEgressMode(mode) {
      world.snap.sbx.egress!.mode = mode;
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    allowEgressHost(host, port) {
      const eg = world.snap.sbx.egress!;
      const rule = port === 80 || port === 443 ? host : `${host}:${port}`;
      if (!eg.rules.includes(rule)) eg.rules.push(rule);
      eg.wouldBlock = eg.wouldBlock.filter((b) => !(b.host === host && b.port === port));
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    ignoreEgressHost(host, port) {
      const eg = world.snap.sbx.egress!;
      eg.wouldBlock = eg.wouldBlock.filter((b) => !(b.host === host && b.port === port));
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    removeEgressRule(rule) {
      const eg = world.snap.sbx.egress!;
      eg.rules = eg.rules.filter((r) => r !== rule);
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    openEnvFile(agentId) {
      hostCmd(agentId, `open ${world.snap.sbx.agents[agentId]?.envFile.path ?? "?"} (mock: nothing opens)`);
    },

    refreshSbx() {
      syncSbx();
    },

    resolveActionItem(id, decision, note) {
      const item = world.snap.actionItems?.find((i) => i.id === id);
      if (!item || item.status !== "open") return;
      item.status = decision;
      item.note = note?.trim() || null;
      item.closedAt = new Date().toISOString();
      world.emit({ type: "action.updated", item: { ...item } });
      if (item.kind === "skills" && item.pack && world.snap.skillPacks) {
        const pack = world.snap.skillPacks.find((p) => p.source === item.pack);
        if (pack) pack.status = decision === "done" ? "approved" : "rejected";
        world.emit({ type: "skillPacks.updated", skillPacks: structuredClone(world.snap.skillPacks) });
        return;
      }
      world.message("you", item.fromId, decision === "done" ? `Done: ${item.title}${item.note ? ` (${item.note})` : ""}` : `Dismissed: ${item.title}${item.note ? ` (${item.note})` : ""}`);
    },

    saveAccount() {},
    testAccountKey() {},
    removeAccount() {},
    setMemoryExtraction() {},
    setTeamMode(mode) {
      for (const a of world.snap.config.team) {
        const up = ["running", "starting"].includes(world.status(a.id)?.session.state ?? "");
        if (up && a.mode !== mode) a.nextMode = mode;
        else {
          a.mode = mode;
          delete a.nextMode;
        }
      }
      world.configChanged();
    },
    finishGithubApp() {
      githubApp = { app: { id: 1, slug: "arimaops-demo", htmlUrl: "https://github.com/apps/arimaops-demo", owner: "demo", installUrl: "https://github.com/apps/arimaops-demo/installations/new" }, webhookPath: "/api/github/webhook", lastDeliveryAt: null };
      world.snap.githubApp = githubApp;
      world.emit({ type: "githubApp.updated", githubApp });
    },
    setSpendCaps(caps) {
      world.snap.config.project.spendCaps = caps;
      const spend = world.snap.spend;
      if (spend) {
        spend.day.cap = caps.dailyUsd;
        spend.month.cap = caps.monthlyUsd;
        spend.paused = spend.month.usd >= caps.monthlyUsd ? "month" : spend.day.usd >= caps.dailyUsd ? "day" : null;
        world.emit({ type: "spend.updated", spend: structuredClone(spend) });
      }
      world.configChanged();
    },
    promoteLessons() {
      const l = world.snap.lessons;
      if (!l) return;
      const lesson = { id: `L-demo${Date.now().toString(36)}`, templateId: l.templateId ?? "dev", type: "DeadEnd", text: "Polling the auth provider for sign-outs misses revoked sessions; subscribe to its session webhook instead.", status: "pending" as const, createdAt: new Date().toISOString() };
      world.snap.lessons = { ...l, pending: l.pending + 1, last: "Lessons for the template: 1 waiting for your check (Action items), 2 dropped because the rewrite still named something of this project." };
      const item = {
        id: `ai-${lesson.id}`,
        fromId: "hq",
        taskId: null,
        title: `Add this dead end to the ${lesson.templateId} template?`,
        details: `${lesson.text}\n\nApprove: every new project from this template gets it in its briefs. Reject: it's never offered again.`,
        waiting: true,
        kind: "lesson" as const,
        lesson: { id: lesson.id, templateId: lesson.templateId, type: lesson.type },
        status: "open" as const,
        note: null,
        at: new Date().toISOString(),
        closedAt: null,
      };
      world.snap.actionItems = [item, ...(world.snap.actionItems ?? [])];
      world.emit({ type: "action.updated", item: structuredClone(item) });
      world.emit({ type: "lessons.updated", lessons: structuredClone(world.snap.lessons) });
    },
    setLessonPromotion(on) {
      if (!world.snap.lessons) return;
      world.snap.lessons = { ...world.snap.lessons, enabled: on };
      world.emit({ type: "lessons.updated", lessons: structuredClone(world.snap.lessons) });
    },
    addToSuite(taskId) {
      const task = world.snap.tasks.find((t) => t.id === taskId);
      if (!task || task.status !== "done") return;
      task.benchmark = `task-demo-${taskId.toLowerCase()}`;
      world.emit({ type: "task.updated", task: structuredClone(task) });
      world.activity("config", null, `${taskId} added to the benchmark suite as ${task.benchmark}. Replay it with: pnpm bench task:${task.benchmark} --models developer=claude/claude-opus-5-5`);
    },
    removeLesson(id) {
      if (!world.snap.lessons) return;
      world.snap.lessons = { ...world.snap.lessons, approved: world.snap.lessons.approved.filter((l) => l.id !== id) };
      world.emit({ type: "lessons.updated", lessons: structuredClone(world.snap.lessons) });
    },
    exportTemplate() {
      const t = world.snap.config.template;
      if (t) world.emit({ type: "template.file", file: toTemplateFile(t, {}) });
    },
    importTemplate(text) {
      try {
        const { template } = readTemplateFile(text);
        const lib = world.snap.templateLibrary ?? BUILTIN_TEMPLATES.map((x) => ({ template: x, builtin: true, problems: [] }));
        let id = template.id;
        for (let i = 2; lib.some((e) => e.template.id === id); i++) id = `${template.id}-${i}`;
        world.snap.templateLibrary = [...lib, { template: { ...template, id }, builtin: false, problems: [] }];
        world.emit({ type: "templates.updated", templateLibrary: structuredClone(world.snap.templateLibrary) });
        world.emit({ type: "template.imported", ok: true, message: `Imported ${template.name} as "${id}". New projects can use it now.`, id });
      } catch (e) {
        world.emit({ type: "template.imported", ok: false, message: `Template not imported: ${(e as Error).message}` });
      }
    },
    setLabMode(on) {
      world.snap.config.rules.labMode = on;
      world.configChanged();
    },
    decideMemories(itemId, decisions) {
      const item = world.snap.actionItems?.find((i) => i.id === itemId && i.status === "open");
      if (!item) return;
      item.memories = (item.memories ?? []).filter((m) => !decisions[m.id]);
      const n = item.memories.length;
      item.title = `${n} memor${n === 1 ? "y" : "ies"} to check`;
      if (!n) (item.status = "done"), (item.closedAt = new Date().toISOString()), (item.note = "Checked");
      world.emit({ type: "action.updated", item: structuredClone(item) });
    },
    keepOutOfMemory(name) {
      const m = world.snap.memory;
      if (!m || m.keepOut.includes(name)) return;
      m.keepOut = [...m.keepOut, name].sort();
      world.emit({ type: "memory.updated", memory: structuredClone(m) });
    },
    refreshMcp() {
      if (world.snap.mcp) world.emit({ type: "mcp.updated", mcp: structuredClone(world.snap.mcp) });
    },

    addMcp(input) {
      const m = world.snap.mcp;
      const name = input.name.trim().toLowerCase();
      if (!m || !name || m.servers.some((s) => s.name === name)) return;
      m.servers.push({ name, transport: "remote http", status: input.apiKey ? "ready" : "needs-auth", error: null, checkedAt: new Date().toISOString(), nextStep: null });
      world.activity("config", null, `Added MCP server ${name}`);
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    authMcp(name) {
      const m = world.snap.mcp;
      const s = m?.servers.find((x) => x.name === name);
      if (!m || !s) return;
      listener?.({ type: "terminal.output", agentId: `setup:mcp-auth-${name}`, data: `\x1b[2m$ sbx mcp auth ${name}\x1b[0m\r\nOpening your browser to sign in… (demo)\r\n\x1b[32m✓ Done\x1b[0m\r\n` });
      s.status = "ready";
      s.nextStep = null;
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    removeMcp(name) {
      const m = world.snap.mcp;
      if (!m) return;
      m.servers = m.servers.filter((s) => s.name !== name);
      for (const a of world.snap.config.team) if (a.mcp?.includes(name)) a.mcp = a.mcp.filter((n) => n !== name);
      for (const id of Object.keys(m.attached)) m.attached[id] = m.attached[id].filter((n) => n !== name);
      world.configChanged();
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    setAgentMcp(agentId, names) {
      const agent = world.cfg(agentId);
      const m = world.snap.mcp;
      if (!agent || !m) return;
      const added = names.filter((n) => !(agent.mcp ?? []).includes(n));
      agent.mcp = [...names];
      // Demo: running agents get new servers right away; unticked ones stay until the sandbox is recreated.
      if (world.status(agentId)?.session.state === "running") {
        m.attached[agentId] = [...new Set([...(m.attached[agentId] ?? []), ...added])];
        for (const n of added) hostCmd(agentId, `sbx mcp load ${n} --sandbox hq-mock-${agentId} (mock)`);
      }
      world.configChanged();
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    answerApproval(agentId, approvalId, decision) {
      const st = world.snap.sbx.agents[agentId];
      const target = st?.approvals.find((a) => a.id === approvalId);
      if (!st || (approvalId !== "all" && !target)) return;
      if (decision === "allow") {
        const agent = world.cfg(agentId);
        const hosts = [...new Set((target ? [target] : st.approvals).map((a) => a.host))];
        for (const host of hosts) {
          if (agent && !agent.sandbox.allow.includes(host)) agent.sandbox.allow = [...agent.sandbox.allow, host];
          hostCmd(agentId, `sbx policy allow network --sandbox hq-mock-${agentId} ${host} (mock)`);
        }
        world.configChanged();
        world.activity("config", agentId, `You allowed ${target ? target.host : `${hosts.length} sites`} for ${world.name(agentId)}'s sandbox`);
      }
      st.approvals = approvalId === "all" ? [] : st.approvals.filter((a) => (decision === "allow" ? a.host !== target?.host : a.id !== approvalId));
      syncSbx();
    },

    updateWorkflow(patch: WorkflowPatch) {
      const wf = world.snap.config.workflow;
      Object.assign(wf.review, patch.review);
      Object.assign(wf.merge, patch.merge);
      Object.assign(wf.deploy, patch.deploy);
      world.configChanged();
      world.syncEnvironments();
      sim.workflowChanged();
      world.activity("config", null, "Workflow updated");
    },

    updateProject(patch: Partial<ProjectConfig>) {
      Object.assign(world.snap.config.project, patch);
      world.configChanged();
      world.syncEnvironments();
    },

    createBoard(title) {
      const clean = title.trim();
      if (!clean) return;
      const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "B";
      let id = base;
      for (let i = 2; world.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
      const board: Board = { id, title: clean, status: "planned", order: world.snap.boards.length };
      world.snap.boards.push(board);
      world.emit({ type: "board.updated", board: { ...board } });
      world.activity("config", null, `Created board ${clean}`);
    },

    updateBoard(id, patch) {
      const board = world.snap.boards.find((b) => b.id === id);
      if (!board) return;
      Object.assign(board, patch);
      world.emit({ type: "board.updated", board: { ...board } });
    },

    openShell(id) {
      const tid = `shell:${id}`;
      if (openShells.has(tid)) return;
      openShells.add(tid);
      inputBuf.delete(tid);
      shellOut(tid, `\x1b[2m$ sbx exec -it hq-mock-${id} bash   (demo)\x1b[0m\r\n${shellPrompt(tid)}`);
    },

    openHostShell(dir, fresh) {
      const want = dir.trim() || "~/askwell";
      if (openShells.has(HOST_TERMINAL) && !fresh && want === hostDir) return;
      if (openShells.has(HOST_TERMINAL)) shellOut(HOST_TERMINAL, "\x1bc");
      hostDir = want;
      openShells.add(HOST_TERMINAL);
      inputBuf.delete(HOST_TERMINAL);
      shellOut(HOST_TERMINAL, `\x1b[2m$ zsh in ${hostDir}   (demo)\x1b[0m\r\n${shellPrompt(HOST_TERMINAL)}`);
    },

    closeHostShell() {
      openShells.delete(HOST_TERMINAL);
    },

    forwardPort(agentId, port) {
      const st = world.snap.sbx.agents[agentId];
      if (!st || st.ports?.some((p) => p.sandbox === port)) return;
      st.ports = [...(st.ports ?? []), { sandbox: port, host: port }].sort((a, b) => a.sandbox - b.sandbox);
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
      world.activity("config", agentId, `Forwarded port ${port} from ${world.name(agentId)}'s sandbox to localhost:${port} on this machine. (demo)`);
    },

    unforwardPort(agentId, port) {
      const st = world.snap.sbx.agents[agentId];
      if (!st) return;
      st.ports = (st.ports ?? []).filter((p) => p.sandbox !== port);
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    closeShell(id) {
      openShells.delete(`shell:${id}`);
      inputBuf.delete(`shell:${id}`);
      shellOut(`shell:${id}`, "\r\n\x1b[2m[shell closed]\x1b[0m\r\n");
    },

    completeWelcome() {
      // The demo never shows the welcome screen.
    },

    updateStack(stack) {
      if (stack) world.snap.config.stack = structuredClone(stack);
      else delete world.snap.config.stack;
      world.configChanged();
    },

    resolveAccess(requestId, decision) {
      const req = world.snap.accessRequests?.find((r) => r.id === requestId);
      if (!req || req.status !== "pending") return;
      req.status = decision === "deny" ? "denied" : "allowed";
      world.emit({ type: "access.updated", request: { ...req } });
      const who = world.name(req.agentId);
      if (decision === "deny") {
        world.activity("config", req.agentId, `You denied ${who} access to ${req.domain}`);
        world.write(req.agentId, [{ text: `\x1b[38;2;255;23;68mhq ▸ access to ${req.domain} denied — continuing without it\x1b[0m` }]);
      } else {
        const ids = decision === "everyone" ? world.snap.config.team.filter((a) => a.mode === "sandbox").map((a) => a.id) : [req.agentId];
        for (const id of ids) {
          const a = world.cfg(id);
          if (a && !a.sandbox.allow.includes(req.domain)) a.sandbox.allow = [...a.sandbox.allow, req.domain];
          hostCmd(id, `sbx policy allow network --sandbox hq-mock-${id} ${req.domain} (mock)`);
        }
        world.configChanged();
        syncSbx();
        world.activity("config", req.agentId, `You allowed ${req.domain} for ${decision === "everyone" ? "every agent" : who}`);
      }
      if (world.status(req.agentId)?.state === "needs-input") world.setStatus(req.agentId, { state: "working", note: decision === "deny" ? "Continuing without it" : `Reading ${req.domain}` });
    },

    answerDecision(id, input) {
      const list = world.snap.visualDecisions ?? [];
      const dec = list.find((d) => d.id === id);
      if (!dec) return;
      const nowIso = new Date().toISOString();
      dec.status = input.status ?? "resolved";
      dec.waiting = false;
      dec.note = input.note?.trim() || dec.note || null;
      dec.closedAt = nowIso;

      if (dec.payload.kind === "question" && input.answers) {
        dec.payload = { ...dec.payload, answers: input.answers };
      } else if ((dec.payload.kind === "second-opinion" || dec.payload.kind === "disagreement") && input.chosenSide) {
        dec.payload = { ...dec.payload, chosenSide: input.chosenSide };
        if (input.chosenSide === "waive" && dec.payload.taskId && dec.payload.gateId) {
          source.recordGate(dec.payload.taskId, dec.payload.gateId, "waived", dec.note ?? "Waived from Second Opinion card");
        }
      } else if (dec.payload.kind === "permission" && input.resolution) {
        dec.payload = { ...dec.payload, resolution: input.resolution };
      } else if (dec.payload.kind === "meeting-request" && input.meetingAction) {
        const mtgId = dec.payload.meetingId;
        if (input.meetingAction === "decline") {
          source.joinMeeting(mtgId, "decline");
        } else if (input.meetingAction === "join") {
          source.joinMeeting(mtgId, "join");
        }
      }

      world.emit({ type: "decision.updated", decision: structuredClone(dec) });
      world.activity("agent.answered", dec.fromId === "hq" ? null : dec.fromId, `You answered "${dec.title}"`);
      if (dec.fromId && dec.fromId !== "hq" && world.cfg(dec.fromId)) {
        const summary =
          input.chosenSide ? `Chosen: ${input.chosenSide}`
          : input.resolution ? `Permission: ${input.resolution}`
          : input.answers?.length ? `Answered ${input.answers.length} question(s)`
          : dec.status;
        world.message("you", dec.fromId, `${dec.title} — ${summary}${dec.note ? ` (${dec.note})` : ""}`);
      }
    },

    recordGate(taskId, gateId, state, note) {
      const task = world.snap.tasks.find((t) => t.id === taskId);
      const cleanNote = note?.trim() || null;
      if (task) {
        const record = { at: Date.now(), gateId, state, by: "you", note: cleanNote };
        task.gateRecords = [record, ...(task.gateRecords ?? [])];
        if (state === "passed" || state === "waived") {
          const flow = world.snap.config.template?.flow;
          if (flow?.stages.length) {
            const idx = flow.stages.findIndex((s) => s.id === task.stageId);
            if (idx >= 0 && idx + 1 < flow.stages.length) {
              task.stageId = flow.stages[idx + 1].id;
            }
          }
        }
        world.emit({ type: "task.updated", task: structuredClone(task) });
      }
      world.activity("config", null, `Gate ${gateId} on ${taskId} ${state} by you${cleanNote ? `: ${cleanNote}` : ""}`);
    },

    startMeeting(input) {
      const lead = world.lead();
      const nowIso = new Date().toISOString();
      const id = `mtg-${Date.now().toString(36)}`;
      const participants = input.participantIds?.length ? input.participantIds : world.snap.config.team.map((a) => a.id);
      const agendaItems = (input.agenda?.length ? input.agenda : [" Status & blockers", "Key decisions", "Next actions"]).map((title, idx) => ({
        id: `${id}-ag-${idx + 1}`,
        title: title.trim(),
        status: idx === 0 ? "active" : "pending",
        ownerId: idx === 0 ? lead.id : null,
        recommendationDecisionId: null,
      }));
      const meeting = {
        id,
        projectId: world.snap.config.project.id,
        kind: input.kind,
        status: "live" as const,
        urgency: input.urgency ?? ("normal" as const),
        title: input.title.trim() || "Team Sync",
        moderatorId: lead.id,
        participantIds: participants,
        requestedBy: "you",
        voiceEnabled: false,
        voiceProvider: "browser-web-speech" as const,
        agenda: agendaItems,
        minutes: {
          summaryMarkdown: `### ${input.title.trim() || "Team Sync"}\n- Reviewing active tasks and blockers with ${participants.length} team members.`,
          decisions: [
            {
              id: `${id}-pd-1`,
              title: `Align team on ${input.title.trim() || "sprint priorities"}`,
              rationale: "Confirmed during live discussion session.",
              saveToMemory: true,
            },
          ],
          proposedTasks: [],
          agentInstructions: participants
            .filter((pid) => pid !== lead.id)
            .slice(0, 2)
            .map((pid) => ({
              agentId: pid,
              instruction: `Follow up on action items from ${input.title.trim() || "Team Sync"}.`,
              approved: true,
            })),
          committedAt: null,
        },
        createdAt: nowIso,
        startedAt: nowIso,
        closedAt: null,
      };
      world.snap.meetings = [meeting, ...(world.snap.meetings ?? [])];
      const firstTurn = {
        id: `${id}-t-1`,
        meetingId: id,
        speakerId: lead.id,
        speakerRole: lead.role,
        kind: "moderator-open",
        bodyMarkdown: `Welcome to **${meeting.title}**. I've pulled in ${participants.map((p) => world.name(p)).join(", ")}. Let's walk through the agenda items.`,
        decisionId: null,
        spokenText: `Welcome to ${meeting.title}. Let's walk through the agenda.`,
        createdAt: nowIso,
      };
      world.snap.meetingTurns = { ...(world.snap.meetingTurns ?? {}), [id]: [firstTurn] };
      world.emit({ type: "meeting.updated", meeting: structuredClone(meeting) });
      world.emit({ type: "meeting.turn.added", turn: structuredClone(firstTurn) });
      world.activity("message", lead.id, `Started ${meeting.kind}: ${meeting.title}`);
    },

    joinMeeting(meetingId, action = "join", voiceEnabled) {
      const mtg = (world.snap.meetings ?? []).find((m) => m.id === meetingId);
      if (!mtg) return;
      const nowIso = new Date().toISOString();
      if (action === "join" || action === "resume") {
        mtg.status = "live";
        mtg.startedAt ??= nowIso;
      } else if (action === "pause" || action === "snooze") {
        mtg.status = "paused";
      } else if (action === "close") {
        mtg.status = "minutes-review";
      } else if (action === "decline") {
        mtg.status = "declined";
        mtg.closedAt = nowIso;
      }
      if (voiceEnabled !== undefined) mtg.voiceEnabled = voiceEnabled;
      world.emit({ type: "meeting.updated", meeting: structuredClone(mtg) });
    },

    addMeetingTurn(meetingId, bodyMarkdown, speakerId = "you", decisionId = null) {
      const text = bodyMarkdown.trim();
      if (!text) return;
      const mtg = (world.snap.meetings ?? []).find((m) => m.id === meetingId);
      if (!mtg) return;
      const speaker = speakerId === "you" ? { name: "You", role: "Owner" } : world.cfg(speakerId) ?? { name: speakerId, role: "Agent" };
      const turn = {
        id: `${meetingId}-t-${Date.now().toString(36)}`,
        meetingId,
        speakerId,
        speakerRole: speaker.role,
        kind: "message",
        bodyMarkdown: text,
        decisionId,
        spokenText: speakerId === "you" ? null : text,
        createdAt: new Date().toISOString(),
      };
      const cur = world.snap.meetingTurns?.[meetingId] ?? [];
      world.snap.meetingTurns = { ...(world.snap.meetingTurns ?? {}), [meetingId]: [...cur, turn] };
      world.emit({ type: "meeting.turn.added", turn: structuredClone(turn) });

      if (speakerId === "you") {
        const lead = world.cfg(mtg.moderatorId) ?? world.lead();
        world.after(0.6, () => {
          const reply = {
            id: `${meetingId}-t-${Date.now().toString(36)}-r`,
            meetingId,
            speakerId: lead.id,
            speakerRole: lead.role,
            kind: "moderator-reply",
            bodyMarkdown: `Noted: *"${text.slice(0, 100)}"*. I've updated the draft meeting minutes so we can commit that decision to Team Memory and the Board.`,
            decisionId: null,
            spokenText: `Noted. I have updated the draft meeting minutes so we can commit that decision.`,
            createdAt: new Date().toISOString(),
          };
          const list = world.snap.meetingTurns?.[meetingId] ?? [];
          world.snap.meetingTurns = { ...(world.snap.meetingTurns ?? {}), [meetingId]: [...list, reply] };
          world.emit({ type: "meeting.turn.added", turn: structuredClone(reply) });
        });
      }
    },

    commitMeetingMinutes(meetingId, minutes) {
      const mtg = (world.snap.meetings ?? []).find((m) => m.id === meetingId);
      if (!mtg) return;
      const nowIso = new Date().toISOString();
      const committed = { ...minutes, committedAt: nowIso };
      mtg.minutes = committed;
      mtg.status = "closed";
      mtg.closedAt = nowIso;
      world.emit({ type: "meeting.updated", meeting: structuredClone(mtg) });

      // 1. Create approved tasks on the Board
      const boardId = world.snap.boards[0]?.id ?? "B1";
      for (const pt of minutes.proposedTasks.filter((t) => t.approved)) {
        const newId = `${pt.boardId || boardId}-T${String(world.snap.tasks.length + 1).padStart(2, "0")}`;
        const newTask = {
          id: newId,
          boardId: pt.boardId || boardId,
          stageId: pt.stageId || "build",
          title: pt.title,
          ownerId: pt.assigneeId,
          status: "todo" as const,
          needs: [],
          prNumber: null,
          description: pt.description,
        };
        world.putTask(newTask);
      }

      // 2. Deliver approved agent instructions
      for (const inst of minutes.agentInstructions.filter((i) => i.approved)) {
        if (world.cfg(inst.agentId)) {
          world.message("you", inst.agentId, `[Meeting Minutes] ${inst.instruction}`);
        }
      }

      // 3. Save certified decisions to lessons/memory
      if (world.snap.lessons) {
        const saved = minutes.decisions.filter((d) => d.saveToMemory);
        for (const d of saved) {
          world.snap.lessons.approved.unshift({
            id: `L-${d.id}`,
            templateId: world.snap.lessons.templateId ?? "dev",
            type: "Decision",
            text: `${d.title} — ${d.rationale}`,
            status: "approved",
            createdAt: nowIso,
          });
        }
        world.emit({ type: "lessons.updated", lessons: structuredClone(world.snap.lessons) });
      }

      // Also mark any open meeting-request decision for this meeting resolved
      for (const dec of world.snap.visualDecisions ?? []) {
        if (dec.payload.kind === "meeting-request" && dec.payload.meetingId === meetingId && dec.status === "open") {
          dec.status = "resolved";
          dec.waiting = false;
          dec.closedAt = nowIso;
          world.emit({ type: "decision.updated", decision: structuredClone(dec) });
        }
      }

      world.activity("config", mtg.moderatorId, `Committed minutes for "${mtg.title}"`);
    },

    submitVisualFeedback(input) {
      const nowIso = new Date().toISOString();
      const id = `vf-${Date.now().toString(36)}`;
      const boardId = world.snap.boards[0]?.id ?? "B1";
      let route = input.route;

      if (route.kind === "create-task") {
        const taskId = `${route.boardId || boardId}-T${String(world.snap.tasks.length + 1).padStart(2, "0")}`;
        const selectorNote = input.selection ? `\nElement: \`${input.selection.cssSelector}\` (${input.selection.tagName})` : "";
        const newTask = {
          id: taskId,
          boardId: route.boardId || boardId,
          stageId: "build",
          title: input.note.trim().slice(0, 80) || "Visual feedback from Live Preview",
          ownerId: route.assignToAgentId ?? (world.workers()[0]?.id ?? null),
          status: "todo" as const,
          needs: [],
          prNumber: null,
          description: `${input.note.trim()}\n\nPage: ${input.pageUrl} (${input.viewportWidth}x${input.viewportHeight})${selectorNote}\nAnnotated screenshot synced to \`.arima/feedback/${id}/annotated.png\`.`,
          deliverablePath: `.arima/feedback/${id}/annotated.png`,
        };
        world.putTask(newTask);
        route = { ...route, boardId: newTask.boardId, taskId };
      } else if (route.kind === "send-to-chat") {
        const targetAgent = world.cfg(route.toAgentId) ? route.toAgentId : world.lead().id;
        const selectorInfo = input.selection ? ` [${input.selection.cssSelector}]` : "";
        world.message("you", targetAgent, `[Visual Feedback ${id}]${selectorInfo} ${input.note.trim()} (${input.pageUrl}, ${input.viewportWidth}x${input.viewportHeight})`);
      }

      const fb = {
        id,
        projectId: world.snap.config.project.id,
        authorUserId: "you",
        targetId: input.targetId,
        sourceKind: input.sourceKind,
        pageUrl: input.pageUrl,
        viewportWidth: input.viewportWidth,
        viewportHeight: input.viewportHeight,
        note: input.note,
        selection: input.selection,
        consoleErrors: input.consoleErrors,
        imagePath: `~/.arima/v2/feedback/${world.snap.config.project.id}/${id}/annotated.png`,
        workspaceRelDir: `.arima/feedback/${id}`,
        route,
        createdAt: nowIso,
      };
      world.snap.visualFeedback = [fb, ...(world.snap.visualFeedback ?? [])];
      world.emit({ type: "feedback.created", feedback: structuredClone(fb) });
      world.activity("task.created", null, `Submitted visual feedback (${route.kind === "create-task" ? `created ${route.taskId}` : `sent to ${world.name(route.toAgentId)}`})`);
    },

    dev: {
      presets: presets.map((p) => ({ id: p.id, label: p.label })),
      loadPreset(id) {
        presetId = id;
        reset();
        boot();
      },
      setSpeed(multiplier: SimSpeed) {
        world.speed = multiplier;
      },
      simulateAccessRequest() {
        const busy = world.snap.agents.filter((s) => s.session.state === "running" && s.state !== "needs-input" && !world.cfg(s.agentId)?.isLead);
        const st = busy[Math.floor(Math.random() * busy.length)];
        if (!st) return;
        // A domain this agent can't reach yet: from the stack if any, else a common docs site.
        const allowed = new Set(world.cfg(st.agentId)?.sandbox.allow ?? []);
        const open = (list: string[]) => list.filter((d) => !d.startsWith("*.") && !allowed.has(d));
        const fromStack = open(stackDomains(world.snap.config.stack).map((d) => d.domain));
        const pool = fromStack.length ? fromStack : open(["posthog.com", "docs.stripe.com", "hono.dev", "docs.arcjet.com"]);
        const domain = pool[Math.floor(Math.random() * pool.length)] ?? "example.com";
        const req: AccessRequest = { id: world.id("ar"), agentId: st.agentId, domain, reason: `Read the ${domain} docs before integrating it`, at: new Date().toISOString(), status: "pending" };
        world.snap.accessRequests = [req, ...(world.snap.accessRequests ?? [])].slice(0, 30);
        world.emit({ type: "access.updated", request: { ...req } });
        world.setStatus(st.agentId, { state: "needs-input", note: `Asking: access to ${domain}` });
        world.activity("agent.needs-input", st.agentId, `${world.name(st.agentId)} needs you: access to ${domain}`);
        world.write(st.agentId, [{ text: `\x1b[38;2;255;23;68mhq ▸ request_access ${domain} — "${req.reason}" (waiting for you)\x1b[0m` }]);
      },
    },
  };

  return source;
}
