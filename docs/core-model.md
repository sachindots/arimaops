# Core model (Phase 1)

The data shapes every later phase builds on, designed once (ROADMAP rule 1). Status: **approved by the owner on 2026-11-12** (decisions in section 11). Built step by step per section 12.

## 1. What changes

| Today | After Phase 1 |
|---|---|
| Personas (`src/data/personas.ts`), persona domains, departments and pods, org presets, project types (`src/data/roles.ts`, `types.ts`) | **Deleted.** A project runs one **team template**: roles, a flow, a starter board, tool and scope rules, memory node types. |
| `WorkflowMode` (`github-pr` / `deliverables`) and `assertTaskCompletion` | A **flow** of stages, each with **gates**. `checkGates` replaces `taskCompletion.ts`. Today's two modes become two flows. |
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
- **The office without departments:** desks group by role instead (`layout.ts` keys on `roleId`). Carpets take the role's colour. Rooms per flow stage are Phase 5.

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
- `checkGates(task, stage, events): UnmetGate[]` is pure and replaces `assertTaskCompletion`. A task moves to the next stage, or to done after the last one, only when the list is empty. The server records evidence it can see itself (PR merged, CI green, file exists) as `by: hq`; people and agents record the rest.
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
- The CVSS 4.0 score needs FIRST's lookup tables. HQ validates the vector and computes the score itself, so an agent can't claim a 10.0.
- Exports in `server/reports/`: Markdown, JSON, SARIF 2.1.0, HackerOne and Bugcrowd (Markdown in each platform's field order, for pasting by hand; nothing is submitted), and PDF (section 11, question 4).
- Redaction runs on evidence before it is stored, as it does for terminal output today.

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

- `UsageMeter` already reads totals from the CLI logs. It records the **delta** since its last read as one event, per model (Claude Code logs carry the model per message).
- `server/prices.ts`: one price table per provider and model, dated. Estimates only; the provider's bill is the truth.
- Stage E (spend caps, Phase 3.7) sums this table. Nothing else keeps a token count.

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

interface GitHubEvents {         // PR opened, review, checks, merged, comments
  watch(projectId: string, repo: string, on: (e: GitHubEvent) => void): () => void;
}
// Implementation now: GhPolling (today's GitHubSync loop). Phase 3 adds GitHubAppWebhooks.

interface MemoryStore {
  addLedger(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry;
  ledger(projectId: string, opts: { taskId?: string; ledger?: "task" | "progress" }): LedgerEntry[];
  forgetProject(projectId: string): void;
  // Phase 2 adds recall, related, remember and the graph.
}
// Implementation now: SqliteMemory. Phase 2: Neo4jMemory.
```

The brief (1.4) is one function over these:

```ts
function buildBrief(input: BriefInput, budget = 4000): { text: string; tokens: number; trimmed: string[] }
```

Sections in order, each with a share of the budget: task (title, description, files, done-when), spec excerpt, handoffs, task-ledger excerpt, memory (empty until Phase 2), skill names, gates of the task's stage. Tokens are estimated at four characters each. When over budget it trims handoffs, then the ledger, then the spec, and names what it cut so the agent knows to call `recall`.

## 9. Old projects, read-only

A project whose config has no `roleId` on its agents is a legacy project.

- The snapshot carries `readOnly: true`. The UI shows the board, findings, history and terminals, with a "Read-only (made before templates)" banner.
- The server refuses every command that changes it, except stop, archive, restore and delete. The check is one list next to `RISKY_COMMANDS`, so a new command is refused by default.
- Legacy types are kept only in `server/legacy.ts`, the one module that reads old `config.json` and `plan.json`.

## 10. Open core (1.8)

- **`server/license.ts`:** verifies `~/.arima/license.json` (`{ payload, signature }`) with Ed25519 from `node:crypto` (no new dependency) against a public key in the source. The payload names the licensee, tier, seats, features and expiry. No network call.
- **`ee/`:** a stub feature registers through `registerFeature(name, setup)` in `server/features.ts`. `main.ts` loads `ee/` by dynamic import only if the folder exists; nothing in core imports it statically. The stub runs only with a valid licence that lists it.
- **`scripts/license-keygen.ts` and `scripts/license-sign.ts`:** the owner makes the key pair once and keeps the private key outside the repo.
- **Licences:** new core files start with `// SPDX-License-Identifier: AGPL-3.0-or-later`; existing MIT files keep MIT and the JSM HQ notice. `LICENSE` explains the split. `ee/LICENSE` is a commercial licence.
- **CLA:** a CLA text in `CLA.md` and the CLA Assistant GitHub App on the repo. The app runs without GitHub Actions, so the billing lock doesn't block it.

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
| 5 | Flow and gates: `checkGates`, `gate_events`, tasks in tables with `stageId` | Every gate kind has a passing and a failing case; `taskCompletion.ts` is gone |
| 6 | Finding schema, CVSS 4.0 scoring, SSVC, exports | Known vectors give FIRST's scores; SARIF validates against the 2.1.0 schema |
| 7 | `usage_events`, `prices.ts`, the meter writes deltas | Two meter reads write one delta; unknown model gives `costUsd: null` |
| 8 | `ModelRunner`, `GitHubEvents`, `MemoryStore`; ledgers and lead tools | `GitHubSync` runs only through `GitHubEvents`; a non-lead's `ledger_add` is refused |
| 9 | `buildBrief` replaces `planner.brief` | A brief over budget trims in order and stays under 4,000 tokens |
| 10 | Licence check, `ee/` stub, SPDX headers, `LICENSE`, `CLA.md` | The stub runs with a valid licence and not with an expired or tampered one |
| 11 | Local demo of the whole phase and the roadmap's "done when" list with evidence | Owner approval before Phase 2 |
