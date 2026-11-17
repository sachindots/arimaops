# Stream-json engine for Claude Code agents

Status: built 2026-11-17, approved by the owner as sketched (open questions answered with the defaults: a log view, Local mode stays on the terminal engine, opt-in per agent). As-built notes at the end.

## Why

Today every agent is a CLI's full-screen terminal UI in tmux. HQ learns its state from hooks plus matching
patterns on the last screen lines (`server/screen.ts`), and delivers messages by typing them in
(`tmux send-keys`, then Enter, then Enter again if no hook fired). That breaks when a CLI rewords its footer,
and a message can land in an open dialog.

Claude Code has a headless mode that speaks JSON lines both ways:

```
claude -p --input-format stream-json --output-format stream-json --verbose [--resume <session>]
```

Messages go in as JSON on stdin; out come events: `system` (init, with the session id), `assistant` (text,
tool calls), `user` (tool results), and `result` once per turn, with exact tokens and cost. State comes from
events, not from the screen, and nothing is ever typed into a prompt.

## Goals and limits

- **Claude Code only, sandbox and container modes only, opt-in per agent.** Every other agent keeps today's
  terminal engine, unchanged. Local mode is left out because headless mode can't show a permission prompt
  (see open question 2).
- Agents still outlive HQ, still have a live terminal in the UI, still use hooks and the Team MCP.
- Not in scope: other CLIs, replacing tmux, a new chat UI.

## Two shapes considered

**A. HQ owns the process.** HQ spawns `claude -p …` (through `sbx exec` or `docker run -i`) and holds its
stdin and stdout directly. Simple, but the agent dies whenever HQ restarts, which loses the persistence tmux
gives today, and the terminal view has to be rebuilt from events.

**B (chosen). A small runner inside tmux, talking to HQ over the agent's existing channel.** tmux runs
`node arima-run.mjs`, which starts `claude -p …` and:
- gets messages by long-polling HQ (`GET /agent/<id>/next`, with the same per-agent token as hooks and MCP);
- writes one message to claude's stdin only after the previous turn's `result` event, so nothing lands mid-turn;
- posts each event to HQ (`POST /agent/<id>/events`), and prints a readable version to its own terminal, which
  is what the UI's terminal view shows.

B keeps persistence (tmux), works in every mode (the runner runs where claude runs, and already reaches HQ),
and keeps the terminal. The cost is one small script to ship and an HTTP endpoint pair.

## Usage first

```ts
// server/sessions.ts, when starting an agent:
const spec = agent.engine === "stream" ? streamLaunch(agent, token) : adapter.launch(agent); // tmux either way

// server/inbox.ts, delivery:
if (agent.engine === "stream") streamQueue.push(agentId, text); // the runner pulls it when the turn is over
else await keys.type(agentId, text);                              // today's path, untouched

// server/http.ts, the runner's two calls (agent token, like /hook and /mcp):
GET  /agent/:id/next     → { text } | 204 after 25 s   (long poll)
POST /agent/:id/events   ← StreamEvent[]               (batched, at most once a second)
```

## Types

```ts
// src/data/types.ts
export type AgentEngine = "terminal" | "stream";            // AgentConfig.engine?, default "terminal"

// server/streamEngine.ts (new): turns events into the same status and usage HQ shows today
export type StreamEvent =
  | { type: "system"; subtype: "init"; session_id: string; model: string }
  | { type: "assistant"; message: { content: ({ type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown })[] } }
  | { type: "user"; message: { content: { type: "tool_result"; is_error?: boolean }[] } }
  | { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution"; total_cost_usd: number;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }; session_id: string };

export class StreamEngine {
  constructor(hub: Hub, usage: UsageSink) {}
  /** Validates and applies a batch from the runner: status, activity, exact usage. Unknown events are ignored. */
  events(agentId: string, batch: unknown[]): void { throw new Error("not implemented"); }
  /** The next message for this agent, or null; held until its current turn has a result. */
  next(agentId: string): string | null { throw new Error("not implemented"); }
  push(agentId: string, text: string): void { throw new Error("not implemented"); }
}

// docker/arima-run.mjs (new, ~120 lines, no dependencies): baked into the agent image, and written into
// the agent's folder for sandbox mode. Args: HQ URL, agent id; the token comes from the environment.
```

