# Core model (Phase 1)

The data shapes every later phase builds on, designed once (ROADMAP rule 1). Status: **approved by the owner on 2026-11-12** (decisions in section 11). Built step by step per section 12.

## 1. What changes

| Today | After Phase 1 |
|---|---|
| Personas (`src/data/personas.ts`), persona domains, departments and pods, org presets, project types (`src/data/roles.ts`, `types.ts`) | **Deleted.** A project runs one **team template**: roles, a flow, a starter board, tool and scope rules, memory node types. |
| `WorkflowMode` (`github-pr` / `deliverables`) and `assertTaskCompletion` | A **flow** of stages, each with **gates**. `server/gates.ts` replaces `taskCompletion.ts`. Today's two modes become two flows. |
| `Finding` with severity, target, free-text evidence | One finding schema with CVSS 4.0, SSVC, ATT&CK, D3FEND, WSTG, CWE, asset, evidence list, verified flag. Six exports read it. |
| `planner.brief()` returns handoffs and facts | `buildBrief()`, one function, about 4k tokens, fixed sections. |
| Token totals per agent, in memory | `usage_events` table: every model run, with account, model, tokens and estimated cost. |
| `gh` polling inside `GitHubSync`, no one-shot model calls, no memory | Three interfaces: `GitHubEvents`, `ModelRunner`, `MemoryStore`. Phase 1 ships one implementation of each. |
| MIT only, no `ee/` | AGPL for new core files, `ee/` behind an Ed25519 licence check, a CLA on pull requests. |

Old projects (hq-home, ExposeCheck, Lab) have no template. They open **read-only** (section 9). No migration code is written.

## 2. Storage

Rule 2: new data gets real tables. They live in **one HQ database, `~/.arima/arima.db`**, next to the Phase 0 `docs` and `log` tables, and every project-scoped row carries `project_id`.

Why one database and not one per project: usage and spend are per account across projects (Stage E), the command center reads every project, and "forget project" (2.8) becomes `DELETE ... WHERE project_id = ?` in one transaction.

`server/lib/db.ts` (new) opens that database through the existing `dbFor` and runs numbered migrations from a `schema_version` table. Each migration is plain SQL in one array, applied in a transaction, never edited after release. Tables:

| Table | Holds | Section |
|---|---|---|
| `templates` | The library: built-in and saved templates (JSON body, version, who edited) | 3 |
| `projects_model` | Per project: its own copy of the template, the origin template id and version | 3 |
| `boards`, `tasks` | Boards and tasks of new projects, with `stage_id` | 4 |
| `gate_events` | Append-only gate evidence; the latest row per (task, gate) wins | 4 |
| `findings` | Findings (section 5) | 5 |
| `ledger` | Task and progress ledger entries | 7 |
| `usage_events` | One row per model run or meter delta | 6 |

Old projects keep reading `plan.json` and `findings.json` rows through `readDoc`, read-only.

## 3. Team template and role (1.1)

```ts
// src/data/model.ts: shared by server and UI
interface TeamTemplate {
  id: string;                 // "dev", "blank", or a slug for saved ones
  version: number;            // bumped on every save
  name: string;
  description: string;
  roles: Role[];
  flow: Flow;
  starter: { boards: Board[]; tasks: StarterTask[] };
  rules: ToolRules;
  memoryTypes: string[];      // node types beyond the core ontology: "Asset", "Finding", "Source"...
}

interface Role {
  id: string;                 // "lead", "developer", "reviewer", "red"...
  title: string;
  isLead: boolean;            // exactly one lead role per template (checked)
  roleMd: string;             // the role text (absorbs today's persona trait, style and voice)
  cli: AgentCli;
  model: string;
  fallback: { cli: AgentCli; model: string } | null;  // Codex overflow; always asks first (Phase 3)
  skills: string[];
  onDemand: boolean;          // started per task, stopped after (Phase 3); the lead is never on demand
  seats: number;              // agents of this role a new project starts with
  color: string;
}

interface ToolRules {
  findings: boolean;          // security work: findings tools and the findings report
  plans: boolean;             // agents submit a plan and wait for the owner before changing a system
  scopeRequired: boolean;     // red and purple: no start without a scope (or lab mode)
  labMode: boolean;           // CTFs and practice ranges; skips the scope requirement
  outbound: "none" | "drafts-only";   // marketing and sales: drafts only
  egress: string[];           // extra allowed hosts for container mode
}
```

