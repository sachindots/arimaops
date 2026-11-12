// Browser commands → server actions. Names match OfficeDataSource methods.

import { isAgentCli, isAgentMode, SERVICE_KEYS, type AgentPatch, type ReviewTool, type RolePatch, type WelcomeInput, type NewMcpServer, type Board, type NewAgentInput, type ProjectConfig, type RemoveAgentOptions, type SandboxSettings, type SetupCheckId, type WorkflowPatch } from "../src/data/types";
import { accounts, accountsState, redactor } from "./credentials/registry";
import { PROVIDER_SPECS } from "../src/data/providers";
import type { AccountInput, MemoryInput, MemoryState } from "../src/data/types";
import { liveHubs } from "./projectsRegistry";
import { memoryState, memoryStore, saveExtractionSettings, saveMemorySettings } from "./memory";
import { listBackups, restoreProject } from "./memoryBackup";
import { memoryWorker } from "./memoryJobs";

/** Sends the accounts list (no secrets) to every loaded project. */
function broadcastAccounts() {
  const state = accountsState();
  for (const h of liveHubs()) {
    h.snap.accounts = state;
    h.emit({ type: "accounts.updated", accounts: state });
  }
}

/** Where memory is, whether it answers, and the project's backups. */
export function projectMemoryState(projectId: string, state = memoryState()): MemoryState {
  let backups: string[] = [];
  try {
    backups = listBackups(projectId);
  } catch {
    /* an id that can't name a folder has no backups */
  }
  return { ...state, backups, keepOut: memoryStore().keptOut(projectId) };
}

/** Sends the memory state to every loaded project. */
export function broadcastMemory() {
  const state = memoryState();
  for (const h of liveHubs()) {
    h.snap.memory = projectMemoryState(h.snap.config.project.id, state);
    h.emit({ type: "memory.updated", memory: h.snap.memory });
  }
}
import { releasePortBlock } from "./ports";
import { cleanAccount } from "./accounts";
import { OFFICE_NAME_MAX } from "../src/data/names";
import type { TeamTemplate } from "../src/data/model";
import { hqDb } from "./lib/db";
import { isReadOnly, READ_ONLY_COMMANDS } from "./legacy";
import { applyTemplate, copyToProject, defaultSandbox, forgetProjectTemplate, freeColor, resolveSeat, resyncProject, saveTemplate, seatOf, seatsFor, TemplateError, updateProjectTemplate } from "./templates";
import { STACK_CATEGORIES, stackSkills, stackTool, type StackChoice, type StackConfig } from "../src/data/stack";
import { resolveAccess } from "./access";
import { ensureSkillCache } from "./skills";
import { run } from "./lib/exec";
import { Hub } from "./hub";
import type { Inbox } from "./inbox";
import type { Planner } from "./planner";
import type { Sbx } from "./sbx";
import type { SbxMcp } from "./sbxMcp";
import type { Sessions } from "./sessions";
import { mergeByNotice } from "./githubSync";
import { cleanEntry } from "./scope";

