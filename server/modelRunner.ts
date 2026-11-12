// SPDX-License-Identifier: AGPL-3.0-or-later
// One-shot model runs for HQ itself (docs/core-model.md section 8): memory extraction, second
// opinions, judgements. Every run goes through ModelRunner and is recorded as a usage event.
//
// Two ways in: the owner's CLI sign-ins (`claude -p`, billed to the subscription) and API keys from
// the vault (customers; billed per token). Which one a run takes follows its account.

import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../src/data/providers";
import type { AgentCli, Tokens } from "../src/data/types";
import { accountEnv } from "./accounts";
import { run as exec, type RunResult } from "./lib/exec";
import { recordEvent } from "./usageEvents";

export interface RunRequest {
  /** "default" = the CLI sign-in; otherwise an account in Settings → Accounts. */
  account: string;
  model: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  purpose: "helper" | "review";
  projectId: string;
  taskId?: string;
}

export interface ModelResult {
  text: string;
  tokens: Tokens;
}

export interface ModelRunner {
  run(req: RunRequest): Promise<ModelResult>;
}

const TIMEOUT_MS = 5 * 60_000;

/** `claude -p` on a CLI sign-in: no tools, no MCP servers, no saved session, in an empty folder. */
export class ClaudeCliRunner implements ModelRunner {
  constructor(private execute: (cmd: string, args: string[], opts: Parameters<typeof exec>[2]) => Promise<RunResult> = exec) {}

  async run(req: RunRequest): Promise<ModelResult> {
    const args = ["-p", "--output-format", "json", "--model", req.model, "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
    if (req.system) args.push("--system-prompt", req.system);
    const cwd = mkdtempSync(join(tmpdir(), "arima-run-"));
    try {
      const r = await this.execute("claude", args, { cwd, input: req.prompt, timeoutMs: TIMEOUT_MS, env: accountEnv("claude", req.account) });
      let out: { result?: string; is_error?: boolean; usage?: Record<string, number> } | null = null;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        /* not JSON: reported below */
      }
      if (!out || out.is_error || typeof out.result !== "string") throw new Error(`claude -p failed: ${(out?.result ?? r.stderr ?? r.stdout).toString().slice(0, 300)}`);
      const u = out.usage ?? {};
      return {
        text: out.result,
        tokens: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/** The Messages API with an Anthropic key from the vault. */
export class AnthropicKeyRunner implements ModelRunner {
  constructor(private key: (account: string) => string | null, private client = (apiKey: string) => new Anthropic({ apiKey })) {}

  async run(req: RunRequest): Promise<ModelResult> {
    const apiKey = this.key(req.account);
    if (!apiKey) throw new Error(`Account "${req.account}" has no Anthropic API key.`);
    const res = await this.client(apiKey).messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: "user", content: req.prompt }],
    });
    if (res.stop_reason === "refusal") throw new Error(`${req.model} declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}.`);
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const u = res.usage;
    return {
      text,
      tokens: { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens },
    };
  }
}

export interface AccountLookup {
  /** The account's provider when it is an API-key or cloud account; null for a CLI sign-in. */
  provider(account: string): Provider | null;
}

const cliOf = (model: string): AgentCli | null => (/^(claude|opus|sonnet|haiku|fable)/i.test(model) ? "claude" : null);

/** Picks the way in for each run's account, and records every finished run as a usage event. */
export class MeteredRunner implements ModelRunner {
  constructor(
    private db: DatabaseSync,
    private accounts: AccountLookup,
    private viaCli: ModelRunner,
    private viaAnthropicKey: ModelRunner,
  ) {}

  async run(req: RunRequest): Promise<ModelResult> {
    const provider = this.accounts.provider(req.account);
    let result: ModelResult;
    let cli: AgentCli | null = null;
    if (provider === "anthropic") result = await this.viaAnthropicKey.run(req);
    else if (provider) throw new Error(`Runs on ${provider} accounts aren't supported yet. Use an Anthropic account or a CLI sign-in.`);
    else if ((cli = cliOf(req.model))) result = await this.viaCli.run(req);
    else throw new Error(`HQ runs "${req.model}" one-shot only through Claude Code for now.`);
    recordEvent(this.db, {
      projectId: req.projectId,
      taskId: req.taskId ?? null,
      agentId: null,
      source: req.purpose,
      account: req.account,
      provider: provider ?? "anthropic",
      cli,
      model: req.model,
      tokens: result.tokens,
    });
    return result;
  }
}
