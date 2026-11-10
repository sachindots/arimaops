// The files HQ writes into each agent's folder. All of them are listed in the
// clone's .git/info/exclude, so they are never committed.

import { GATEWAY as CONTAINER_GATEWAY } from "./containers";
import { lstatSync } from "node:fs";
import { agentRead, agentRemove, agentWrite } from "./lib/agentFs";
import { run } from "./lib/exec";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";
import { ESCALATION, personaFor } from "../src/data/personas";
import { stackRoleMd } from "../src/data/stack";
import type { AgentConfig, HqConfig } from "../src/data/types";

/** Team MCP config, passed with `claude --mcp-config` (so the project's own .mcp.json is untouched). */
export const MCP_CONFIG = ".claude/hq-mcp.json";
/** Antigravity (agy) & Gemini CLI settings file. */
export const GEMINI_SETTINGS = ".gemini/settings.json";
/** Antigravity (agy) always-on rule file for the agent's persona and Team MCP instructions. */
export const AGY_RULE_FILE = ".agent/rules/hq-role.md";
export const AGYS_RULE_FILE = ".agents/rules/hq-role.md";
export const AGY_HOOKS_FILE = ".agents/hooks.json";
export const AGY_PLUGIN_DIR = ".agents/plugins/hq";
/** OpenCode project config file. */
export const OPENCODE_CONFIG = "opencode.json";
/** Local mode on Windows: hooks run this with node (no sh or curl there). */
export const HOOK_SCRIPT = BRAND.hookScript;
/** HQ's generated role file. Its own name, so a ROLE.md the project has is never overwritten. */
export const ROLE_FILE = BRAND.roleFile;
export const HQ_FILES = [ROLE_FILE, ".claude/settings.local.json", MCP_CONFIG, HOOK_SCRIPT];
export const AGY_FILES = [...HQ_FILES, GEMINI_SETTINGS, AGY_RULE_FILE, AGYS_RULE_FILE, AGY_HOOKS_FILE, AGY_PLUGIN_DIR];
export const GEMINI_FILES = [ROLE_FILE, GEMINI_SETTINGS, HOOK_SCRIPT];
export const OPENCODE_FILES = [ROLE_FILE, OPENCODE_CONFIG, HOOK_SCRIPT];
const LEGACY_FILES = [...BRAND.legacyRoleFiles, ...BRAND.legacyHookScripts];

/** Extra context for the generated role: the folder's own ROLE.md, and whether app variables are set. */
export interface RoleExtras {
  ownRole?: string | null;
  hasEnvFile?: boolean;
  /** Local mode: this agent's own ports (unique on this machine). */
  ports?: { first: number; last: number };
}

/** HQ ≤ 0.3 wrote its role to ROLE.md; recognise the old upstream and earlier headers so it can be cleaned up. */
const isHqRole = (text: string) =>
  text.includes("## Team MCP (server `hq`)") && (text.includes("You are managed by JSM HQ.") || text.includes(`You are managed by ${BRAND.name}.`));

/**
 * The folder's own ROLE.md, if it has one (it's included in the generated role). A ROLE.md that an
 * older HQ generated there is removed, along with the exclude line HQ added for it. Also cleans up
 * legacy .jsmhq-role.md / .jsmhq-hook.mjs files.
 */
export async function adoptRoleFile(dir: string): Promise<string | null> {
  for (const oldFile of LEGACY_FILES) {
    if (agentRead(dir, oldFile) !== null) {
      const trackedOld = await run("git", ["ls-files", "--error-unmatch", oldFile], { cwd: dir });
      if (!trackedOld.ok) {
        agentRemove(dir, oldFile);
        removeFromExclude(dir, [oldFile]);
      }
    }
  }
  const text = agentRead(dir, "ROLE.md");
  if (text === null) return null;
  if (!isHqRole(text)) return text.slice(0, 20_000);
  const tracked = await run("git", ["ls-files", "--error-unmatch", "ROLE.md"], { cwd: dir });
  if (!tracked.ok) {
    agentRemove(dir, "ROLE.md");
    removeFromExclude(dir, ["ROLE.md"]);
  }
  return null;
}
export const MARK = BRAND.hookMark;
/** Same marker for node hook commands (cmd and PowerShell have no `#` comments). */
const MARK_ARG = BRAND.hookMarkArg;
const isOurs = (command: string) => [MARK, MARK_ARG, ...BRAND.legacyHookMarks, ...BRAND.legacyHookMarkArgs].some((m) => command.includes(m));

