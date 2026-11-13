# The factory loop (Phase 4 follow-up)

How HQ measures its own work and gets better at it: every task knows the template version it ran under, each project and template has cost and quality numbers, finished tasks are scored, repeated failures become proposed template changes, past tasks can be replayed on other models, and a UI change can't pass review without evidence that it works. Builds on Phase 1 (`docs/core-model.md`: templates, gates, usage events), Phase 3 (`docs/agent-engine.md`: gates, spend caps) and Phase 4 (`docs/templates.md`: templates, lesson promotion, benchmarks). Covers ROADMAP 4.6–4.11. Status: **design approved, 2026-11-13**; the owner's decisions are in section 8.

## 1. What changes

| Today (end of Phase 4) | After this follow-up |
|---|---|
| A task doesn't say which template version it ran under | Every new task records `template_id` and `template_version` |
| Cost and gate data sit in tables nobody adds up | Per project and template: cost per finished task or merged PR, cycle time, rework, stalls and replans, owner interventions; a Command center card |
| A task is done when its gates pass | It's also scored against its template's checks; scores are kept and shown |
| Lessons are the only feedback into a template | A failure that repeats becomes a proposed template change the owner approves |
| Benchmarks are fixed sample projects | Any finished task can join the suite and be replayed on other role models |
| A UI PR passes review on code alone | It needs screenshots of the app running, taken by a verifier |

## 2. Template version on every task (4.6)

- Migration: `tasks.template_id TEXT`, `tasks.template_version INTEGER`, both nullable (tasks made before this stay empty).
- `createTask` sets them from the project's copy (`projects_model.template_id`, `template_version`). A re-sync changes the version of tasks created afterwards only.
- Everything below groups and compares by `(template_id, template_version)`.
- Done when every new task records the version it ran under (test), and a re-sync shows two versions on one board.

## 3. Factory metrics (4.7)

Read-only queries over existing tables, no new state:

| Metric | From |
|---|---|
| Cost per finished task, per merged PR | `usage_events` (tokens always; dollars where priced) by `task_id`, joined to `tasks` (a done task with a `pr_number` is a merged PR in the Dev flow: its last stage is the `pr-merged` gate) |
| Cycle time (created → done; first in-progress → done) | task status history (see below) |
| Rework: failed gates per task | `gate_events` with `state = 'failed'` |
| Stalls and replans | `ledger` kinds `stall`, `replan` |
| Owner interventions | gate events by `user`, the owner's Action item answers, and the owner's messages to agents |

- Cycle time needs when a task changed status: today only `updated_at` is kept. New table `task_events (project_id, task_id, at, status, stage_id, by)`, one row per change (rule 2). Old tasks have no history: their cycle time is shown as unknown, not guessed.
- Owner interventions need the Action item answers in SQLite: they live in a JSON document today. The answers (id, kind, decision, at) get a small table; the items themselves stay where they are.
- API: `GET /api/metrics?project=…&template=…&since=…`, one function per metric in `server/metrics.ts`.
- UI: a Command center card per project (cost per finished task, cycle time, rework, interventions, against the previous 7 days) and a per-template view comparing versions.
- Done when the numbers on the demo project match a hand count (a test seeds known events and checks each metric exactly).

## 4. Scorers (4.8)

A template lists checks run on each finished task. Two kinds:

- **Rules** (free, exact), built in:
  - `files-outside-task`: the PR or deliverable touched files not in the task's `files` (when the task names files).
  - `tests-only-added`: a PR that changes tests but no code, or code but no tests (Dev).
  - `claim-without-citation`: a claims or report file with a claim line that has no `[S…]` (Research).
  - `unmarked-draft`: a draft without "DRAFT: not sent" (Marketing, Sales).
  - `finding-without-evidence`: a finding whose evidence is empty or only prose (Security).
