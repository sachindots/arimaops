# Agent engine (Phase 3)

How HQ runs the team: who gets a task, when a worker starts and stops, what the lead may decide alone, how every gate is checked, and what stops a runaway agent. Builds on the Phase 1 model (`docs/core-model.md`: roles, flows, gates, usage events) and the Phase 2 memory (`docs/memory-core.md`: ledgers, briefs). Status: **design, 2026-11-13**; the owner's decisions are in section 11.

## 1. What changes

| Today (end of Phase 2) | After Phase 3 |
|---|---|
| Every seat is a long-running session; the owner starts and stops them | Only the lead stays on. A worker starts when it gets a task and stops when it has none |
| The lead assigns to a named agent | The lead can assign to a **role**; HQ picks the seat (free, not limited, fitting the stage) |
| HQ types every message into an idle agent's terminal | HQ types only the lead's and the owner's messages; the rest wait for the agent's Stop hook or its next start |
| The lead takes over a question after 30 min unanswered | The lead may pass **reversible** gates once the owner has been away 2 h; each one is logged and undoable |
| Stall checks nudge and tell the lead | The second stall on a task asks the lead to **replan** it, in the progress ledger |
| Only `pr-merged`, `file-delivered` and `scope-set` are seen by HQ | Every gate kind has a checker: CI and tests, analyze, second opinion, findings report |
| A security template's scope is only a gate | No non-lead seat starts in a scope-required project without a scope (lab mode lifts it) |
| GitHub news comes from the `gh` poll | A GitHub App's webhooks, with the poll as fallback; stacked PRs |
| A usage limit stops the agent until it resets | HQ asks the owner to move the task to the role's fallback (Codex) |
| Spend is recorded, never acted on | Caps per project per day and month: alert at 80%, pause at 100% |

## 2. Routing by role (3.1)

- Templates already carry `cli` and `model` per role (Phase 1): the dev template's lead is Claude Opus, developers Claude Sonnet, reviewer Codex. Phase 4's research template adds Gemini (Antigravity, `agy`) roles. Phase 3 changes no template data; it changes **who picks the seat**.
- `assign_task` (MCP) and `assign` (browser) accept a role id as well as an agent id. With a role, HQ picks a seat of that role in this order: idle and running → stopped (on demand, will start) → busy with the fewest tasks waiting. Seats limited by their account (`limitedUntil`) are skipped. No seat of that role → the call fails and says which roles the stage takes.
- A task's stage limits who may take it: `stage.roleIds`. Assigning outside them fails, for agents and people alike (people can move the task to another stage first).
- Done when: a test assigns to a role with one limited, one busy and one stopped seat and gets the stopped one; assigning a review-stage task to a developer fails.

## 3. On-demand workers (3.2)