/**
 * Hooks run where the agent runs. Sandboxes are Linux, so they use sh + curl;
 * a Local-mode agent on Windows uses the node script instead.
 * HQ_NODE_HOOKS=1 forces the script (to test it on macOS/Linux).
 */
export function hookScriptFor(agent: AgentConfig, dir: string): string | null {
  if (agent.mode !== "local" || (process.platform !== "win32" && process.env.HQ_NODE_HOOKS !== "1")) return null;
  return join(dir, HOOK_SCRIPT).replace(/\\/g, "/");
}

const HOOK_SCRIPT_SOURCE = `// Written by ${BRAND.name} (git-excluded). Sends this agent's hook events to HQ and bridges stdio MCP to HQ HTTP MCP.
// Usage: node ${HOOK_SCRIPT} <url> <token> [--print-reply] | --print-role | --mcp-stdio
import { readFileSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => !${JSON.stringify([MARK_ARG, ...BRAND.legacyHookMarkArgs])}.includes(a));
if (args[0] === "--print-role") {
  try {
    process.stdout.write(readFileSync(new URL("./${ROLE_FILE}", import.meta.url), "utf8"));
  } catch {}
  process.exit(0);
}
if (args[0] === "--mcp-stdio") {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(new URL("./${MCP_CONFIG}", import.meta.url), "utf8")).mcpServers.hq;
  } catch {
    process.exit(1);
  }
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      fetch(cfg.url, {
        method: "POST",
        headers: { ...cfg.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: line,
      })
        .then(async (res) => {
          const text = (await res.text()).trim();
          if (text) process.stdout.write(text + "\\n");
        })
        .catch(() => {});
    }
  });
} else {
  const [url, token, print] = args;
  let body = "";
  let sent = false;
  const send = async () => {
    if (sent) return;
    sent = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: body || "{}",
        signal: AbortSignal.timeout(4000),
      });
      // Stop: HQ's reply ({"decision":"block",...}) hands over queued messages.
      if (print === "--print-reply" && res.ok) process.stdout.write(await res.text());
    } catch {}
    process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (body += d));
  process.stdin.on("end", send);
  setTimeout(send, 2000).unref();
}
`;

export function writeHookScript(dir: string) {
  agentWrite(dir, HOOK_SCRIPT, HOOK_SCRIPT_SOURCE);
}

// PostToolUse: the moment a question or permission prompt is answered, the tool completes.
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"] as const;
const GEMINI_HOOK_EVENTS = ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "Notification", "AfterAgent", "SessionEnd"] as const;

/** URL agents use to reach HQ: through the sandbox proxy, the container network's gateway, or straight to localhost. */
export function hqUrl(agent: AgentConfig, port: number): string {
  if (agent.mode === "container") return `http://${CONTAINER_GATEWAY}:${port}`;
  return agent.mode === "sandbox" ? `http://host.docker.internal:${port}` : `http://127.0.0.1:${port}`;
}