- **Model checks** (Haiku through `modelRunner`, metered, count toward spend caps; they run when memory extraction is on, on its account, decision 1): a short rubric graded against the task's summary, its brief and its diff or deliverable. For example: "redundant tests", "skipped the assigned skill", "the summary claims something the diff doesn't show". Haiku's reply is parsed against a schema; the diff is data, not instructions.
- Each result goes to a `scores` table: task, template id and version, scorer id, pass or fail, a one-line reason, cost. Shown on the task and in the metrics.
- Scoring never blocks a task (gates do that); a failed score is a signal for section 5.
- Done when a seeded bad task fails its scorer and its cost shows in usage.

## 5. Improvement proposals (4.9)

- A nightly job, per template: failed scores and failed gates grouped by scorer or gate. When one fails **3 times within 30 days** (decision 2), Haiku drafts one change to the template: a role's model, a skill added, a gate added or tightened, a role instruction. The draft is checked by `templateErrors` and shown as a diff.
- Same masking as lesson promotion (`docs/templates.md` section 8): no project's hosts, names or paths in the text; off for security engagements unless the owner switched promotion on.
- An Action item of kind `proposal`: Approve saves the template with its version bumped (built-ins: saved as the owner's copy, `dev` → `dev-yours`); Reject keeps the pattern from being proposed again for 30 days. Projects pick the change up only on re-sync, as today.
- Done when a repeated seeded failure yields one proposal, and approving it bumps the template version.

## 6. Own-task benchmarks (4.10)

- "Add to benchmark suite" on a finished task (Dev and Research first): saves the task's brief, its base commit (the PR's base, or the repo commit when it started), its done-when and its scorers as a benchmark in `~/.arima-bench/suite/<id>.json`. Free.
- Replay: `pnpm bench task:<id> --run --models <role>=<cli>/<model>,…` in a throwaway HQ, as in Phase 4 section 9: a clone at the base commit, the template, the brief, the chosen models; paid, asked at a terminal per run (decision 3).
- Scored by the same scorers plus the task's gates; result in the bench results with cost. A chart per benchmark: cost against score per model, the evidence for Phase 3 routing (3.1).
- Done when one task replayed on two models gives a comparable cost and score pair.

## 7. Evidence gate (4.11)

- New gate kind `evidence` in the Dev template's Review stage, for PRs that change UI files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.html`, or the template's own list).
- A **verifier** role (on demand) checks out the PR, starts the app with the project's dev command, opens the changed pages with Playwright, and attaches screenshots (desktop and tablet width) or a short recording, with the steps it took.
- Where evidence lives (decision 4): HQ keeps it under `~/.arima/<project>/evidence/<task>/`, shown on the task and in the review; the PR gets a comment with the summary and a link.
- The gate passes when evidence exists for the PR's current head commit; a new push resets it.
- Playwright and its browser run in a verifier image, not in every agent's image (the agent image stays as it is).
- Done when a UI PR can't pass review without evidence (test), and a live demo shows the verifier's screenshots on the task.

## 8. Owner's decisions

Decided 2026-11-13:
1. **Model checks run with memory extraction:** one switch and one Haiku account for all of HQ's helper calls (extraction, lesson rewrites, model checks). Rule checks are free and always run.
2. **3 repeats within 30 days** make a proposal.
3. **Paid replays run only from the terminal**, as with benchmarks (`pnpm bench`, typing the id). Adding a task to the suite is a free button.
4. **Evidence stays in HQ**, under `~/.arima/<project>/evidence/`, shown on the task; the PR gets a summary comment with a link. No binaries in the repo.

## 9. Work order

1. This design and the owner's decisions.
2. Template version on tasks, task status history, Action item answers in SQLite (sections 2–3, data only).
3. Metrics: queries, API, Command center card (section 3).
4. Scorers: rules, model checks, `scores` table, UI (section 4).
5. Improvement proposals (section 5).
6. Own-task benchmarks and replays (section 6).
7. Evidence gate and the verifier (section 7).
8. Demo on a throwaway HQ, tablet check, evidence in HANDOFF.

Not checked locally without the owner's go-ahead: real model checks and proposal drafts (Haiku, paid), real replays (paid), and a verifier run against a real app with a real model.