- **Start:** when a stopped on-demand seat gets a task it can begin (assigned, or the task it waited on is done), HQ starts it. The assign message waits in its inbox and is typed at the new session's first prompt (SessionStart), the same path every queued message already takes, so no CLI needs a launch-prompt flag.
- **Stop:** when a worker HQ started has no open task and sits idle for a **2 min grace** (a quick follow-up reuses it), HQ stops its session. The workspace folder stays; only the CLI process ends. Its last handoff note and the memory carry the context to the next start; no CLI session is resumed.
- **Only HQ's own starts are stopped.** A seat the owner started by hand, or one found running after an HQ restart, is never stopped by HQ (`server/onDemand.ts` keeps the set of seats it started).
- **Messages:** an on-demand worker's idle prompt gets typed messages only from the lead, the owner and HQ. Messages from other agents wait for its Stop hook (Claude Code), or go in with the next typed delivery or its first prompt after a start, in their order. The lead and always-on seats get everything typed, as before. Codex and agy have no Stop hook: their peer messages wait for the next typed delivery.
- **Never on demand:** the lead (checked since Phase 1).
- **Parallel workers:** no limit per project (owner's choice). The existing RAM cap (`maxAgents`) is the backstop: an on-demand start over the cap waits in a queue (first come, first started) with a note on the seat, and starts when a slot frees. Starts by hand over the cap still fail with the message they have today.
- Done when: an idle project (no open tasks) has exactly one session, the lead's; assigning starts a worker; finishing stops it after the grace.

## 4. The lead plans and decides (3.3)

- **Plans only:** the lead's role text already says it doesn't write code. Phase 3 enforces the useful half: `claim_task` refuses the lead in stages whose `roleIds` don't include `lead`, so it can't take a build task itself.
- **Replan after 2 stalls:** `checkStalls` already writes a `stall` entry to the progress ledger. On the second stall entry for the same task, HQ writes a `replan` entry and tells the lead: "T-12 stalled twice (…). Replan it: split, reassign, or drop it, and record the new plan with ledger_add kind plan." The lead's answer is its ledger entry; a third stall pushes the owner.
- **Owner away:** the owner is away when HQ has seen **no owner action for 2 h** (decision 3): a command from any of the owner's devices, a page load or the phone app opening. Operators don't count. While away, the lead may pass the gates that can be undone:
  - may pass: `spec-approved`, `owner-approval` with reason `spec`, and drafts (Phase 4's `outbound: "drafts-only"` gates for the draft itself, never the send);
  - always waits for the owner: `owner-approval` with reason `merge`, `containment` or `outbound`, and every waiver.
  - The lead passes them with `record_gate` as today; the gate check accepts the lead only while the owner is away and only for those kinds.
- **Logged and undoable:** each lead approval is a `gate_events` row `by: {kind: "agent", id: lead}` with `proof.note: "owner away"`, and an Action item "Lead approved the spec for T-12 while you were away" with **Keep** and **Undo**. Undo writes a `reset` row (history stays), moves the task back to the stage it left, and tells the lead and the task's owner. The 30-min "answer the user's questions" handover stays, also limited to reversible questions.
- Done when: a test with the owner away 2 h lets the lead pass a spec gate and refuses a containment gate; Undo puts the task back and leaves both rows in `gate_events`.

## 5. Gate engine (3.4)

Each gate kind gets a checker. "Observed" means HQ decides from what it can see; nobody records evidence.

| Gate | How it is met | Observed |
|---|---|---|
| `pr-merged` | The task's PR is merged (today). | yes |
| `tests-ci` | The task's PR changes a test file (path matches the project's test patterns, default `test`, `tests`, `__tests__`, `*.test.*`, `*.spec.*`, `*_test.*`) **and** every required check on its head commit passed. The GitHub query gains `files(first: 100)`. | yes |
| `spec-approved` | A person (or the lead while the owner is away, section 4) passes it. | no |
| `analyze` | The board's spec has numbered items (`S1`, `S2`…) and every item is named by at least one task's `specItems`. HQ lists the uncovered ones. | yes |
| `reviewer` | Someone other than the owner accepts (today). | no |
| `second-opinion` | An agent on a **different provider** from the task's owner records a pass with a note (default Gemini through `agy`). `when: "high-stakes"` applies only to high-stakes tasks (below); other tasks pass it without one. | no |
| `owner-approval` | A person passes it; the lead only for `spec` while the owner is away. | no |
| `file-delivered` | The deliverable file exists (today). | yes |
| `findings-report` | The project's findings report has been generated after the task's last finding. | yes |
| `scope-set` | The project's scope has at least one in-scope entry (today). | yes |

- **Specs:** a spec is a markdown document per board, stored in the HQ database (`specs` table: board, text, items, version), written by the lead with a new `write_spec` MCP tool and shown in the brief's spec section (Phase 1 left that section empty). Items are the lines that start with `S<n>.`. Tasks gain `specItems: string[]`, set by the lead when it makes the task. A new spec version resets `spec-approved` for that board's tasks.
- **High-stakes:** a task is high-stakes when the lead marks it (`highStakes: true`), or when its files match the project's sensitive patterns (default: `auth`, `login`, `session`, `crypto`, `secret`, `token`, `password`, `payment`, `billing`, `migration`, `.github/workflows`).
- **Scope before start:** in a project whose template has `scopeRequired` and not `labMode`, `Sessions.start` refuses every seat except the lead until the scope has an in-scope entry: "Set the engagement scope first (Scope panel), or turn on lab mode for a CTF or practice range." Lab mode is a project setting the owner switches (owner only, with step-up from a remote device), shown as a banner while on.
- Done when: one test per gate kind (met and not met), and an unscoped Red seat can't start while the lead can.

## 6. GitHub App and webhooks (3.5)

- **The App:** HQ creates it with GitHub's **manifest flow**: Settings → GitHub → "Create GitHub App" opens GitHub with the permissions filled in (pull requests, checks, contents read; webhooks for `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `push`). The owner clicks Create on GitHub; GitHub hands HQ the App id, private key and webhook secret, which go to the vault. The owner installs it on the repo. HQ never sees the owner's GitHub password.
- **Delivery:** GitHub needs a public HTTPS URL. HQ is on the tailnet only, so (decision 2) the webhook path alone is published with **Tailscale Funnel**: `https://<host>.ts.net/api/github/webhook`, nothing else of HQ is public. HQ checks every delivery's HMAC signature (`X-Hub-Signature-256`) against the secret and drops anything else, and deduplicates by delivery id.
- **`GitHubAppWebhooks`** implements `GitHubEvents`: a webhook is a hint that triggers one fetch of that PR (with the App's token, its own rate budget), so the snapshot stays the one source of truth. When no webhook has arrived for 10 min while PRs are open, or the Funnel is off, `GhPolling` takes over at its normal pace; webhooks resume it at a slow pace (5 min) as a safety net.
- **Stacked PRs (decision 4):** a task that `needs` another task whose PR isn't merged may start on top of that branch (`base` = the parent's branch) instead of waiting. When the parent merges, HQ tells the child's owner to rebase onto `main` (`git rebase --onto main <parent-branch>`) and retarget the PR (`gh pr edit --base main`). Plain git and `gh`, no stacking tool.
- Done when: a recorded webhook delivery updates the office within seconds (test with a signed fixture; live check needs the real App); a bad signature is dropped; a stacked child task gets the rebase message when its parent merges.

## 7. Codex overflow, ask first (3.6)

- When a seat hits its CLI's usage limit (`detectLimit`) and its role has a `fallback`, HQ files an Action item: "Arul hit the Claude limit until 15:00 on T-12. Continue it on Codex (gpt-6.1-sol) now?" with **Move to Codex** and **Wait**.
- Move: HQ stops the seat, starts it with the fallback CLI and model for this task only (the role is unchanged), with the handoff "You're taking over T-12 from a Claude session; read get_my_task and the branch's last commits." When the task is done, the seat's next start uses the role's own CLI again.
- Never automatic, even with the owner away. No fallback in the role → only the limit notice, as today.
- Done when: a simulated limit screen files the item; Move restarts the seat on the fallback; Wait changes nothing.

## 8. Spend caps (3.7)

- Per project: **$5 a day and $50 a month** by default, editable per project (owner only). Days and months are local time.
- Counted from `usage_events.cost_usd` (`spend()`), on API-key accounts only (decision 1). Unpriced models (GPT, Gemini) count 0 and the panel says so.
- **80%:** one alert (push and Action item) per period.
- **100%:** the project is **paused**: HQ stops its workers' sessions, refuses new starts and model runs (extraction, second opinions) for it, and tells the lead it is paused. The lead stays up but idle. An Action item offers **Raise the cap** and **Resume tomorrow**. The pause lifts itself when the period rolls over.
- Checked on every usage poll (30 s), so a runaway agent stops within about a minute of crossing the cap; a test drives fake usage events past the cap and sees the pause.
- Customers use API keys only (launch requirement): their usage is exact. The owner's subscription sign-ins have no bill; their estimated cost shows either way.

## 9. API-key containers (3.8)

- API-key accounts already start in Local and Container mode (Stage E). Phase 3 adds: switching a **running team to Container mode** in one action (each seat restarts in a container at its next start, not mid-task); an Antigravity sign-in volume (`hq-auth-agy`) like Claude's and Codex's.
- Done when an API-key-only agent starts on EC2: **needs the server**, so it waits for the owner's go-ahead on AWS (roadmap rule 7). Locally: an API-key-only agent starts in a container on the laptop.

## 10. Alerts always on (3.9)

- There are no quiet hours today and none are added. Phase 3's new alerts (stall replans, lead approvals, overflow, caps) go through the same push and ntfy paths, with urgent ones (cap pause, third stall) at high priority.

## 11. Owner's decisions (2026-11-13)

1. **Spend caps count API-key accounts only.** Subscription sign-ins have no bill and their own limits; their estimated cost still shows.
2. **Webhooks arrive through Tailscale Funnel**, on the one webhook path; polling stays the fallback.
3. **The owner is away after 2 h with no owner action.** Every lead approval is logged and undoable.
4. **Stacked PRs use plain git and `gh`**, no new dependency.

## 12. Work order

1. This design and the owner's decisions.
2. Routing by role (section 2).
3. On-demand workers and message typing (section 3).
4. Lead: owner-away approvals with undo, replan after 2 stalls (section 4).
5. Gate engine: checkers, specs and analyze, high-stakes, scope before start (section 5).
6. Spend caps (section 8).
7. Codex overflow and alerts (sections 7, 10).
8. GitHub App, webhooks with fallback, stacked PRs (section 6).
9. Container switch and agy volume (section 9).
10. Demo on a throwaway HQ, tablet check, evidence in HANDOFF.

Not checked locally, by design: webhooks from the real GitHub App (needs the App and the Funnel), the EC2 start (rule 7), and real Opus, Sonnet and Gemini runs (paid; asked before each one).
