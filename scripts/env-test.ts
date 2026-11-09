// HQ started inside a Claude Code / Codex session must not pass that session to its agents.
// Run: npx tsx scripts/env-test.ts
import { execFileSync } from "node:child_process";
import { SCRUB_SHELL, scrubParentSession } from "../server/lib/cleanEnv";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const parent = {
  PATH: process.env.PATH,
  HOME: "/home/x",
  CLAUDECODE: "1",
  CLAUDE_CODE_MESSAGING_TOKEN: "secret",
  CLAUDE_CODE_SESSION_ID: "s1",
  CLAUDE_AGENT_SDK_VERSION: "1",
  CLAUDE_PID: "42",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
  CODEX_SANDBOX: "seatbelt",
  MY_APP_KEY: "keep",
  CLAUDE_CONFIG_DIR: "/home/x/.claude-work", // a user setting, not the parent's: kept
};

const env = { ...parent } as NodeJS.ProcessEnv;
const removed = scrubParentSession(env);
check("parent session variables removed", !env.CLAUDECODE && !env.CLAUDE_CODE_MESSAGING_TOKEN && !env.CLAUDE_PID && !env.CLAUDE_AGENT_SDK_VERSION && !env.CODEX_SANDBOX, removed.join(","));
check("the parent's ANTHROPIC_BASE_URL removed", env.ANTHROPIC_BASE_URL === undefined);
check("your own variables kept", env.MY_APP_KEY === "keep" && env.CLAUDE_CONFIG_DIR === "/home/x/.claude-work" && env.HOME === "/home/x");

const own = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" } as NodeJS.ProcessEnv;
scrubParentSession(own);
check("ANTHROPIC_BASE_URL kept when not inside Claude Code", own.ANTHROPIC_BASE_URL === "https://api.deepseek.com/anthropic");

// The same in the shell line tmux runs (an already-running tmux server may hold the parent's env).
const out = execFileSync("sh", ["-c", `${SCRUB_SHELL} env`], { env: parent as NodeJS.ProcessEnv, encoding: "utf8" });
const names = out.split("\n").map((l) => l.split("=")[0]);
check("shell: parent variables unset", !names.some((n) => /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID|CODEX_SANDBOX|ANTHROPIC_BASE_URL)/.test(n)), names.filter((n) => n.startsWith("CLAUDE") || n.startsWith("ANTH")).join(","));
check("shell: your variables kept", names.includes("MY_APP_KEY") && names.includes("CLAUDE_CONFIG_DIR"));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
