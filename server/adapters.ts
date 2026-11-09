// Per-CLI differences: which files .hq writes into the agent's folder and how
// the agent is launched in both Local mode and Docker Sandbox mode.
// Everything else (hooks → state, Team MCP, message delivery) is shared.

import { agentWrite } from "./lib/agentFs";
import { BRAND } from "../src/data/brand";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";
import {
  adoptRoleFile,
  excludeFromGit,
  HOOK_SCRIPT,
  type RoleExtras,
  hookCommand,
  hookScriptFor,
  hqUrl,
  MCP_CONFIG,
  roleMd,
  writeAgyFiles,
  writeClaudeFiles,
  writeGeminiFiles,
  writeHookScript,
  writeOpenCodeFiles,
} from "./agentFiles";
import { run } from "./lib/exec";

export interface Launch {
  /** Agent template name for `sbx run` ("claude" | "codex" | "gemini" | "copilot" | "shell"). */
  sbxAgent: string;
  /** The CLI's own arguments in Local mode. */
  args: string[];
  /** Optional override arguments passed after `--` to `sbx run` when sandbox invocation differs from Local mode. */
  sbxArgs?: string[];
}

/**
 * Container mode: the CLI's arguments plus its "don't ask before each command" flag. The container and the
 * allowlist proxy are the boundary (as the microVM is for sbx's templates), so prompts would only stall the agent.
 */
const CONTAINER_YOLO: Partial<Record<AgentCli, string[]>> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--yolo"],
  copilot: ["--allow-all-tools"],
  opencode: [],
};
export const containerArgs = (cli: AgentCli, launch: Launch) => [...launch.args, ...(CONTAINER_YOLO[cli] ?? [])];

export interface CliAdapter {
  /** Writes .hq's files into the agent's folder (all git-excluded). */
  writeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras?: RoleExtras): Promise<void>;
  launch(agent: AgentConfig): Launch;
}

const cleanModel = (raw: string): string | null => {
  const m = raw.trim();
  return !m || /^default$/i.test(m) ? null : m;
};

// ---------------------------------------------------------------- Claude Code (`claude`)

const claude: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent) {
    // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
    const m = cleanModel(agent.model);
    const model = m && /^(opus|sonnet|haiku)$/i.test(m) ? m.toLowerCase() : m;
    // Relative to the agent's folder, where it starts.
    const args = ["--mcp-config", MCP_CONFIG, ...(model ? ["--model", model] : [])];
    return { sbxAgent: "claude", args };
  },
};

// ---------------------------------------------------------------- OpenAI Codex (`codex`)

export const CODEX_CONFIG = ".codex/config.toml";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/** TOML basic string (JSON's escaping is valid TOML for these characters). */
const t = (s: string) => JSON.stringify(s);

export function codexConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, extras: RoleExtras = {}): string {
  const url = hqUrl(agent, cfg.project.hqPort);
  const script = hookScriptFor(agent, dir);
  const lines = [
    `# Written by ${BRAND.name} for this agent (git-excluded). Codex loads it once you trust this folder.`,
    `developer_instructions = ${t(roleMd(agent, cfg, extras))}`,
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.hq]",
    `url = ${t(`${url}/mcp`)}`,
    `http_headers = { Authorization = ${t(`Bearer ${token}`)}, "X-HQ-Agent" = ${t(agent.id)} }`,
    // HQ's own team tools; without this Codex asks before every call and the agent stalls unattended.
    'default_tools_approval_mode = "approve"',
  ];
  for (const event of CODEX_EVENTS)
    lines.push("", `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(hookCommand(url, token, agent.id, event, script))}`);
  return lines.join("\n") + "\n";
}