export function roleMd(agent: AgentConfig, cfg: HqConfig, extras: RoleExtras = {}): string {
  const team = cfg.team
    .map((a) => `- ${a.name} — [${(a.department ?? "eng").toUpperCase()}] ${a.role}${a.isLead ? " (lead)" : ""}${a.id === agent.id ? " ← you" : ""}`)
    .join("\n");
  const isDeliverables = cfg.workflow.mode === "deliverables";
  const isExecOrLead = !!(agent.isLead || agent.department === "exec" || agent.role.toLowerCase().includes("cto"));

  const rules = isExecOrLead
    ? isDeliverables
      ? [
          "You plan the mission and assign tasks to the team across department pods. You coordinate and review deliverables rather than executing worker tasks yourself.",
          "Break goals into clear boards and scoped tasks (`create_board`, `create_task`). Give each task explicit deliverable/file paths (`files`, e.g. `deliverables/T01-report.md`) and verifiable acceptance criteria (`doneWhen`).",
          "Assign only to agents that are running and free (check `list_workers`).",
          "When an operator marks a task `in-review`, inspect their summary or deliverable and either mark the task `done` (`update_task`) or message them with revision feedback (`send_message`).",
          "Multi-Project CTO Overwatch: You can also inspect and update all other registered ArimaOps projects on this machine using `list_projects`, `get_project_status`, `create_project_task`, and `update_project_task`.",
        ]
      : [
          "You plan the work and assign it to the team across department pods. You never write app code.",
          "Keep tasks small: one task = one branch = one PR. Give each task the files it may edit and a clear done-when.",
          "Assign only to agents that are running and free (check list_workers).",
          cfg.workflow.merge.by === "lead"
            ? "You merge PRs once they pass review (`gh pr merge <number> --squash --delete-branch`), one at a time, in an order that avoids conflicts. HQ tells you when each one passes."
            : "The user merges PRs; never merge one yourself. Decide the order they should land in, and tell the user if one blocks another.",
          "If the user changes who merges, HQ tells you. Follow the latest message.",
          "Multi-Project CTO Overwatch: You can also inspect and update all other registered ArimaOps projects on this machine using `list_projects`, `get_project_status`, `create_project_task`, and `update_project_task`.",
        ]
    : isDeliverables
      ? [
          "Work only on the task you were given (`get_my_task`).",
          "Write your output, research report, security audit, or artifact to the files listed on the task (or `deliverables/<TASK-ID>.md` if no file path was specified).",
          "Edit only the files or deliverable paths the task lists. Need another file or input from a teammate? Ask the lead or teammate with `send_message`.",
          "When your deliverable satisfies `doneWhen`, call `set_my_status` with `in-review` (or `done` if no review is required) and a concise summary + deliverable path in `note` / `deliverablePath`.",
          "`set_my_status` notifies the lead automatically. Don't also `send_message` the same news.",
          "If you are blocked or need a decision, call `set_my_status` with `blocked` and the reason.",
        ]
      : [
          "Work only on the task you were given. One task = one branch = one PR.",
          "When HQ tells you to start a task, call get_my_task first, then `git pull origin main` and create a branch.",
          "Edit only the files the task lists. Need another file? Ask the lead with send_message.",
          "Title PRs `[TASK-ID] Short title` and open them with `gh pr create`, then call set_my_status in-review with the PR number.",
          "set_my_status tells the lead automatically. Don't also send_message the same news.",
          "If you are blocked or need a decision, call set_my_status blocked with the reason.",
        ];
  if (isExecOrLead)
    rules.push(
      "You are in charge of this team day to day. The user gives direction and decisions; everything else is yours: plan, assign, review, unblock, and keep work moving.",
      "Ask the user (ask_user) only for what is really theirs: money, accounts and credentials, anything public or hard to undo, or a change of scope or direction. Decide the rest yourself and report at milestones.",
      "If the user hasn't answered after 30 minutes, keep going: make reversible decisions yourself, tell the user what you decided (send_message to \"you\"), and park only the work that truly needs them.",
      "HQ alerts you when an agent is stuck, idle with open work, silent, or out of usage. Act on each one: check on the agent, give it a way forward, or reassign the task.",
    );
  else
    rules.push(
      "Questions about scope, approach or priorities go to the lead (send_message), not the user. Use ask_user only for things only the human can do.",
    );
  rules.push(
    "When you need the user to do something outside your sandbox (create an account, database or API key, change a setting in a dashboard, put a value in your env file), call ask_user with a short title and clear steps, then keep working on what you can. Never put secret values in it; name the variable instead. Variables reach you through HQ: ask the user to add NAME to your App variables in HQ (Settings → Sandbox → App variables) and restart you; there is no env file inside your sandbox to edit.",
  );
  // Project type: what this engagement allows and how work is approved.
  const project = cfg.project;
  if (project.type === "security") {
    const sc = project.scope;
    rules.push(
      `This is an authorized security engagement. Touch ONLY in-scope targets. In scope: ${sc?.inScope.join(", ") || "(not set yet: don't scan anything; ask the user for the scope)"}. Out of scope (never touch, even if linked from in-scope pages): ${sc?.outOfScope.join(", ") || "none listed"}.`,
      ...(sc?.rules ? [`Rules of engagement: ${sc.rules.replace(/\s*\n\s*/g, " ")}`] : []),
      "No denial of service, no destructive actions, no data exfiltration beyond the minimum proof; redact secrets and personal data in evidence. If something looks out of scope or risky, stop and ask the user (ask_user).",
      "Record each vulnerability with report_finding (severity, in-scope target, reproducible evidence, remediation). Check list_findings first to avoid duplicates. HQ writes deliverables/security-report.md from them.",
    );
  } else if (project.type === "ops") {
    rules.push(
      "This is an ops / infra project: before changing any system, call submit_plan with the exact commands, hosts, impact and rollback, then WAIT. Execute only after HQ tells you the user approved it; if rejected, revise and resubmit. Read-only investigation is fine meanwhile.",
    );
  } else if (project.type === "research") {
    rules.push("This is a research / docs project: deliver well-sourced documents. Cite sources with links, separate facts from your conclusions, and say what you couldn't verify.");
  }
  // Sandboxes block most sites; the agent asks instead of working around it.
  if (agent.mode !== "local")
    rules.push(
      "Your sandbox blocks most websites and APIs. If a request you need is blocked (a docs page or an API: usually a 403 saying 'Approval required for <host>'), call request_access with the domain and why, then continue with other work until HQ tells you it was answered. Never work around the block.",
    );
  const persona = personaFor(agent.role, agent.isLead);
  const peers = cfg.team
    .filter((a) => a.id !== agent.id)
    .map((a) => `- ${a.name} (${a.role}${a.isLead ? ", lead" : ""}): ask about ${personaFor(a.role, a.isLead).askMeAbout}.`);
  const tools = isExecOrLead
    ? `list_workers, get_status, list_tasks, create_board, create_task, update_task, assign_task, list_projects, get_project_status, create_project_task, update_project_task, send_message, ask_user, request_access${project.type === "security" ? ", list_findings, report_finding, update_finding" : ""}${project.type === "ops" ? ", submit_plan" : ""}`
    : `get_my_task, set_my_status, list_workers, get_status, list_tasks, list_projects, get_project_status, send_message, ask_user, request_access${project.type === "security" ? ", list_findings, report_finding" : ""}${project.type === "ops" ? ", submit_plan" : ""}`;
  return [
    `# ${agent.name} — ${agent.role}`,
    "",
    agent.roleMd.trim(),
    "",
    "## Team",
    team,
    "",
    `## Workflow Mode: ${isDeliverables ? "Deliverables (Universal Mission Mode — no GitHub PR required)" : "GitHub Pull Requests (1 task = 1 branch = 1 PR)"}`,
    ...rules.map((r) => `- ${r}`),
    "",
    `## How you work (${persona.kind})`,
    persona.trait,
    ...persona.style.map((x) => `- ${x}`),
    "- Smallest complete change: reuse what the codebase already has, add no dependency or option nobody asked for, and verify against the real thing (tests, a real run) before set_my_status.",
    "- No AI slop in code or prose: no narrating comments, no filler words, no hype.",
    "",
    "## How you talk",
    `${persona.voice} Keep messages short (1-3 sentences) and concrete: files, commands, results. Full sentences, no jargon dumps. set_my_status already tells the lead; don't repeat it with send_message.`,
    "",
    "## Working with teammates",
    "Message a teammate directly (send_message to their name) when your question is about their work; list_tasks shows who built what. Go to the lead for scope, priorities, who owns which files, and anything blocking you.",
    ...peers,
    "",
    ...(extras.ports
      ? [
          "## Your ports",
          `Run dev servers, previews and test servers only on ports ${extras.ports.first}-${extras.ports.last} ($PORT is ${extras.ports.first}). They're yours on this machine; other agents, in this and other projects, have their own. Pass the port explicitly (e.g. \`--port $PORT\`) when a tool defaults to 3000, 5173 or 8080.`,
          "",
        ]
      : []),
    "## When things go wrong",
    ...ESCALATION.map((x) => `- ${x}`),
    "",
    ...(agent.skills.length
      ? [
          "## Assigned Skills",
          `Your workspace has these skills installed in \`.claude/skills/\`, \`.agents/skills/\`, and \`.agent/skills/\`: ${agent.skills.map((s) => `\`${s}\``).join(", ")}. Read and follow the relevant \`SKILL.md\` when executing tasks.`,
          "",
        ]
      : []),
    ...(stackRoleMd(cfg.stack) ? [stackRoleMd(cfg.stack), ""] : []),
    ...(extras.hasEnvFile
      ? [
          "## App variables",
          "Your session already has this project's app variables (from HQ's env file) as environment variables. There is no .env file for them. See the names with `printenv | cut -d= -f1`; never print or commit the values. Code reads them from the environment as usual. Don't create a .env file with them unless the user asks.",
          "",
        ]
      : []),
    ...(extras.ownRole?.trim() ? ["## From ROLE.md in this folder", extras.ownRole.trim(), ""] : []),
    "## Team MCP (server `hq`)",
    `Your tools: ${tools}.`,
    `Messages that start with \`[HQ]\` come from ${BRAND.name}: assignments from the lead, or messages from teammates. Act on them.`,
    "Teammates work in their own sandboxes and cannot see your files or terminal. Talk to them only with send_message.",
    "",
    `Project: ${cfg.project.name} (${cfg.project.repo}). You are managed by ${BRAND.name}.`,
    "",
  ].join("\n");
}

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; permissions?: { allow?: string[]; [k: string]: unknown }; [k: string]: unknown };