- **An agent is a seat of a role.** `AgentConfig` loses `role`, `department`, `isLead`, `cli`, `model`, `skills` and `roleMd` and gains `roleId`. It keeps what belongs to the person in the seat: `id`, `name`, `color`, `mode`, `account`, `workspacePath`, `sandbox`, `mcp`. CLI, model, skills and role text come from the role, so changing a role changes every seat at its next start.
- **A project owns a copy.** Creating a project copies the template into `projects_model`. Later edits to the library don't touch running projects; a project can be re-synced on purpose.
- **Phase 1 ships two built-in templates as data:** `dev` (today's software team and the `github-pr` flow) and `blank` (one lead, the `deliverables` flow). The four launch templates are Phase 4 and only add data.
- **Who edits:** owner, and operators after the authenticator step-up. `saveTemplate`, `updateRole`, `updateFlow` join `RISKY_COMMANDS` in `server/remote.ts`; the role check stays on the server.
- **At load,** `config.json` holds only the seats. HQ fills in each seat's role title, CLI, model, skills and role text from the project's template copy (`resolveSeat`), in place, so the rest of HQ keeps reading `AgentConfig`. Role edits go through `updateRole` and reach every seat of the role at its next start.
- **The welcome screen** offers the built-in templates. Saved library templates join the picker with template import and export (Phase 4.4).
- **The office without departments:** the team panel groups agents by role. The office has one SOC room for security work (`rules.findings`), where all its workers sit. Rooms per flow stage are Phase 5.

## 4. Flow and gates (1.2)

```ts
interface Flow { stages: Stage[] }       // ordered
interface Stage {
  id: string;                 // "spec", "implement", "review"...
  name: string;
  roleIds: string[];          // who works tasks in this stage
  gates: Gate[];              // all must pass to leave the stage
}

type Gate = { id: string } & (
  | { kind: "pr-merged" }
  | { kind: "tests-ci" }                    // the PR adds or changes tests, and CI is green
  | { kind: "spec-approved" }
  | { kind: "analyze" }                     // every spec item maps to a task
  | { kind: "reviewer"; roleId?: string }   // someone other than the task's owner
  | { kind: "second-opinion"; when: "always" | "high-stakes" }
  | { kind: "owner-approval"; reason: "spec" | "merge" | "containment" | "outbound" }
  | { kind: "file-delivered" }
  | { kind: "findings-report" }
  | { kind: "scope-set" }
);

interface GateEvent {        // one row of gate_events
  projectId: string; taskId: string; gateId: string;
  state: "passed" | "failed" | "waived" | "reset";
  by: { kind: "agent" | "user" | "hq"; id: string };
  proof: { url?: string; path?: string; sha?: string; note?: string };
  at: string;
}
```

- `Task` gains `stageId`. `status` stays (todo, in-progress, in-review, done, blocked): stage says where the task is in the flow, status says what is happening inside the stage.
- `server/gates.ts` is pure: `gateProblem` says why one gate isn't met, `unmetGates` lists them for a set of stages, `assertGates` throws with all of them. It replaces `assertTaskCompletion`.
- **Moving and finishing.** A new task starts in the first stage. Moving it forward needs the gates of the stages it leaves; moving back is free. Finishing it needs the gates of its stage and every stage after, and puts it in the last stage. The planner enforces this for people, agents, GitHub sync and other projects' leads alike.
- **Observed gates.** HQ checks `pr-merged`, `file-delivered` and `scope-set` itself; nobody records evidence for them. The rest need a `gate_events` row: agents record theirs with the `record_gate` tool, people with the `recordGate` command. Only a person passes `owner-approval` and `spec-approved`, and only a person waives a gate. Nobody passes the review of their own task.
- `workflow.mode` stays, derived from the flow (a `pr-merged` gate means pull requests), because it still words the agents' instructions. The Phase 3 gate engine replaces it.
- **Not yet in the UI.** Gate states show to agents (`get_my_task` lists the gates a task still needs) but not in the browser; the flow canvas (Phase 5) shows and approves them. The built-in templates have no person-only gates, so nothing waits on that UI yet.
- Events are append-only, so a lead's approval (Phase 3) is undone by a `reset` row and the history stays.
- Phase 1 builds the check and the evidence store. Phase 3 builds the engine that collects evidence automatically for every gate kind.

## 5. Finding (1.3)

```ts
interface Finding {
  id: string;                         // "F-003", per project
  projectId: string; taskId: string | null; reporterId: string;
  title: string;
  asset: { kind: "url" | "host" | "ip" | "repo" | "cloud" | "app"; value: string };
  location: { file: string; startLine?: number; endLine?: number } | null;   // code findings (SARIF)
  cvss: { vector: string; score: number } | null;    // CVSS 4.0 only; score computed by HQ, never taken from the agent
  severity: Severity;                 // from the score when there is one, else set by hand
  ssvc: { exploitation: "none" | "poc" | "active"; automatable: boolean;
          technicalImpact: "partial" | "total"; decision: "track" | "track*" | "attend" | "act" } | null;
  cwe: string[];                      // "CWE-89"; HackerOne, Bugcrowd and SARIF need it
  attack: string[];                   // "T1190"
  d3fend: string[];                   // "D3-IAA"
  wstg: string | null;                // "WSTG-INPV-05"
  description: string; impact: string; remediation: string;
  evidence: { kind: "request" | "response" | "command" | "output" | "file" | "note"; content: string }[];
  verified: boolean; verifiedBy: string | null;
  status: FindingStatus;
  at: string; updatedAt: string;
}
```

- CWE and `impact` are additions to the roadmap list: the HackerOne and Bugcrowd forms and SARIF rules ask for them.
- **CVSS 4.0** (`server/cvss.ts`): HQ validates the vector and computes the score with FIRST's lookup tables from `ae-cvss-calculator` (Apache-2.0), so an agent can't claim a 10.0. The severity follows the score; only unscored findings take a severity by hand. The test pins seven vectors checked against FIRST's own calculator.
- **SSVC** stores the decision points and the decision as given. HQ checks the values but doesn't derive the decision from CISA's tree yet.
- **IDs** are checked by shape: `CWE-89`, `T1190` or `T1059.001`, `D3-IAA`, `WSTG-INPV-05`.
- **Scope** applies to network assets (url, host, ip). Code, cloud and app findings name things a scope doesn't list.
- **Exports** (`server/reports.ts`, `GET /api/projects/<id>/findings/export?format=…`): Markdown, JSON, SARIF 2.1.0, a printable HTML report (Save as PDF from the browser), HackerOne and Bugcrowd (each platform's fields in order, for pasting by hand; nothing is submitted, and unverified findings are flagged). False positives are left out of all but the Markdown appendix. `scripts/findings-test.ts` validates the SARIF export against the official OASIS 2.1.0 schema (kept in `scripts/fixtures/`) with ajv. The HTML report escapes agent text and is served with a no-script content policy.
- **Storage:** template projects keep findings in the `findings` table. Projects made before templates show their old `findings.json` row in today's shape, read-only.
- Redaction runs on evidence, description and impact before they are stored.

## 6. Usage events (1.6)

```ts
interface UsageEvent {
  at: string;
  projectId: string; taskId: string | null; agentId: string | null;
  source: "agent" | "helper" | "review";    // an agent's CLI session, an HQ one-shot, a second opinion
  account: string; provider: Provider; cli: AgentCli | null; model: string;
  tokens: Tokens;                           // input, cached, output
  costUsd: number | null;                   // null when the model has no price row
}
```

- `UsageMeter.readByModel` reads totals per model from the CLI logs (Claude Code logs the model per message; a Codex rollout names its model once). Only Claude Code and Codex logs are metered today.
- Every 30-second poll, `recordMeter` (`server/usageEvents.ts`) writes what grew since the last **mark** (`usage_marks`, per project, agent and model) as one event per model, tagged with the agent's current task. The mark always moves to the new totals, so logs that shrink restart the count instead of hiding new work. The first poll after an agent's logs appear records everything they already hold.
- `server/prices.ts`: Anthropic's prices as of 2026-11-03, with Claude Code's aliases (`opus`, `sonnet`…). Estimates only; the provider's bill is the truth. A model without a row (GPT, Gemini) gets `costUsd: null`, never a guess. Cache writes count at the plain input rate, and Haiku 5.5's long-prompt rate isn't applied.
- A task's usage is the sum of its events; tasks no longer store start and end snapshots. `spend()` sums tokens and cost by project or account for the Phase 3 caps. Nothing else keeps a token count.

## 7. Ledgers and memory (1.5, 1.7)

```ts
interface LedgerEntry {
  id: number; projectId: string; taskId: string | null;
  ledger: "task" | "progress";
  kind: "fact" | "guess" | "plan" | "stall" | "replan" | "note";
  text: string; by: string; at: string; supersededBy: number | null;
}
```

- The **task ledger** is the lead's (facts, guesses, plan). Team MCP gains `ledger_add` and `ledger_revise`, lead only.
- The **progress ledger** is HQ's: stall checks, nudges, replans. `planner.checkStalls` writes to it.
- Both go through `MemoryStore`, so Phase 2 moves them into Neo4j without touching callers.

## 8. Interfaces (1.7)

```ts
interface ModelRunner {          // every one-shot model call; always writes a usage event
  run(req: { account: string; model: string; system?: string; prompt: string; maxTokens: number;
             purpose: "helper" | "review"; projectId: string; taskId?: string }): Promise<{ text: string; tokens: Tokens }>;
}
// Implementations: CliRunner (claude -p, codex exec, gemini -p; the owner's sign-ins)
//                  ApiKeyRunner (vault key, provider HTTP API; customers)

interface GitHubEvents {         // PR snapshots, rate limits, errors
  watch(repo: string, on: (e: GitHubEvent) => void): { nudge(delayMs?: number): void; stop(): void };
}
// Implementation now: GhPolling (the paced `gh` poll). GitHubSync only listens. Phase 3 adds GitHubAppWebhooks.

interface MemoryStore {
  addLedger(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry;
  ledger(projectId: string, opts: { taskId?: string; ledger?: "task" | "progress" }): LedgerEntry[];
  forgetProject(projectId: string): void;
  // Phase 2 adds recall, related, remember and the graph.
}
// Implementation now: SqliteMemory. Phase 2: Neo4jMemory.
```

As built (`server/memory.ts`, `server/githubEvents.ts`, `server/modelRunner.ts`):

- `MemoryStore` also has `reviseLedger`: a revision is a new entry and the old one points at it. The lead's tools are `ledger_add` (fact, guess, plan, note), `ledger_revise` and `read_ledger`, all lead-only; stall entries are HQ's.
- `ModelRunner` is `MeteredRunner`, which records every run as a usage event and picks the way in by account: a CLI sign-in runs `claude -p` with no tools, no MCP servers and no saved session, in an empty folder; an Anthropic API-key account runs the Messages API through `@anthropic-ai/sdk`. OpenAI and Google keys, and non-Claude models on a CLI sign-in, are refused until a caller needs them. Nothing calls it yet: the first caller is memory extraction (Phase 2.4).

The brief (1.4) is one function over these:

```ts
function buildBrief(input: BriefInput, budget = 4000): { text: string; tokens: number; trimmed: string[] }
```

As built (`server/brief.ts`): sections in order are the task (title, description, files, done-when), the gates still before done and what each needs, the spec excerpt (empty until specs exist), handoffs (the agent's own last note and the notes of the tasks it builds on), the lead's ledger for this task and the project, memory (empty until Phase 2), repo facts, and skill names. Tokens are estimated at four characters each. Over budget it cuts older handoffs, then older ledger entries, then memory, older repo facts, the spec and finally the task description, and says what it left out; the title, files, done-when and gates always stay. `get_my_task` returns the brief's text.

## 9. Old projects, read-only

A project whose config has no `roleId` on its agents is a legacy project.

- The snapshot carries `readOnly: true`. The UI shows the board, findings, history and terminals, with a "Read-only (made before templates)" banner.
- The server refuses every command that changes it, except stop, archive, restore and delete. The check is one list next to `RISKY_COMMANDS`, so a new command is refused by default.
- `server/legacy.ts` maps an old project type to tool rules (security: findings and scope; ops: plans) and holds the list of commands a read-only project still takes. Old `config.json` files are saved back unchanged.

## 10. Open core (1.8)

- **`server/license.ts`:** verifies `~/.arima/license.json` (`{ payload, signature }`) with Ed25519 from `node:crypto` (no new dependency) against a public key in the source. The payload names the licensee, tier, seats, features and expiry. No network call.
- **`ee/`:** a stub feature registers through `registerFeature(name, setup)` in `server/features.ts`. `main.ts` loads `ee/` by dynamic import only if the folder exists; nothing in core imports it statically. The stub runs only with a valid licence that lists it.
- **`scripts/license-keygen.ts` and `scripts/license-sign.ts`:** the owner makes the key pair once and keeps the private key outside the repo.
- **Licences:** new core files start with `// SPDX-License-Identifier: AGPL-3.0-or-later`; existing MIT files keep MIT and its notices. `LICENSE` explains the split. `ee/LICENSE` is a commercial licence.
- **CLA:** a CLA text in `CLA.md` and the CLA Assistant GitHub App on the repo. The app runs without GitHub Actions, so the billing lock doesn't block it.

As built: `ee/index.ts` exports a plain map of features (`EeModule`), so no copy of core code ends up in it; `server/features.ts` loads `dist-server/ee.mjs` (built separately by `scripts/build-server.mjs`) or `ee/index.ts` from source, and starts each feature only when `readLicense()` is valid and lists it. `server/licenseKey.ts` holds the public key and is `null` until the owner runs `scripts/license-keygen.ts`, so no licence verifies before that. `LICENSE` sets out the split: AGPL for files with the SPDX header (`LICENSES/AGPL-3.0-or-later.txt`, fetched from gnu.org), MIT for the rest (`LICENSES/MIT.txt`), and `ee/LICENSE` (a draft) for `ee/`. `CLA.md` is a draft for legal review.

## 11. Owner's decisions (2026-11-12)

1. **Template copies.** A project keeps its own copy of its template. Editing the library never changes a running project; a re-sync is done on purpose.
2. **Old projects.** Read-only: no new starts, assignments or edits. Agents already running keep running until the owner stops them; stop, archive, restore and delete still work.
3. **Legal texts.** Claude drafts `CLA.md` (from the Harmony individual CLA template) and a placeholder commercial `ee/LICENSE`, both marked for the owner's legal check.
4. **PDF reports.** An HTML report with a print stylesheet, saved as PDF from the browser. No new dependency.
5. **CLA Assistant app.** The owner installs it on `sachindots/arimaops` once `CLA.md` is ready.

## 12. Work order

Each step is one commit on a branch and ends with `pnpm build` and `pnpm test` green. Steps 4 and 9 change the UI and get a tablet check in the browser pane (landscape and portrait).

| # | Step | Check |
|---|---|---|
| 1 | `server/lib/db.ts`: migrations and the tables of section 2 | `scripts/db-test.ts`: fresh and repeated migration, rollback on a bad migration |
| 2 | `src/data/model.ts`: every type above, plus `validateTemplate` | Bad templates rejected: no lead, two leads, unknown role in a stage, duplicate gate ids |
| 3 | Built-in `dev` and `blank` templates; template library and project copy on the server | A new project from `dev` starts its seats with the role's CLI and model |
| 4 | Delete personas, domains, departments, pods, presets and project types; agents become seats; legacy read-only; template picker in the welcome flow; office groups by role | `grep` finds none of the five; an old project opens read-only and refuses edits |
| 5 | Flow and gates: `server/gates.ts`, `gate_events`, tasks in tables with `stageId` | Every gate kind has a passing and a failing case; `taskCompletion.ts` is gone |
| 6 | Finding schema, CVSS 4.0 scoring, SSVC, exports | Known vectors give FIRST's scores; SARIF validates against the 2.1.0 schema |
| 7 | `usage_events`, `prices.ts`, the meter writes deltas | Two meter reads write one delta; unknown model gives `costUsd: null` |
| 8 | `ModelRunner`, `GitHubEvents`, `MemoryStore`; ledgers and lead tools | `GitHubSync` runs only through `GitHubEvents`; a non-lead's `ledger_add` is refused |
| 9 | `buildBrief` replaces `planner.brief` | A brief over budget trims in order and stays under 4,000 tokens |
| 10 | Licence check, `ee/` stub, SPDX headers, `LICENSE`, `CLA.md` | The stub runs with a valid licence and not with an expired or tampered one |
| 11 | Local demo of the whole phase and the roadmap's "done when" list with evidence | Owner approval before Phase 2 |
