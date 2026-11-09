// HQ started from inside a coding agent's terminal (a Claude Code or Codex session, e.g. a terminal tab in the
// Claude desktop app) inherits that session's variables. Passed on to HQ's agents, they make each agent's CLI
// act as a child of that session: Claude Code bills through the parent's ANTHROPIC_BASE_URL instead of your
// own login, and gets the parent's messaging socket/token. HQ's agents must start clean.

/** Variables a parent agent session sets; never meant for HQ's agents. */
export const PARENT_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_AGENT_SDK_[A-Z0-9_]+|CLAUDE_DESKTOP_[A-Z0-9_]+|CLAUDE_PLUGIN_[A-Z0-9_]+|CLAUDE_PREVIEW_[A-Z0-9_]+|CLAUDE_AUTOCOMPACT_[A-Z0-9_]+|CLAUDE_PID|CLAUDE_EFFORT|CODEX_SANDBOX[A-Z0-9_]*|CODEX_THREAD_ID)$/;

/** Removes a parent agent session's variables from `env` (in place); returns the names removed. */
export function scrubParentSession(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  // ANTHROPIC_BASE_URL is the parent's proxy only when we run inside Claude Code; otherwise it's yours (kept).
  if (env.CLAUDECODE && env.ANTHROPIC_BASE_URL !== undefined) {
    delete env.ANTHROPIC_BASE_URL;
    removed.push("ANTHROPIC_BASE_URL");
  }
  for (const k of Object.keys(env))
    if (PARENT_SESSION_VARS.test(k)) {
      delete env[k];
      removed.push(k);
    }
  return removed;
}

/**
 * Shell prefix for agent sessions: an already-running tmux server may have been started from such a terminal
 * and hands its environment to new sessions, so unset the same names there too.
 */
export const SCRUB_SHELL =
  `[ -n "$CLAUDECODE" ] && unset ANTHROPIC_BASE_URL; ` +
  `for __hq_v in $(env | sed -n 's/^\\(CLAUDECODE\\|CLAUDE_CODE_[A-Z0-9_]*\\|CLAUDE_AGENT_SDK_[A-Z0-9_]*\\|CLAUDE_DESKTOP_[A-Z0-9_]*\\|CLAUDE_PLUGIN_[A-Z0-9_]*\\|CLAUDE_PREVIEW_[A-Z0-9_]*\\|CLAUDE_AUTOCOMPACT_[A-Z0-9_]*\\|CLAUDE_PID\\|CLAUDE_EFFORT\\|CODEX_SANDBOX[A-Z0-9_]*\\|CODEX_THREAD_ID\\)=.*/\\1/p'); do unset "$__hq_v"; done; unset __hq_v; `;