export function hookCommand(url: string, token: string, agentId: string, event: string, script: string | null = null): string {
  const isStop = event === "Stop" || event === "AfterAgent";
  if (script) return `node "${script}" ${url}/hook/${agentId}/${event} ${token}${isStop ? " --print-reply" : ""} ${MARK_ARG}`;
  // Stop prints HQ's reply: {"decision":"block","reason":…} hands over queued messages.
  const out = isStop ? "2>/dev/null" : ">/dev/null 2>&1";
  return `curl -sf -m 4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' --data-binary @- '${url}/hook/${agentId}/${event}' ${out} || true ${MARK}`;
}

/**
 * Hooks report state to HQ. SessionStart also prints ROLE.md, which Claude Code
 * adds to the session's context. Existing user hooks are kept.
 */
export function writeSettings(dir: string, agent: AgentConfig, port: number, token: string) {
  const script = hookScriptFor(agent, dir);
  const file = ".claude/settings.local.json";
  let settings: Settings = {};
  const existing = agentRead(dir, file); // a symlink reads as missing: never pull in a host file
  if (existing) {
    try {
      settings = JSON.parse(existing) as Settings;
    } catch {
      settings = {};
    }
  }
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  const url = hqUrl(agent, port);
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isOurs(h.command)) }))
      .filter((e) => e.hooks.length);
    const ours: HookEntry["hooks"] = [{ type: "command", command: hookCommand(url, token, agent.id, event, script), timeout: 5 }];
    if (event === "SessionStart")
      ours.unshift({ type: "command", command: script ? `node "${script}" --print-role ${MARK_ARG}` : `cat "${ROLE_FILE}" 2>/dev/null || true ${MARK}` });
    hooks[event] = [...kept, event === "PreToolUse" || event === "PostToolUse" ? { matcher: "*", hooks: ours } : { hooks: ours }];
  }
  // Let the agent use the Team MCP without a permission prompt for every call.
  const allow = new Set([...(settings.permissions?.allow ?? []), "mcp__hq"]);
  // No "Co-Authored-By: Claude" / "Generated with Claude Code" in agents' commits and PRs: the work is the user's.
  const attribution = { commit: "", pr: "" };
  agentWrite(dir, file, JSON.stringify({ ...settings, attribution, hooks, permissions: { ...(settings.permissions ?? {}), allow: [...allow] } }, null, 2) + "\n");
}

