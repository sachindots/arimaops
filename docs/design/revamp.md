# Server revamp: security and subtraction

Status: units 1, 2, 4 and 5 implemented (2026-11-17). Unit 3 (memory) waits for the owner's decision on backups.
Audience: solo developers and small teams (decided 2026-11-17). Not multi-tenant, not enterprise.

Five units, each one small enough to ship and test alone. Order: 2, 4 and 5 first (they close
holes, a few lines each), then 1 (command table), then 3 (memory), which is the largest.

---

## Unit 1: one typed command table

### Usage first

```ts
// server/commands.ts: every entry declares who may run it and what it takes. Missing either fails to compile.
const commands = defineCommands({
  startAgent: cmd({ role: "operator" }, [z.string().max(80)], (agentId) => sessions.start(agentId)),
  sendMessage: cmd({ role: "viewer" }, [z.string().max(80), z.string().max(2000)], (to, text) => planner.message("you", to, text)),
  openHostShell: cmd({ role: "owner", stepUp: true }, [z.string().max(4096), z.boolean().optional()], (dir, fresh) => sessions.openHostShell(dir, fresh === true)),
  updateAgent: cmd(
    { role: "operator", stepUp: true, ownerIf: ([, p]) => p.workspacePath !== undefined || p.mode === "local" },
    [z.string().max(80), agentPatch],
    (id, p) => { /* as today, minus the str()/num() casts */ },
  ),
  sendTerminalInput: cmd(
    { role: "operator", stepUp: true, ownerIf: ([id]) => hub.cfg(id)?.mode === "local" }, // a local agent's terminal is a host shell
    [z.string().max(80), z.string().max(100_000)],
    (id, data) => sessions.input(id, data),
  ),
});

// server/http.ts, WebSocket dispatch: one call instead of three sets and two special cases.
const verdict = commands.authorize(cmd, args, { role, remote, elevated });
//    ^ { ok: true, run } | { ok: false, why: "unknown" | "bad-args" | "role" | "step-up" }
```

### Types

```ts
// server/commandTable.ts (new, ~60 lines)
export type Role = "viewer" | "operator" | "owner";

export interface Policy<A extends unknown[]> {
  role: Role;                         // the lowest role that may run it
  stepUp?: boolean;                   // a remote device needs a fresh authenticator code
  ownerIf?: (args: A) => boolean;     // arguments that raise it to owner-only
}

export interface Command<A extends unknown[]> {
  policy: Policy<A>;
  args: z.ZodTuple;                   // validated before the handler runs; extra items are rejected
  run: (...args: A) => unknown;
}

export function cmd<S extends [z.ZodType, ...z.ZodType[]] | []>(
  policy: Policy<{ [K in keyof S]: z.infer<S[K]> }>,
  args: S,
  run: (...args: { [K in keyof S]: z.infer<S[K]> }) => unknown,
): Command<{ [K in keyof S]: z.infer<S[K]> }> { throw new Error("not implemented"); }

export type Verdict =
  | { ok: true; run: () => Promise<unknown> }
  | { ok: false; why: "unknown" | "bad-args" | "role" | "step-up" };

export interface CommandTable {
  authorize(name: string, args: unknown[], who: { role: Role; remote: boolean; elevated: boolean }): Verdict;
  names(): string[];                  // for the UI's step-up labels and tests
}

export function defineCommands(entries: Record<string, Command<any>>): CommandTable { throw new Error("not implemented"); }
```

### What goes away

- `OWNER_COMMANDS`, `VIEWER_COMMANDS` (http.ts) and `RISKY_COMMANDS` (remote.ts): replaced by `policy`.
- The `updateAgent` / `updateProject` special cases added in http.ts: become `ownerIf`.
- `str()` / `num()` casts inside handlers: zod does them at the boundary.
- The read-only wrapper for old projects keeps working: it wraps `run`, not the table.

### Rules

- Object arguments get a real schema where a handler reads fields (`agentPatch`, `workflowPatch`).
  Large inputs that already have their own validator (templates, the welcome form) take
  `z.record(z.string(), z.unknown())` and keep that validator; we don't write them twice.
- A command that isn't in the table is refused and audited, like today.
- Test: one table-driven test walks every command name × role and checks the verdict. A new
  command without a policy can't compile, and one with the wrong role fails that test.

---

## Unit 2: file sync that never follows a symlink

The bug: `copyRelFile` (server/workspace.ts) checks only the last part of a path, and copies
onto whatever is at the destination. An agent controls its own clone, so it can:
- put a symlinked folder in its clone, so HQ reads a host file (`~/.ssh/...`) into the repo;
- put a symlink where another agent's deliverable will land, so HQ writes that file anywhere on the host.

```ts
// server/workspace.ts: both sides go through the existing agentPath() check (server/lib/agentFs.ts).
function copyInside(srcRoot: string, dstRoot: string, rel: string): boolean {
  // agentPath(srcRoot, rel) and agentPath(dstRoot, rel): throws on a symlinked folder on the way
  // src must be a plain file (lstat, not a symlink)
  // dst: a symlink in its place is removed, never followed (same rule as agentWrite)
  throw new Error("not implemented");
}
```

Used by `syncDeliverablesFromAgent` and `syncRepoToWorkspace`. `copyRelFile` is deleted.
Test: in `scripts/workspace-test.ts`, a symlinked folder in the source and a symlinked file at the
destination are both refused, and the file they point at is unchanged.