/** A stack from the browser, checked against the catalog. Null when nothing is chosen. */
function cleanStack(raw: unknown): StackConfig | null {
  const input = (raw ?? {}) as Partial<StackConfig>;
  const choice = (c: unknown, category: string): StackChoice | null => {
    const v = (c ?? {}) as Partial<StackChoice>;
    const id = str(v.id, 40);
    const known = id === "other" || stackTool(id)?.category === category;
    if (!known) return null;
    const out: StackChoice = { id };
    if (typeof v.where === "string" && v.where.trim()) out.where = str(v.where, 120).trim();
    if (id === "other") {
      if (typeof v.name === "string" && v.name.trim()) out.name = str(v.name, 60).trim();
      if (typeof v.docsUrl === "string" && v.docsUrl.trim()) out.docsUrl = str(v.docsUrl, 300).trim();
    }
    return out;
  };
  const frameworks = (Array.isArray(input.frameworks) ? input.frameworks : []).slice(0, 10).map((f) => choice(f, "framework")).filter((f): f is StackChoice => !!f);
  const tools: StackConfig["tools"] = {};
  for (const c of STACK_CATEGORIES) {
    const picked = choice(input.tools?.[c.id], c.id);
    if (picked) tools[c.id] = picked;
  }
  return frameworks.length || Object.keys(tools).length ? { frameworks, tools } : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agent";
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function makeCommands(hub: Hub, sessions: Sessions, planner: Planner, inbox: Inbox, sbx: Sbx, mcp: SbxMcp) {
  /** Runs an sbx change and reports failures in the activity feed. */
  const attempt = async (agentId: string | null, what: string, fn: () => Promise<void>) => {
    try {
      await fn();
      hub.activity("config", agentId, what);
    } catch (err) {
      hub.activity("config", agentId, `Couldn't ${what.charAt(0).toLowerCase() + what.slice(1)}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const team = () => hub.snap.config.team;

  /** Runs a template change; a refused template is reported, not thrown at the browser. */
  const guardTemplate = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      hub.activity("config", null, `Template not saved: ${e.message}`);
    }
  };
  const afterTemplate = (t: TeamTemplate, note: string) => {
    applyTemplate(hub.snap.config, t);
    hub.configChanged();
    void sessions.recheckSetup(); // a role's CLI may have changed
    hub.activity("config", null, note);
  };
  const setTemplate = (t: TeamTemplate, note: string) =>
    guardTemplate(() => {
      const missing = team().filter((a) => !t.roles?.some((r) => r.id === a.roleId));
      if (missing.length) throw new TemplateError(`${missing.map((a) => a.name).join(", ")} would have no role. Move or remove them first.`);
      afterTemplate(updateProjectTemplate(hqDb(), hub.slug, t), note);
    });

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    sendTerminalInput: (id, data) => sessions.input(str(id, 80), str(data, 100_000)),
    openShell: (id) => sessions.openShell(str(id, 80)),
    closeShell: (id) => sessions.closeShell(str(id, 80)),
    openHostShell: (dir, fresh) => sessions.openHostShell(str(dir, 4096), fresh === true),
    closeHostShell: () => sessions.closeHostShell(),
    forwardPort: (agentId, port) => sbx.forwardPort(str(agentId, 80), num(port)),
    unforwardPort: (agentId, port) => sbx.unforwardPort(str(agentId, 80), num(port)),
    resizeTerminal: (id, cols, rows) => sessions.resize(str(id, 80), num(cols), num(rows)),
    startAgent: (id) => sessions.start(str(id, 80)),
    stopAgent: (id) => sessions.stop(str(id, 80)),
    openWorkspace: (id) => sessions.openWorkspace(str(id, 80)),
    recreateSandbox: (id) => sessions.recreate(str(id, 80)),
    recheckSetup: async () => {
      await sessions.recheckSetup();
      await sbx.refresh();
    },
    runSetupFix: (id) => sessions.runFix(str(id, 64) as SetupCheckId),

    // You → agent: same delivery path as the lead's assign_task / send_message.
    assignTask: (taskId, agentId) => planner.assign(str(taskId, 40), str(agentId, 80), "you"),
    updateFinding: (id, patch) => {
      try {
        planner.findings?.update(str(id, 20), (patch ?? {}) as Record<string, unknown>, "you");
      } catch (e) {
        hub.activity("config", null, e instanceof Error ? e.message : String(e));
      }
    },
    recordGate: (taskId, gateId, state, note) => {
      const s = state === "passed" || state === "failed" || state === "waived" || state === "reset" ? state : null;
      if (!s) return;
      try {
        planner.recordGate(str(taskId, 40), str(gateId, 40), s, "you", { note: str(note, 300) || undefined });
      } catch (e) {
        hub.activity("config", null, e instanceof Error ? e.message : String(e));
      }
    },
    setTaskRunsOn: (taskId, cli, model) =>
      planner.updateTask(str(taskId, 40), { cli: isAgentCli(cli) ? cli : null, model: typeof model === "string" && model.trim() ? str(model, 80) : null }),
    sendMessage: (toId, text) => planner.message("you", str(toId, 80), str(text, 2000)),

    addAgent: (raw) => {
      const t = hub.snap.config.template;
      if (!t) return;
      const input = (raw ?? {}) as Partial<NewAgentInput>;
      const role = t.roles.find((r) => r.id === input.roleId && !r.isLead);
      if (!role) return hub.activity("config", null, "Pick a role from the project's template for the new agent (the lead's seat is taken).");
      const name = str(input.name, 40).trim() || "Agent";
      let id = slug(name);
      for (let i = 2; team().some((a) => a.id === id); i++) id = `${slug(name)}-${i}`;
      const lead = team().find((a) => a.isLead);
      const agent = resolveSeat(t, {
        id,
        name,
        roleId: role.id,
        color: freeColor(role.color, team().map((a) => a.color)),
        mode: isAgentMode(input.mode) ? input.mode : "sandbox",
        account: "",
        workspacePath: null,
        sandbox: lead ? structuredClone(lead.sandbox) : defaultSandbox(),
        mcp: [],
      });
      team().push(agent);
      const status = Hub.freshStatus(id);
      hub.snap.agents.push(status);
      hub.configChanged();
      hub.emit({ type: "agent.updated", agent: structuredClone(status) });
      hub.activity("config", null, `Added ${agent.name} (${agent.role}). Press Start to launch their session.`);
      if (agent.cli !== "claude") void sessions.recheckSetup();
    },

    updateAgent: (id, patch) => {
      const t = hub.snap.config.template;
      const agent = hub.cfg(str(id));
      if (!agent || !t) return;
      const p = (patch ?? {}) as AgentPatch;
      const before = `${agent.cli}/${agent.mode}/${agent.account ?? ""}`;
      const seat = seatOf(agent);
      if (typeof p.name === "string" && p.name.trim()) seat.name = str(p.name, 40).trim();
      if (typeof p.color === "string") seat.color = str(p.color, 20);
      if (isAgentMode(p.mode)) seat.mode = p.mode;
      // A seat can move to another worker role; the lead's seat stays the lead's.
      const role = t.roles.find((r) => r.id === p.roleId);
      if (role && !role.isLead && !agent.isLead) seat.roleId = role.id;
      if (typeof p.account === "string") {
        const acct = cleanAccount(p.account);
        seat.account = acct && acct !== "default" ? acct : "";
      }
      if (p.workspacePath !== undefined) seat.workspacePath = p.workspacePath ? str(p.workspacePath, 500).trim() || null : null;
      Object.assign(agent, resolveSeat(t, seat));
      if (!agent.account) delete agent.account;
      hub.configChanged();
      // Non-Claude CLIs and named container accounts add their own setup checks.
      if (`${agent.cli}/${agent.mode}/${agent.account ?? ""}` !== before) void sessions.recheckSetup();
    },

    /** Edits one role of this project's template; every seat of it picks the change up at its next start. */
    updateRole: (roleId, patch) => {
      const t = hub.snap.config.template;
      const role = t?.roles.find((r) => r.id === str(roleId, 40));
      if (!t || !role) return;
      const p = (patch ?? {}) as RolePatch;
      const next = structuredClone(role);
      for (const k of ["title", "model", "roleMd", "color"] as const) if (typeof p[k] === "string") next[k] = str(p[k], 8000);
      if (isAgentCli(p.cli) && p.cli !== next.cli) {
        next.cli = p.cli;
        if (typeof p.model !== "string") next.model = ""; // model names don't carry over between CLIs
      }
      if (Array.isArray(p.skills)) next.skills = p.skills.map((x) => str(x, 80)).filter(Boolean);
      if (typeof p.onDemand === "boolean") next.onDemand = p.onDemand;
      if (p.fallback === null) next.fallback = null;
      else if (p.fallback && isAgentCli(p.fallback.cli)) next.fallback = { cli: p.fallback.cli, model: str(p.fallback.model, 80) };
      setTemplate({ ...t, roles: t.roles.map((r) => (r.id === role.id ? next : r)) }, `Role ${next.title} updated. Restart its agents to give them the change.`);
    },

    /** Replaces this project's template copy (roles, flow, rules). The library is untouched. */
    updateProjectTemplate: (raw) => setTemplate(raw as TeamTemplate, "Project template updated. Restart agents to give them the change."),

    /** Takes the library's current version of this project's template, on purpose. */
    resyncTemplate: () =>
      guardTemplate(() => {
        const t = resyncProject(hqDb(), hub.slug);
        afterTemplate(t, `Template re-synced to ${t.name} v${t.version}. Restart agents to give them the change.`);
      }),

    /** Saves a template to this machine's library (built-in ones are saved under a new id). */
    saveTemplate: (raw) =>
      guardTemplate(() => {
        const t = saveTemplate(hqDb(), raw as TeamTemplate, "you");
        hub.activity("config", null, `Saved template ${t.name} (v${t.version}) to the library.`);
      }),

    inspectWorkspace: async (id) => {
      const info = await sessions.inspectWorkspace(str(id, 80));
      if (info) hub.emit({ type: "workspace.info", info });
    },

    removeAgent: async (id, opts) => {
      const agent = hub.cfg(str(id));
      if (!agent || agent.isLead) return;
      const o = (opts ?? {}) as Partial<RemoveAgentOptions>;
      const removed = await sessions.removeResources(agent.id, { deleteSandbox: o.deleteSandbox !== false, deleteFolder: o.deleteFolder === true });
      hub.snap.config.team = team().filter((a) => a.id !== agent.id);
      hub.snap.agents = hub.snap.agents.filter((a) => a.agentId !== agent.id);
      inbox.forget(agent.id);
      mcp.forget(agent.id);
      releasePortBlock(hub.slug, agent.id);
      for (const t of hub.snap.tasks)
        if (t.ownerId === agent.id && t.status !== "done") {
          t.ownerId = null;
          if (t.status === "in-progress") t.status = "todo";
          hub.emit({ type: "task.updated", task: { ...t } });
        }
      hub.planChanged();
      hub.emit({ type: "agent.removed", agentId: agent.id });
      hub.configChanged();
      const what = removed.length ? ` Deleted: ${removed.join(" and ")}.` : "";
      const kept = removed.includes("folder") ? "" : " Their folder is kept.";
      hub.activity("config", null, `Removed ${agent.name}.${what}${kept}`);
    },

    updateSandbox: (id, patch) => {
      const agent = hub.cfg(str(id));
      if (!agent) return;
      const p = (patch ?? {}) as Partial<SandboxSettings>;
      const clean = (list: unknown[]) => [...new Set(list.map((d) => str(d, 200).trim().toLowerCase()).filter(Boolean))];
      const rulesChanged = Array.isArray(p.allow) || Array.isArray(p.deny);
      if (Array.isArray(p.allow)) agent.sandbox.allow = clean(p.allow);
      if (Array.isArray(p.deny)) agent.sandbox.deny = clean(p.deny);
      if (p.resources) {
        // Same limits as sbx: ≥1 CPU up to the host; 0.5 GB up to 75% of RAM.
        const m = hub.snap.setup.machine;
        const cpus = p.resources.cpus === null ? null : Math.round(Math.min(m.cpus, Math.max(1, num(p.resources.cpus))));
        const maxMem = Math.max(0.5, Math.floor(m.memoryGb * 0.75 * 2) / 2);
        const memoryGb = p.resources.memoryGb === null ? null : Math.min(maxMem, Math.max(0.5, Math.round(num(p.resources.memoryGb) * 2) / 2));
        agent.sandbox.resources = { cpus, memoryGb };
      }
      hub.configChanged();
      // Applies now if the sandbox exists; otherwise on its first Start.
      if (rulesChanged) void sbx.syncRules(agent.id);
    },

    setSecret: (id, service, value) => {
      const agentId = id === null ? null : str(id, 80);
      const svc = str(service, 40);
      if (!(SERVICE_KEYS as readonly string[]).includes(svc) || typeof value !== "string" || !value.trim()) return;
      if (agentId && !hub.cfg(agentId)) return;
      return attempt(agentId, `Stored the ${svc} key ${agentId ? `for ${hub.name(agentId)}'s sandbox` : "for every sandbox"}`, () => sbx.setKey(agentId, svc, value));
    },
    removeSecret: (id, service) => {
      const agentId = id === null ? null : str(id, 80);
      const svc = str(service, 40);
      if (!(SERVICE_KEYS as readonly string[]).includes(svc)) return;
      return attempt(agentId, `Removed the ${svc} key ${agentId ? `from ${hub.name(agentId)}'s sandbox` : "from every sandbox"}`, () => sbx.removeKey(agentId, svc));
    },
    setProxy: (url) => {
      const u = typeof url === "string" && url.trim() ? str(url, 300).trim() : null;
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return hub.activity("config", null, "Proxy must be an http(s):// URL");
      return attempt(null, u ? `Set the sandbox proxy to ${u}` : "Removed the sandbox proxy", () => sbx.setProxy(u));
    },
    openEnvFile: async (id) => {
      const agent = hub.cfg(str(id, 80));
      if (!agent) return;
      const file = sbx.ensureEnvFile(agent.id);
      const [cmd, args] = process.platform === "darwin" ? ["open", ["-t", file]] : process.platform === "win32" ? ["notepad", [file]] : ["xdg-open", [file]];
      await run(cmd, args, { timeoutMs: 5000 });
      await sbx.refresh();
    },
    refreshSbx: () => sbx.refresh(),

    // The user's check of new memories: owner and operators (step-up from a remote device); viewers can't.
    decideMemories: (itemId, raw) => {
      if (!planner.actions) return;
      const decisions = Object.fromEntries(
        Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k, v]) => /^M-\d+$/.test(k) && (v === "certify" || v === "reject")),
      ) as Record<string, "certify" | "reject">;
      try {
        const projectId = hub.snap.config.project.id;
        const r = planner.actions.decideMemories(str(itemId, 40), decisions);
        memoryStore().certify(projectId, r.certify, "user"); // the audit log records who
        memoryStore().reject(projectId, r.reject);
        hub.activity("config", null, `Memories checked: ${r.certify.length} certified, ${r.reject.length} rejected.`);
      } catch (e) {
        hub.activity("config", null, `Couldn't check those memories: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    keepOutOfMemory: (name) => {
      try {
        memoryStore().keepOut(hub.snap.config.project.id, str(name, 120), "user");
        broadcastMemory();
        hub.activity("config", null, "Added a name to this project's keep-out list; it's removed from what memory already holds.");
      } catch (e) {
        hub.activity("config", null, `Couldn't keep that name out: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    resolveActionItem: (id, decision, note) => {
      const d = decision === "done" || decision === "dismissed" ? decision : null;
      if (d) planner.actions?.resolve(str(id, 40), d, typeof note === "string" ? str(note, 1000) : undefined);
    },
    refreshMcp: () => mcp.refresh(),
    addMcp: (raw) => {
      const v = (raw ?? {}) as Partial<NewMcpServer>;
      return mcp.add({
        name: str(v.name, 40),
        url: str(v.url, 500) || undefined,
        command: str(v.command, 300) || undefined,
        args: Array.isArray(v.args) ? v.args.slice(0, 20).map((a) => str(a, 200)) : undefined,
        apiKey: str(v.apiKey, 4000) || undefined,
      });
    },
    authMcp: (name) => mcp.authorize(str(name, 40)),
    removeMcp: (name) => mcp.remove(str(name, 40)),

    // Accounts are machine-wide: every open project hears about a change.
    saveAccount: (raw) => {
      try {
        const rec = accounts().save((raw ?? {}) as AccountInput);
        redactor().refresh();
        broadcastAccounts();
        hub.activity("config", null, `Saved the ${rec.id} account (${PROVIDER_SPECS[rec.provider].label}). Agents using it pick up a new key on their next start.`);
      } catch (e) {
        hub.activity("config", null, `Couldn't save the account: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    saveMemory: (raw) => {
      try {
        void saveMemorySettings(raw as MemoryInput);
        redactor().refresh(); // the Neo4j password is masked in terminal output like any vault secret
        broadcastMemory();
        hub.activity("config", null, "Saved the memory settings. HQ is connecting to Neo4j.");
      } catch (e) {
        hub.activity("config", null, `Couldn't save the memory settings: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    setMemoryExtraction: (raw) => {
      const input = (raw ?? {}) as { enabled?: boolean; account?: string };
      try {
        saveExtractionSettings(input, (id) => accounts().get(id)?.provider === "anthropic");
        broadcastMemory();
        hub.activity("config", null, input.enabled ? `Memory extraction is on: Claude Haiku reads each finished task (${input.account && input.account !== "default" ? `account ${input.account}` : "your Claude Code sign-in"}).` : "Memory extraction is off.");
        if (input.enabled) memoryWorker()?.extractPending();
      } catch (e) {
        hub.activity("config", null, `Couldn't change memory extraction: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    restoreMemory: (date) => {
      const day = str(date, 10);
      const projectId = hub.snap.config.project.id;
      hub.activity("config", null, `Restoring this project's memory from the ${day} backup…`);
      restoreProject(memoryStore(), projectId, day)
        .then(() => hub.activity("config", null, `Memory restored from the ${day} backup. Ledger entries written since then are gone.`))
        .catch((e) => hub.activity("config", null, `Couldn't restore memory: ${e instanceof Error ? e.message : String(e)}`))
        .finally(broadcastMemory);
    },
    removeAccount: (id) => {
      const acct = str(id, 40);
      try {
        accounts().remove(acct);
        redactor().refresh();
        broadcastAccounts();
        const using = liveHubs().flatMap((h) => h.snap.config.team.filter((a) => a.account === acct).map((a) => a.name));
        hub.activity("config", null, `Removed the ${acct} account and its key.${using.length ? ` ${using.join(", ")} still point at it and won't start until you pick another account.` : ""}`);
      } catch (e) {
        hub.activity("config", null, `Couldn't remove the account: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    setAgentMcp: (agentId, names) => mcp.setAgent(str(agentId, 80), Array.isArray(names) ? names.slice(0, 50).map((n) => str(n, 40)) : []),
    answerApproval: (agentId, approvalId, decision) => {
      const d = decision === "allow" || decision === "dismiss" ? decision : null;
      if (d) return sbx.answerApproval(str(agentId, 80), str(approvalId, 120), d);
    },

    /** Saves the project's stack (sanitised against the catalog). The agents get it in ROLE.md on their next start. */
    updateStack: (raw) => {
      const cfg = hub.snap.config;
      const stack = cleanStack(raw);
      if (!stack) {
        delete cfg.stack;
        return hub.configChanged();
      }
      cfg.stack = stack;
      hub.configChanged();
      // Fetch the skills now so the next Start doesn't wait for them.
      const specs = stackSkills(cfg.stack);
      if (specs.length) void ensureSkillCache(hub.slug, specs).catch((e) => hub.activity("config", null, `Couldn't fetch agent skills: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`));
    },

    resolveAccess: (id, decision) => {
      const d = decision === "agent" || decision === "everyone" || decision === "deny" ? decision : null;
      if (d) return resolveAccess(hub, sbx, planner, str(id, 40), d);
    },

    completeWelcome: async (raw) => {
      if (!hub.snap.welcome) return;
      const input = (raw ?? {}) as Partial<WelcomeInput>;
      let template: TeamTemplate;
      try {
        forgetProjectTemplate(hqDb(), hub.slug); // left over from a deleted project with the same id
        template = copyToProject(hqDb(), hub.slug, str(input.templateId, 40));
      } catch (e) {
        return hub.activity("config", null, e instanceof Error ? e.message : String(e));
      }
      const cfg = hub.snap.config;
      if (typeof input.projectName === "string" && input.projectName.trim()) cfg.project.name = str(input.projectName, 80).trim();
      if (typeof input.officeName === "string") {
        const sign = input.officeName.trim().slice(0, OFFICE_NAME_MAX);
        if (sign) cfg.project.officeName = sign;
      }
      cfg.team = seatsFor(template).map((s) => resolveSeat(template, s));
      applyTemplate(cfg, template);
      const tools: ReviewTool[] = ["coderabbit", "greptile", "copilot", "human", "custom"];
      if (tools.includes(input.reviewTool as ReviewTool)) cfg.workflow.review.tool = input.reviewTool as ReviewTool;
      if (typeof input.reviewEnabled === "boolean") cfg.workflow.review.enabled = input.reviewEnabled;
      const stack = cleanStack(input.stack);
      if (stack) {
        cfg.stack = stack;
        const specs = stackSkills(stack);
        if (specs.length) void ensureSkillCache(hub.slug, specs).catch(() => {}); // retried on Start
      }
      hub.snap.agents = cfg.team.map((a) => Hub.freshStatus(a.id));
      if (template.starter.boards.length) hub.snap.boards = structuredClone(template.starter.boards);
      hub.snap.tasks = template.starter.tasks.map((x) => ({
        id: x.id,
        boardId: x.boardId,
        stageId: x.stageId,
        title: x.title,
        ownerId: null,
        status: "todo",
        needs: [...x.needs],
        prNumber: null,
        description: x.description,
        doneWhen: x.doneWhen,
      }));
      hub.snap.welcome = false;
      hub.configChanged(); // saves .arima/config.json for the first time
      hub.planChanged();
      await sessions.recheckSetup();
      await sbx.refresh();
      hub.emit({ type: "snapshot", snapshot: structuredClone(hub.snap) });
      hub.activity("config", null, `Welcome! ${template.name} created: ${cfg.team.map((a) => `${a.name} (${a.role})`).join(", ")}. Press Start team when you're ready.`);
    },

    updateWorkflow: async (patch) => {
      const p = (patch ?? {}) as WorkflowPatch;
      const wf = hub.snap.config.workflow;
      const mergeBy = wf.merge.by;
      Object.assign(wf.review, p.review ?? {});
      if (p.merge?.by === "human" || p.merge?.by === "lead") wf.merge.by = p.merge.by;
      Object.assign(wf.deploy, p.deploy ?? {});
      if (p.lean) wf.lean = { clearBetweenTasks: wf.lean?.clearBetweenTasks !== false,
        ...wf.lean, ...(typeof p.lean.clearBetweenTasks === "boolean" ? { clearBetweenTasks: p.lean.clearBetweenTasks } : {}) };
      hub.configChanged();
      // The lead was told the old rule; tell it the new one now, so no restart is needed.
      const lead = hub.snap.config.team.find((a) => a.isLead);
      if (lead && wf.merge.by !== mergeBy && wf.mode !== "deliverables") {
        const waiting = hub.snap.pullRequests.filter((pr) => pr.review === "passed" && !pr.merged && !pr.closed).map((pr) => pr.number);
        planner.notify(lead.id, mergeByNotice(wf.merge.by, waiting, wf.review.enabled));
      }
    },

    updateProject: (patch) => {
      const p = (patch ?? {}) as Partial<ProjectConfig>;
      const project = hub.snap.config.project;
      if (typeof p.name === "string" && p.name.trim()) project.name = str(p.name, 80);
      if (typeof p.repo === "string" && p.repo.trim()) project.repo = str(p.repo, 200);
      if (typeof p.officeName === "string") {
        const name = p.officeName.trim().slice(0, OFFICE_NAME_MAX);
        if (name) project.officeName = name;
        else delete project.officeName;
      }
      let scopeChanged = false;
      if (p.scope && typeof p.scope === "object") {
        // Only valid domains / IPs / CIDRs are kept; anything else is dropped (and reported).
        const clean = (list: unknown) => (Array.isArray(list) ? list : []).map((x) => cleanEntry(String(x))).filter((x): x is string => !!x).slice(0, 500);
        const raw = [...(Array.isArray(p.scope.inScope) ? p.scope.inScope : []), ...(Array.isArray(p.scope.outOfScope) ? p.scope.outOfScope : [])].filter((x) => String(x).trim());
        project.scope = { inScope: [...new Set(clean(p.scope.inScope))], outOfScope: [...new Set(clean(p.scope.outOfScope))], rules: str(p.scope.rules ?? "", 4000) };
        const dropped = raw.length - project.scope.inScope.length - project.scope.outOfScope.length;
        if (dropped > 0) hub.activity("config", null, `Scope: ${dropped} entr${dropped === 1 ? "y wasn't" : "ies weren't"} a domain, IP or CIDR and ${dropped === 1 ? "was" : "were"} left out.`);
        scopeChanged = true;
      }
      const exportOn = typeof p.exportPlan === "boolean" && p.exportPlan && !project.exportPlan;
      if (typeof p.exportPlan === "boolean") project.exportPlan = p.exportPlan;
      hub.configChanged();
      if (exportOn) {
        hub.planChanged();
        hub.activity("config", null, "Plan export on: HQ writes docs/plan.md whenever the plan changes.");
      }
      if (scopeChanged) {
        for (const a of hub.snap.config.team) void sbx.syncRules(a.id);
        void sessions.recheckSetup(); // the scope firewall commands depend on scope and team
        const lead = hub.snap.config.team.find((a) => a.isLead);
        if (scopeChanged && lead) planner.notify(lead.id, `The engagement scope changed. In scope: ${project.scope?.inScope.join(", ") || "nothing"}. Out of scope: ${project.scope?.outOfScope.join(", ") || "nothing"}. Tell the team; anything outside scope is off limits.`);
      }
    },

    createBoard: (title) => planner.createBoard(str(title, 80)),

    updateBoard: (id, patch) => {
      const p = (patch ?? {}) as Partial<Board>;
      const status = p.status === "active" || p.status === "planned" || p.status === "done" ? p.status : undefined;
      planner.updateBoard(str(id, 20), { title: typeof p.title === "string" ? p.title : undefined, status });
    },
  };

  // A project made before templates is read-only: only commands that watch, answer or stop what already runs.
  for (const [name, fn] of Object.entries(commands)) {
    if (READ_ONLY_COMMANDS.has(name) || name === "completeWelcome") continue;
    commands[name] = (...args) => {
      if (!isReadOnly(hub.snap.config) || hub.snap.welcome) return fn(...args);
      hub.activity("config", null, "This project was made before templates and is read-only. You can watch, answer and stop its agents.");
    };
  }
  return commands;
}