/** Team MCP config: HQ's URL plus this agent's identity and token. */
export function writeMcpConfig(dir: string, agent: AgentConfig, port: number, token: string) {
  const config = {
    mcpServers: {
      hq: { type: "http", url: `${hqUrl(agent, port)}/mcp`, headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id } },
    },
  };
  agentWrite(dir, MCP_CONFIG, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** Claude Code's files: the role (loaded by the SessionStart hook), hooks, and the Team MCP config. */
export function writeClaudeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras = {}) {
  agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, extras));
  writeSettings(dir, agent, cfg.project.hqPort, token);
  writeMcpConfig(dir, agent, cfg.project.hqPort, token);
  if (hookScriptFor(agent, dir)) writeHookScript(dir);
  excludeFromGit(dir, HQ_FILES);
}

/**
 * Writes `.gemini/settings.json` for Antigravity (`agy`) and Gemini CLI (`gemini`),
 * configuring `mcpServers.hq`, lifecycle hooks, and `contextFileName`.
 */
export function writeGeminiSettings(dir: string, agent: AgentConfig, port: number, token: string) {
  const script = hookScriptFor(agent, dir);
  let settings: Record<string, unknown> = {};
  const existing = agentRead(dir, GEMINI_SETTINGS);
  if (existing) {
    try {
      settings = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const url = hqUrl(agent, port);
  const existingHooks = (settings.hooks as Record<string, HookEntry[]> | undefined) ?? {};
  const hooks: Record<string, HookEntry[]> = { ...existingHooks };
  for (const event of [...HOOK_EVENTS, ...GEMINI_HOOK_EVENTS]) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isOurs(h.command)) }))
      .filter((e) => e.hooks.length);
    const ours: HookEntry["hooks"] = [{ type: "command", command: hookCommand(url, token, agent.id, event, script), timeout: 5 }];
    if (event === "SessionStart")
      ours.unshift({ type: "command", command: script ? `node "${script}" --print-role ${MARK_ARG}` : `cat "${ROLE_FILE}" 2>/dev/null || true ${MARK}` });
    const needsMatcher = event === "PreToolUse" || event === "PostToolUse" || event === "BeforeTool" || event === "AfterTool";
    hooks[event] = [...kept, needsMatcher ? { matcher: "*", hooks: ours } : { hooks: ours }];
  }
  const mcpServers = {
    ...((settings.mcpServers as Record<string, unknown> | undefined) ?? {}),
    hq: {
      httpUrl: `${url}/mcp`,
      url: `${url}/mcp`,
      headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id },
      trust: true,
    },
  };
  agentWrite(
    dir,
    GEMINI_SETTINGS,
    JSON.stringify(
      {
        ...settings,
        contextFileName: [ROLE_FILE, "GEMINI.md", "AGENTS.md"],
        mcpServers,
        hooks,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

/**
 * Antigravity CLI (`agy`) files:
 * - `.hq-role.md`
 * - `.agent/rules/hq-role.md` (native Antigravity always-on rule)
 * - `.gemini/settings.json` (MCP server `hq` + hooks)
 * - `.claude/settings.local.json` + `.claude/hq-mcp.json` (for `--claude-config` compatibility)
 */
export function writeAgyFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras = {}) {
  const roleContent = roleMd(agent, cfg, extras);
  const ruleWithFrontmatter = `---\ntrigger: always_on\ndescription: "${BRAND.name} role, team roster, and Team MCP instructions"\n---\n\n${roleContent}`;
  agentWrite(dir, ROLE_FILE, roleContent);
  agentWrite(dir, AGY_RULE_FILE, ruleWithFrontmatter);
  agentWrite(dir, AGYS_RULE_FILE, ruleWithFrontmatter);

  const url = hqUrl(agent, cfg.project.hqPort);
  const agyHookCmd = (event: string, fallbackJson: string) =>
    `curl -sf -m 4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' --data-binary @- '${url}/hook/${agent.id}/${event}' 2>/dev/null || echo '${fallbackJson}'`;
  const agyHooksJson =
    JSON.stringify(
      {
        hq: {
          PreInvocation: [{ type: "command", command: agyHookCmd("PreInvocation", "{}"), timeout: 5 }],
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: agyHookCmd("PreToolUse", '{"decision":"allow"}'), timeout: 5 }] }],
          PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: agyHookCmd("PostToolUse", "{}"), timeout: 5 }] }],
          Stop: [{ type: "command", command: agyHookCmd("Stop", '{"decision":"stop"}'), timeout: 5 }],
        },
      },
      null,
      2,
    ) + "\n";
  const agyMcpUrl = `${url}/mcp?agent=${encodeURIComponent(agent.id)}&token=${encodeURIComponent(token)}`;
  const agyMcpJson =
    JSON.stringify(
      {
        mcpServers: {
          hq: {
            disabled: false,
            headers: {
              Authorization: `Bearer ${token}`,
              "X-HQ-Agent": agent.id,
            },
            serverUrl: agyMcpUrl,
          },
        },
      },
      null,
      2,
    ) + "\n";

  agentWrite(dir, AGY_HOOKS_FILE, agyHooksJson, { mode: 0o600 });
  for (const pluginDir of [AGY_PLUGIN_DIR, ".agent/plugins/hq"]) {
    agentWrite(dir, `${pluginDir}/plugin.json`, JSON.stringify({ name: "hq" }, null, 2) + "\n");
    agentWrite(dir, `${pluginDir}/mcp_config.json`, agyMcpJson, { mode: 0o600 });
    agentWrite(dir, `${pluginDir}/hooks.json`, agyHooksJson, { mode: 0o600 });
    agentWrite(dir, `${pluginDir}/rules/AGENTS.md`, roleContent);
  }

  writeGeminiSettings(dir, agent, cfg.project.hqPort, token);
  writeSettings(dir, agent, cfg.project.hqPort, token);
  writeMcpConfig(dir, agent, cfg.project.hqPort, token);
  writeHookScript(dir);
  excludeFromGit(dir, [...AGY_FILES, ".agent/plugins/hq"]);
}