---

## Unit 3: memory in SQLite, no Neo4j

### Usage stays the same

Callers keep calling `memoryStore()` and the `MemoryStore` methods. Only the class behind it changes.

### Tables (in hqDb(), one migration)

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,                 -- "M-<n>", from the existing memory_ids sequence
  project_id TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL,
  task_id TEXT, source TEXT NOT NULL, by TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT NOT NULL,
  certified_by TEXT, superseded_by TEXT
);
CREATE TABLE memory_about (memory_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (memory_id, path));
CREATE INDEX memory_about_path ON memory_about (path);
CREATE VIRTUAL TABLE memory_text USING fts5 (text, content='memories', content_rowid='rowid');
```

### Graph queries without a graph database

- `recall(q)`: `memory_text MATCH 'w1 OR w2 …'` (the same word filter as today, so no FTS syntax
  reaches the index), ranked by bm25, then `last_used_at`.
- `related({ taskId | path | memoryId }, depth)`:
  - depth 1: memories with that task, or about that path, or sharing a task/path with that memory.
  - depth 2: the same again from those results. Two plain `IN (…)` queries, not a recursive CTE.

### Class

```ts
// server/memory.ts shrinks from 675 lines to about 250.
export class SqliteMemory implements MemoryStore {
  constructor(db: DatabaseSync, project: { templateTypes?: (projectId: string) => string[] }) {}
  // MemoryStore: addLedger, reviseLedger, ledger, forgetProject, remember, recall, related,
  //              summarise, summary, keepOut, certify, reject   (ledger and summaries are already SQLite)
  // also used today: certifiedAbout, unextracted, extracted, memories, merge, fade, memoryProjects,
  //                  keptOut, onRemember
  // removed: status, flush, connected, reload, close, the outbox and its retry loop
}
```

### Moving existing memories (no Neo4j driver needed)

On first start after the upgrade, for each project:
1. Read its newest nightly backup (`~/.arima/backups/memory/<project>/<day>.jsonl.gz`) with the
   existing pure `parseBackup()`, and insert its Memory nodes and ABOUT/task edges.
2. Replay `memory_outbox` rows newer than that backup (writes Neo4j never received).
3. Mark the project migrated, then drop `memory_outbox` once every project is done.

### What goes away

`neo4j-driver`, the `neo4j` service in compose.yaml, `memoryBackup.ts` export/import over Bolt,
the Neo4j URL/user/password settings and their UI, `MemoryStatus` "offline"/"unconfigured".
Memory works for every user with no setup.

### Open question for the owner

Per-project memory restore (`restoreMemory(date)` in Settings) depends on the Neo4j backups.
Proposal: replace it with one nightly `VACUUM INTO ~/.arima/backups/arima-<day>.db` (keep 7),
which backs up all HQ state, not just memory. Restore becomes "stop HQ, copy the file back".
Per-project restore is lost.

---

## Unit 4: an operator can't reach the host

- `updateAgent` with `mode: "local"` or `workspacePath` → owner only (`ownerIf`, unit 1).
- `sendTerminalInput` / `openShell` on an agent in local mode → owner only.
- `POST /api/projects/register` and `/create` (http.ts) → owner only. Registering a folder starts
  agents in it, the same power as `workspacePath`.
- Test: in `scripts/users-test.ts`, an operator is refused each of these.

Before unit 1 lands, these go in as two lines in http.ts, next to the two special cases already there.

---

## Unit 5: container egress lock is required

`containerReady` (server/setup.ts:423) treats the lock check's "warning" as ready, so containers
can skip the proxy and reach any site. The error text already says the rule is required.
Change: require `lock.status === "ok"`. One line. The setup checklist already shows the fix command.

---

## Synthesis decision

**Implementation deviation, unit 1 (accepted while building it, 2026-11-17):** policies and schemas
live in a static table, `server/commandPolicy.ts` (`COMMANDS`, `authorize()`), and `server/commands.ts`
types its handlers as `Handlers`, derived from that table. In the sketch, each policy sat inside
`makeCommands()`, so tests that use fake handlers would have checked fake policies.
Kept from the sketch: a command can't exist without a policy (both directions are compile errors),
handlers get typed arguments, and one table test (`scripts/command-policy-test.ts`) pins the role of
every command. `ownerIf` takes a small `PolicyContext` (an agent's mode) instead of the hub.
Handler bodies keep their own trimming for now; removing the `str()`/`num()` casts is a later cleanup.

**Command table, two shapes considered:**
- A: a policy table in its own file, next to the unchanged handlers in commands.ts.
  Smallest diff, but the policy and the handler can drift apart, and handlers still get `unknown`.
- B (chosen): `cmd(policy, schema, handler)` on each entry. Typed handler arguments, no casts, and
  a command can't exist without a policy. It touches every entry, but entry by entry, with the
  test catching any miss.

**Memory, two shapes considered:**
- A: keep Neo4j optional and add SQLite as a fallback. Two stores to keep in step: rejected.
- B (chosen): SQLite only, the same interface, migration from the files that already exist.

**Not in this revamp** (deferred, see the product direction): project-scoped roles, SIEM audit
export, a layered rewrite of server/, splitting planner.ts, headless stream-json agents,
per-agent proxy credentials, secrets out of `--env-file`.
