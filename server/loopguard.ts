// Spots an agent going round in circles on a task, from its tool hooks (no transcript reading).
// Free gate first; only when it opens does a Haiku judge decide "stuck" vs "making progress".
// A stuck agent gets one short nudge per task, and the lead is told.

export interface ToolEvent {
  tool: string;
  command: string; // shell command or file path, for the digest
  failed: boolean;
  error: string; // first error line, when failed
}

export interface Verdict {
  stuck: boolean;
  confidence: number;
  reason: string;
}

interface TaskWindow {
  taskId: string;
  calls: number;
  errors: number;
  repeats: Map<string, { n: number; command: string }>; // failure signature → times seen
  recent: string[]; // digest lines
  done: boolean; // nudged, or judged once and spared at this size
  judging: boolean;
  judgedAt: number; // call count at the last judgement
}

const GATE_CALLS = 18;
const GATE_ERRORS = 8;
const FALLBACK_REPEATS = 3;
const RECENT = 20;

const str = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join(" ") : "");
const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
/** Same failure, even if line numbers, ids or times differ. */
export const signature = (e: ToolEvent) => `${e.tool}:${e.command.slice(0, 120)} → ${e.error.replace(/\d+/g, "#").slice(0, 120)}`;

/** Reads a PostToolUse / PostToolUseFailure / AfterTool payload from Claude Code, Codex or Antigravity. */
export function toolEvent(event: string, body: Record<string, unknown>): ToolEvent | null {
  const call = (body.toolCall ?? {}) as Record<string, unknown>;
  const tool = str(body.tool_name) || str(call.name);
  if (!tool) return null;
  const input = (body.tool_input ?? call.args ?? {}) as Record<string, unknown>;
  const res = (body.tool_response ?? body.result ?? {}) as Record<string, unknown>;
  const command = str(input.command) || str(input.cmd) || str(input.file_path) || str(input.path) || str(input.pattern);
  const exit = typeof res.exit_code === "number" ? res.exit_code : typeof res.exitCode === "number" ? res.exitCode : 0;
  const errText = str(body.error) || str(res.error) || (exit !== 0 ? str(res.stderr) || str(res.output) || str(res.stdout) : "") || (res.is_error ? str(res.content) : "");
  const failed = event === "PostToolUseFailure" || exit !== 0 || res.is_error === true || !!str(body.error);
  return { tool, command, failed, error: failed ? firstLine(errText) || "failed" : "" };
}

export class LoopGuard {
  private windows = new Map<string, TaskWindow>();

  constructor(
    private judge: (digest: string) => Promise<Verdict | null>,
    private onStuck: (agentId: string, taskId: string, nudge: string, reason: string) => void,
  ) {}

  /** One finished tool call by `agentId` while working on `taskId` (null: no task, nothing to guard). */
  record(agentId: string, taskId: string | null, title: string, ev: ToolEvent) {
    if (!taskId) return;
    let w = this.windows.get(agentId);
    if (!w || w.taskId !== taskId) {
      w = { taskId, calls: 0, errors: 0, repeats: new Map(), recent: [], done: false, judging: false, judgedAt: 0 };
      this.windows.set(agentId, w);
    }
    w.calls++;
    w.recent.push(`${ev.failed ? "FAIL" : "ok  "} ${ev.tool} ${ev.command.slice(0, 100)}${ev.failed ? `  → ${ev.error.slice(0, 100)}` : ""}`);
    if (w.recent.length > RECENT) w.recent.shift();
    if (ev.failed) {
      w.errors++;
      const sig = signature(ev);
      w.repeats.set(sig, { n: (w.repeats.get(sig)?.n ?? 0) + 1, command: ev.command });
    }
    if (w.done || w.judging) return;
    const [worstSig, top] = [...w.repeats].sort((a, b) => b[1].n - a[1].n)[0] ?? ["", { n: 0, command: "" }];
    const worst = top.n;
    // Free gate: long enough to be a loop, and either the same failure again or many errors.
    if (w.calls < GATE_CALLS || (worst < 2 && w.errors < GATE_ERRORS)) return;
    // Judge once per 10 calls at most, so a spared agent isn't re-judged on every call.
    if (w.judgedAt && w.calls - w.judgedAt < 10) return;
    w.judging = true;
    w.judgedAt = w.calls;
    const digest = `Task: ${title}\nTool calls so far: ${w.calls}, errors: ${w.errors}\nMost repeated failure (${worst}x): ${worstSig}\nRecent calls:\n${w.recent.join("\n")}`;
    void this.judge(digest)
      .then((v) => {
        const win = this.windows.get(agentId);
        if (!win || win.taskId !== taskId) return; // moved on meanwhile
        win.judging = false;
        const stuck = v ? v.stuck && v.confidence >= 0.7 : worst >= FALLBACK_REPEATS;
        if (!stuck) return;
        win.done = true;
        const reason = v?.reason || `the same failure ${worst} times`;
        const nudge =
          `HQ: you look stuck on ${taskId} (${reason}). ` +
          (top.command ? `Stop repeating "${top.command.slice(0, 80)}". ` : "") +
          `Re-read the task and the last error, try a different approach, ` +
          `or tell the lead what blocks you with send_message.`;
        this.onStuck(agentId, taskId, nudge, reason);
      })
      .catch(() => {
        w.judging = false;
      });
  }

  forget(agentId: string) {
    this.windows.delete(agentId);
  }
}

/** The judge's instructions (adapted from TokenEconomizer's stuck judge: judge the workflow, favour sparing). */
export const JUDGE_PROMPT = `You watch an AI coding agent partway through ONE task. A cheap rule flagged its recent tool calls as a possible unproductive loop.
Decide whether it is genuinely STUCK (repeating the same edit/test/failure with no progress, unlikely to recover going the same way) or still making progress (changing failures, narrowing the problem, trying new ideas).
Judge only the workflow below; don't solve the task. Prefer stuck=false when there is any sign of progress.
Reply with only JSON: {"stuck": true|false, "confidence": 0.0-1.0, "reason": "<under 15 words>"}

`;