/** Gemini CLI (`gemini`) files: `.hq-role.md` + `.gemini/settings.json`. */
export function writeGeminiFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras = {}) {
  agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, extras));
  writeGeminiSettings(dir, agent, cfg.project.hqPort, token);
  if (hookScriptFor(agent, dir)) writeHookScript(dir);
  excludeFromGit(dir, GEMINI_FILES);
}

/** OpenCode (`opencode`) files: `.hq-role.md` + `opencode.json` (with `mcp.hq` and `instructions`). */
export function writeOpenCodeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras = {}) {
  agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, extras));
  const url = hqUrl(agent, cfg.project.hqPort);
  let config: Record<string, unknown> = {};
  const existing = agentRead(dir, OPENCODE_CONFIG);
  if (existing) {
    try {
      config = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  const instructions = [...new Set([...(Array.isArray(config.instructions) ? (config.instructions as string[]) : []), ROLE_FILE])];
  const mcp = {
    ...((config.mcp as Record<string, unknown> | undefined) ?? {}),
    hq: {
      type: "remote",
      url: `${url}/mcp`,
      headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id },
      enabled: true,
    },
  };
  agentWrite(
    dir,
    OPENCODE_CONFIG,
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config, instructions, mcp }, null, 2) + "\n",
    { mode: 0o600 },
  );
  if (hookScriptFor(agent, dir)) writeHookScript(dir);
  excludeFromGit(dir, OPENCODE_FILES);
}

/** Removes lines HQ added to .git/info/exclude. */
export function removeFromExclude(dir: string, paths: string[]) {
  const file = ".git/info/exclude";
  const current = agentRead(dir, file);
  if (current === null) return;
  const next = current.split("\n").filter((l) => !paths.includes(l)).join("\n");
  if (next !== current) agentWrite(dir, file, next);
}

/** Adds paths to .git/info/exclude (a per-clone .gitignore that is never committed). */
export function excludeFromGit(dir: string, paths: string[]) {
  // Only a real .git folder (a worktree's .git is a file; a symlink isn't followed).
  try {
    if (!lstatSync(join(dir, ".git")).isDirectory()) return;
  } catch {
    return;
  }
  const file = ".git/info/exclude";
  const current = agentRead(dir, file) ?? "";
  const missing = paths.filter((p) => !current.split("\n").includes(p));
  if (missing.length) agentWrite(dir, file, current + (current.endsWith("\n") || !current ? "" : "\n") + `${BRAND.excludeHeader}\n` + missing.join("\n") + "\n");
}