const codex: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const tracked = await run("git", ["ls-files", "--error-unmatch", CODEX_CONFIG], { cwd: dir });
    if (tracked.ok)
      throw new Error(
        `This repo commits ${CODEX_CONFIG}, so ${BRAND.name} can't add its Codex settings without changing a tracked file. Choose another CLI for this agent, or remove that file from the repo.`,
      );
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, CODEX_CONFIG, codexConfig(agent, cfg, token, dir, { ...extras, ownRole }), { mode: 0o600 });
    if (hookScriptFor(agent, dir)) writeHookScript(dir);
    excludeFromGit(dir, [CODEX_CONFIG, HOOK_SCRIPT]);
  },
  launch(agent) {
    const raw = cleanModel(agent.model);
    // Older configs saved "gpt-5.4" / "gpt-5.3-codex" / "o3", which Codex v0.167+ rejects on ChatGPT OAuth accounts.
    const model = raw && /^(gpt-5\.4|gpt-5\.3-codex|o3)$/i.test(raw) ? "gpt-6.1-sol" : raw;
    // On the command line: the folder's config.toml is read only after the trust prompt, and an update menu
    // shown before it would stall an unattended agent.
    const args = ["-c", "check_for_update_on_startup=false", ...(model ? ["-m", model] : [])];
    return { sbxAgent: "codex", args };
  },
};

// ---------------------------------------------------------------- Antigravity CLI (`agy`)

const agy: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeAgyFiles(dir, agent, cfg, token, { ...extras, ownRole });
    if (agent.mode === "local") {
      await run("agy", ["mcp", "add", "hq", "node", `./${HOOK_SCRIPT}`, "--mcp-stdio"], { cwd: dir, timeoutMs: 5000 }).catch(() => {});
    }
  },
  launch(agent) {
    const model = cleanModel(agent.model);
    // `agy` runs interactively at the root command; `--dangerously-skip-permissions` prevents tool confirmation hangs.
    const args = ["--dangerously-skip-permissions", "--mode", "auto", ...(model ? ["--model", model] : [])];
    const cmdStr = ["agy", ...args.map((a) => `'${a.replace(/'/g, "'\\''")}'`)].join(" ");
    const sbxScript = `if command -v agy >/dev/null 2>&1; then agy mcp add hq node ./${HOOK_SCRIPT} --mcp-stdio >/dev/null 2>&1 || true; exec ${cmdStr}; elif command -v antigravity >/dev/null 2>&1; then exec antigravity ${args.join(" ")}; else echo "[.hq] Antigravity CLI (agy) is not pre-installed in this Docker Sandbox VM image. Install agy in the sandbox shell or switch this agent to Local mode."; exec bash -l; fi`;
    return {
      sbxAgent: "shell",
      args,
      sbxArgs: ["-c", sbxScript],
    };
  },
};

// ---------------------------------------------------------------- OpenCode (`opencode`)

const opencode: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeOpenCodeFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent) {
    const model = cleanModel(agent.model);
    const args = model ? ["-m", model] : [];
    const cmdStr = ["opencode", ...args.map((a) => `'${a.replace(/'/g, "'\\''")}'`)].join(" ");
    const sbxScript = `if ! command -v opencode >/dev/null 2>&1; then echo "[.hq] Installing OpenCode CLI in sandbox…"; npm install -g opencode-ai >/dev/null 2>&1 || true; fi; exec ${cmdStr}`;
    return {
      sbxAgent: "shell",
      args,
      sbxArgs: ["-c", sbxScript],
    };
  },
};

// ---------------------------------------------------------------- Gemini CLI (`gemini`)

const gemini: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeGeminiFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent) {
    const model = cleanModel(agent.model);
    const args = model ? ["-m", model] : [];
    return { sbxAgent: "gemini", args };
  },
};

// ---------------------------------------------------------------- GitHub Copilot CLI (`copilot`)

const COPILOT_INSTRUCTIONS = ".github/copilot-instructions.md";

const copilot: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
    const tracked = await run("git", ["ls-files", "--error-unmatch", COPILOT_INSTRUCTIONS], { cwd: dir });
    if (!tracked.ok) {
      agentWrite(dir, COPILOT_INSTRUCTIONS, roleMd(agent, cfg, { ...extras, ownRole }));
      excludeFromGit(dir, [COPILOT_INSTRUCTIONS]);
    }
  },
  launch(agent) {
    const model = cleanModel(agent.model);
    const args = [
      "--additional-mcp-config",
      `@${MCP_CONFIG}`,
      ...(model ? ["--model", model] : []),
    ];
    return { sbxAgent: "copilot", args };
  },
};

export const adapters: Record<AgentCli, CliAdapter> = {
  claude,
  codex,
  agy,
  opencode,
  gemini,
  copilot,
};

/** The command a Local-mode agent runs on the host. */
export const localBinary: Record<AgentCli, string> = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
  opencode: "opencode",
  gemini: "gemini",
  copilot: "copilot",
};