State from events, no screen reading:

| Event | Status |
|---|---|
| `system/init` | idle, session id saved (so a restart can `--resume`) |
| message handed to claude | working |
| `assistant` with `tool_use` | working, note "Using <tool>" |
| `result` success | idle; tokens and cost recorded exactly |
| `result` error | idle, note with the error; the lead is told, as today |
| runner silent for 60 s while working | "Not responding" (same rule as a stalled terminal agent today) |

Clearing between tasks (`/clear` today) becomes: the runner restarts claude without `--resume`.

## What stays the same

Hooks (they fire in headless mode too), the Team MCP, the sandbox and proxy, briefs, gates, the inbox queue
and its persistence, usage events (now exact for these agents instead of read from log files).

## Rollout

1. Engine flag on the seat, off by default; a toggle in the agent's settings for Claude Code seats in sandbox or container mode.
2. Runner and endpoints, behind the flag.
3. Tests: a fake `claude` that prints recorded event lines, so the whole loop (pull, deliver, events, status,
   usage) runs in CI with no model; plus a test that a message is never delivered mid-turn.
4. One real run on a throwaway project before it's offered in the UI.

## Open questions for the owner

1. **Terminal view.** The runner prints a readable log (messages, tool calls, results), not Claude Code's
   full-screen UI. You can still watch the work, but you can't type into Claude directly. Messages go through
   chat. Acceptable?
2. **Permission prompts.** Headless mode can't show one. Sandbox and container agents already run with
   `--dangerously-skip-permissions`, so that's fine there. Local mode would need
   `--permission-prompt-tool` pointed at a Team MCP tool that files an Action item and waits for you, which is
   worth doing, but later, so Local stays on the terminal engine for now. Agree?
3. **Default.** Opt-in per agent at first. Make it the default for Claude Code in sandbox and container mode
   once it has run for a while?

## Risks

- The event schema is Claude Code's, not ours; the runner and `StreamEngine` ignore unknown events and fields,
  and the recorded-event test pins what we rely on. Confirm flags and event names against the installed
  version before building.
- Two engines to maintain for Claude Code until the terminal one can go. Worth it only if B's reliability
  shows up in practice; step 4 is where we find out.

## As built (2026-11-17)

Changes from the sketch, each for a reason found while building:

- **The runner is Python, not Node.** sbx's Claude sandbox has no Node; it and the agent image both have python3
  (standard library only). `server/streamRunner.ts` holds it and writes it to `.claude/arima-run.py`.
- **Delivery reuses the inbox.** Stream agents get their own `Keyboard` (the inbox's typing interface), so the
  inbox, its queue and its holds are unchanged; `StreamEngine.type()` queues, the runner long-polls
  `GET /agent/<id>/next?ack=<seq>`. An item stays until the next poll acknowledges it.
- **Usage isn't taken from events.** Headless Claude still writes its transcript, which the usage meter already
  reads; counting `result` too would double it.
- **Sandbox launch is `sbx create` once, then `sbx exec`**, because `sbx run` always starts the CLI's own UI.
  `exec` starts a stopped sandbox by itself (checked on a throwaway sandbox).
- **A `runner/started` event** marks the session up: Claude prints `system/init` only after its first message,
  so waiting for it (or for SessionStart) would deadlock the first delivery.
- **Resume is the runner's:** it keeps the session id in `.claude/arima-session`; a reset deletes it; a resume
  that exits within 15 s is dropped so a bad id can't loop.
- Screen reading (`reconcileFromScreen`, usage-limit watch) is skipped for stream agents: their screen is a log.

Checked: `scripts/stream-test.ts` (fake claude in the captured event shapes, real routes and runner), and one
real run of the runner with Claude Code 2.1.326 and Haiku on this machine: context kept across turns, kept
after a runner restart (resume), cleared by `/clear`, status idle → working → idle from events.
Not checked: a full start from HQ in Sandbox or Container mode, because this machine's sandbox network policy
and container egress rule aren't set up (both are security settings left to the owner).
