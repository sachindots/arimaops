# Memory core (Phase 2)

What the team remembers across tasks, and how it is kept, searched, certified and forgotten. Builds on the Phase 1 `MemoryStore` and `ModelRunner` interfaces (`docs/core-model.md` section 8). Status: **owner's decisions taken 2026-11-12** (section 10); the `neo4j-driver` dependency waits for approval.

## 1. What changes

| Today (Phase 1) | After Phase 2 |
|---|---|
| `MemoryStore` = `SqliteMemory`: the task and progress ledgers only | `MemoryStore` gains `recall`, `related`, `remember`, `certify`, `summaries`; a Neo4j graph behind it |
| The brief's memory section is empty | It holds the top memories for the task (about 1–2k tokens), certified first |
| A finished task leaves a handoff note | It also leaves a **task summary**, and Haiku extracts memories from it |
| `ModelRunner` has no caller | Extraction and consolidation are its first callers, metered as `helper` usage events |
| `forgetProject` deletes ledger rows | It deletes the project's graph, summaries, findings, logs and backups, and writes a deletion record |

## 2. Neo4j (2.1)

- **Neo4j Community**, run by the user, not by HQ (decision 1): the compose file gains a `neo4j` service (official image, pinned version) for Docker installs; npm installs point HQ at their own Neo4j in Settings → Memory (Bolt URL, user; the password goes in the vault). HQ never starts, stops or upgrades Neo4j. One database (`neo4j`); every node carries `projectId`, like the SQLite tables. Bolt and the HTTP port bind to `127.0.0.1` only; auth on, with compose, `ARIMA_NEO4J_PASSWORD` in `.env` sets both Neo4j's password and HQ's connection (`ARIMA_NEO4J_URL`), and Settings → Memory shows them read-only; on npm installs the password typed in Settings → Memory goes to the vault (`memory:neo4j`), never to a file the agents can read. **One Neo4j per HQ:** ledger ids come from the HQ database, so two HQs must not share a Neo4j.
- **Driver:** `neo4j-driver` (Apache-2.0). New dependency, needs the owner's OK.
- **Licence:** Community is GPLv3 (to confirm against the image's `LICENSE.txt` before release). HQ talks to it over Bolt as a separate program, and we ship only a compose entry that pulls Neo4j's own image, so the GPL doesn't reach ArimaOps' AGPL core or the commercial `ee/`. We don't bundle or modify Neo4j.
- **Memory budget:** heap 512 MB and page cache 256 MB to start (`NEO4J_server_memory_*`), set the same on the laptop and EC2 (m7i-flex.large has 8 GB). Full-text indexes live in the OS file cache, outside those numbers. Revisit when a project's graph passes ~100k nodes.
- **When Neo4j is down,** HQ keeps running agents: the brief's memory and ledger sections are empty with a note, `recall` and `read_ledger` say memory is offline, and every write (`remember`, extraction, `ledger_add`, stall entries) queues in SQLite (`memory_outbox`) and replays in order when it comes back. A Setup item shows the outage.
- **Backup and restore.** Community's `neo4j-admin database dump` needs the database stopped, and HQ doesn't run Neo4j (decision 1), so HQ backs up **its own data over Bolt** instead: a nightly job (03:00 local) reads every ArimaOps node and edge and writes them as gzipped JSON lines, one file per project, to `~/.arima/backups/memory/<project>/<date>.jsonl.gz`, keeping 7 days. No downtime, works however Neo4j is run, and per-project files make forget-project clean (section 9). Restore (Settings → Memory, owner only, with the authenticator step-up from a remote device) checks the whole file first, then replaces the project's graph in one transaction and re-reads the ledgers; queued writes are sent before it starts. Labels and edge types are checked by pattern before they reach Cypher. Users who want a whole-database copy can still use `neo4j-admin` themselves. Done when: a test exports, wipes, imports and finds the same nodes and edges.

## 3. Ontology (2.2)

Core node types, the same for every template. Templates add their own through `memoryTypes` (already validated in Phase 1).

| Node | Key fields | Example |
|---|---|---|
| `Task` | `taskId`, `title`, `stageId`, `finishedAt` | T-12 "Add the login rate limit" |
| `Component` | `name`: a file path or a component name | `server/remote.ts`, "TOTP step-up" |
| `Decision` | `text`, `why` | "Rate limits live in remote.ts, not http.ts" |
| `Lesson` | `text` | "`gh pr view --json` needs `statusCheckRollup` for CI state" |
| `DeadEnd` | `text`, `tried`, `why` | "Polling `/hook` for idle didn't work: Codex sends no Stop hook" |
| `Agent` | `agentId`, `roleId` | Arul (developer) |
| `Person` | `userId` | the owner (an HQ user, never a third party; section 6) |

Every memory node (`Decision`, `Lesson`, `DeadEnd` and template types) has: `id`, `projectId`, `text`, `certified` (bool), `certifiedBy`, `createdAt`, `lastUsedAt`, `source` (`extraction` / `remember` / `consolidation`), `taskId`.

Every memory node also carries the `Memory` label (ids `M-<n>`, from the HQ database's counter). Templates can't reuse a core type or a graph label in `memoryTypes`.

Edges: `(Task)-[:TOUCHED]->(Component)`, `(Task)-[:DECIDED|LEARNED|HIT]->(memory)` (`NOTED` for template types), `(Task)-[:HAS_ENTRY]->(LedgerEntry)`, `(memory)-[:ABOUT]->(Component)`, `(Agent)-[:WORKED_ON]->(Task)`, `(Task)-[:FOLLOWS]->(Task)` (from the handoff links), `(memory)-[:SUPERSEDES]->(memory)` (consolidation).

**Search:** a Neo4j full-text index on memory `text` (Lucene, in Community), ranked certified first, then score, then recency. Only the query's words reach Lucene (joined with OR), never its syntax. No embeddings in this phase (decision 3). `related` walks one or two hops from a task, a component or a memory. Both mark what they return as used (`lastUsedAt`) through the outbox. Uniqueness: `Memory.id`, `LedgerEntry.id`, `(Task.projectId, taskId)`, `(Component.projectId, name)`.

## 4. Task summaries (2.3)

When a task reaches done, HQ writes a `TaskSummary` to SQLite (`task_summaries` table): what was done, files touched, the PR or deliverable, the handoff note and the lead's ledger entries for the task. Built by HQ from data it already has (no model call), so every finished task leaves one even when Neo4j or the model is down. The summary is the input to extraction.

## 5. Extraction and consolidation (2.4)

- **Extraction:** after a summary is written, one `ModelRunner.run` with Claude Haiku 5.5 (`purpose: "helper"`, the project's helper account: the owner's `claude -p` sign-in, or a customer's Anthropic key). The prompt asks for JSON: nodes of the core and template types, and edges, with a fixed schema; HQ validates it with zod and drops what doesn't fit. Output is redacted and personal-data filtered (section 6) before any write.
- **Consolidation:** after each board finishes, and nightly after the backup. Finds near-duplicates (same type, full-text match above a threshold, same component), asks Haiku to merge or keep, and links the loser with `SUPERSEDES`. Certified memories are never merged away; an uncertified one can be merged into a certified one.
- **Fading:** an uncertified memory not recalled or used in a brief for **30 days** is deleted by the nightly job. Certified ones never fade.
- **Cost guard:** extraction is skipped (and logged) when the account's Phase 3 spend cap is hit; until then, one Haiku call per finished task plus one per consolidation.

## 6. Never stored (2.5)

Applied to every write path (extraction, `remember`, consolidation), in one function `cleanMemory(text)`:

1. **Secrets:** the existing `Redactor` masks every stored secret value; then generic patterns (private key blocks, `sk-…`, AWS keys, JWTs, `password=` pairs) are masked too. A masked memory that says nothing useful is dropped.
2. **Personal data:** emails, phone numbers, and IPs that aren't in the project's scope are removed by pattern. **Names** can't be caught reliably by pattern: the extraction prompt forbids them, and names that appear in the project's findings or OSINT evidence are checked against each memory and removed. Limit: a name that appears nowhere else in the project can still slip through; certification (2.6) is the human check.
3. Exploit techniques and payloads are allowed.

Done when: a test feeds summaries holding vault secrets, generic keys, emails, phones and finding-listed names, and finds none in the graph.

## 7. Agents use memory (2.7)

```ts
interface MemoryStore {          // Phase 1 methods stay as they are
  addLedger(...); reviseLedger(...); ledger(...); forgetProject(projectId: string): DeletionRecord;
  recall(projectId: string, query: string, opts?: { limit?: number; types?: string[] }): Memory[];
  related(projectId: string, ref: { taskId?: string; path?: string; memoryId?: string }, depth?: 1 | 2): Memory[];
  remember(m: { projectId: string; type: string; text: string; taskId?: string; about?: string[]; by: string }): Memory; // uncertified
  certify(projectId: string, ids: string[], by: string, verdict: "certify" | "reject"): void;
  summarise(s: TaskSummary): void;
}
```

- **The brief** asks `related({ taskId, path: each file })` and `recall(task title)`, fills the memory section certified first, and marks the memories it used (`lastUsedAt`).
- **Team MCP tools:** `recall(query)` and `related(taskId | path)` are read-only for every agent; `remember(type, text, about?)` writes uncertified. All three are scoped to the agent's own project by its token.
- **Ledgers move into Neo4j** (decision 2) as `LedgerEntry` nodes with `SUPERSEDES` for revisions (links to their `Task` node come with the ontology, step 3); ids stay numbers, taken from a counter in the HQ database so they can be given out while Neo4j is down. The existing SQLite `ledger` rows are queued into the outbox once, by migration 2, then the table is left unused and dropped in a later migration. HQ keeps a copy of the ledgers in memory (loaded from Neo4j on connect, plus what's still queued), so the lead's tools and the brief stay synchronous and callers don't change. Callers don't change: `Neo4jMemory` implements the same `MemoryStore` methods. When Neo4j is down, ledger writes queue in the outbox and reads return nothing with a note.
- Done when: a sample follow-up task's brief contains the dead end found in the task it follows, without the agent asking.

## 8. Certify (2.6)

- New uncertified memories become **Action items** of a new kind, `memory`, grouped one item per task ("4 memories from T-12"), with Certify / Reject per memory and **Certify all**.
- **Daily digest:** one push at 09:00 local with the count waiting. **Urgent:** a memory of kind `Decision` or `DeadEnd` that a running task's brief would include, and that contradicts a certified one, pushes at once.
- Owner and operators certify (operators after the TOTP step-up, like other risky commands); viewers can't.
- Done when: a batch of memories is certified from the tablet (browser pane at tablet size, landscape and portrait).

## 9. Forget project (2.8) and Browser (2.9)

- **Forget project** (owner only, after the TOTP step-up), in order: Neo4j `MATCH (n {projectId}) DETACH DELETE n`; SQLite rows with that `project_id` in every table; the project's log docs; then the project's backup folder is deleted and the other projects' backups are left as they are (decision 4: no backup keeps the purged project; with per-project files no other data loses its restore points). It returns a **deletion record**: project id and name, what was removed with counts, when, by whom, and the backup outcome, saved as JSON and as a printable HTML page the owner can send to the client. Template lessons already stripped of project details (Phase 4) stay.
- Done when: a purge test finds no node, row, file or backup left that mentions the project, and the record is generated.
- **Neo4j Browser** (2.9): bound to `127.0.0.1:7474` and reached through `tailscale serve` on a separate port, owner only. Done when it opens over Tailscale and not from the LAN.

## 10. Owner's decisions (2026-11-12)

1. **Neo4j is run by the user**, not by HQ: a compose service for Docker installs, an address in Settings → Memory for npm installs. HQ only connects. (So backups are HQ's own export over Bolt, section 2.)
2. **Ledgers move into Neo4j.** Accepted cost: while Neo4j is down the lead can't read its ledger; writes queue.
3. **Recall is full-text only** this phase. No embedding provider.
4. **Forget project leaves no backup of it.** Done by deleting that project's backup files, possible because backups are per project.
5. **Open:** the new dependency `neo4j-driver` (Apache-2.0).

## 11. Work order

Each step is one commit on `phase-2-memory-core` and ends with `pnpm build` and `pnpm test` green. Tests that need Neo4j start a throwaway container and skip with a clear message when Docker is missing.

| # | Step | Check |
|---|---|---|
| 1 | Neo4j compose service, Settings → Memory (address, password in the vault), `Neo4jMemory` connects; outbox in SQLite; ledgers move with a one-time copy | `memory-test`: the Phase 1 ledger tests pass on Neo4j; outage queues and replays in order |
| 2 | Per-project backup export and restore over Bolt | Export, wipe, import gives the same nodes and edges |
| 3 | Ontology, constraints, full-text index; `recall`, `related`, `remember` | Template `memoryTypes` accepted, unknown types refused |
| 4 | `task_summaries` written at task finish | Every finished task in the planner test leaves one |
| 5 | `cleanMemory`: redaction and personal data | Secrets and personal data never reach the graph |
| 6 | Extraction and consolidation through `ModelRunner` (fake runner in tests), fading | Sample summary gives expected nodes; duplicates merge; 30-day fade |
| 7 | Brief memory section; MCP `recall`, `related`, `remember` | Follow-up task's brief carries the dead end |
| 8 | Certify action items, digest and urgent push; UI for batch certify | Batch certify on tablet, landscape and portrait |
| 9 | Forget project, deletion record | Purge leaves no trace; record generated |
| 10 | Neo4j Browser over Tailscale | Opens over Tailscale only |
| 11 | Local demo and the roadmap's "done when" list with evidence | Owner approval before Phase 3 |

One real `claude -p` extraction run (Haiku, a few cents of subscription usage) is needed for the demo; it runs only with the owner's OK.
