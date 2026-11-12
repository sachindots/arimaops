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

When a task reaches done, HQ writes a `TaskSummary` to SQLite (`task_summaries` table): what was done, files touched, the PR or deliverable, the handoff note and the lead's ledger entries for the task. Built by HQ from data it already has (no model call), so every finished task leaves one even when Neo4j or the model is down; finishing a task again replaces it. The summary is the input to extraction. The same write queues the task's graph: `(Task)-[:FOLLOWS]->(Task)` for each task it needs, `(Task)-[:TOUCHED]->(Component)` for the files it was given (not yet the PR's real diff), `(Agent)-[:WORKED_ON]->(Task)` for its owner. Both ways a task finishes (an agent's `set_my_status`, and a person, GitHub or a lead through `updateTask`) go through one planner hook.

## 5. Extraction and consolidation (2.4)

- **Extraction** (`server/memoryExtract.ts`): after a summary is written, one `ModelRunner.run` with Claude Haiku 5.5 (`claude-haiku-5-5`, `purpose: "helper"`) on the account chosen in Settings → Memory: the owner's `claude -p` sign-in, or an Anthropic API-key account. **Off until the owner turns it on** (it spends usage); tasks finished meanwhile are read when it is turned on. The prompt gives the summary as data and forbids names, contacts and secrets; the reply is parsed against a fixed zod schema, types the project doesn't have are dropped, and each memory goes through `remember` (so it is cleaned, section 6). A summary gets at most 3 tries, one per run (after a task finishes, and nightly); the last error is kept on the summary row.
- **Consolidation:** after a board is marked done, and nightly. Look-alike pairs (same type, word overlap of 60% or more, at most 20) go to Haiku in one call, which names the pairs that say the same thing and gives one merged text. The kept memory takes the merged text and the dropped one's links (`ABOUT`, its task's edge); the dropped one stays as history (`SUPERSEDES`, `supersededBy`) and is no longer recalled. A certified memory is never dropped and its text is never rewritten; two certified memories are never paired. Merges Haiku invents for pairs it wasn't asked about are ignored.
- **Fading:** nightly, after the backup, an uncertified memory not recalled or used in a brief for **30 days** is deleted. Certified ones never fade.
- **Cost guard:** the spend caps come in Phase 3; until then the switch in Settings → Memory is the guard. One Haiku call per finished task plus one per consolidation that finds look-alikes.

## 6. Never stored (2.5)

Applied inside the store to every write (`remember`, ledger entries, task summaries and task nodes; extraction and consolidation write through `remember`), in one function `cleanMemory(text, context)` (`server/memoryClean.ts`). Masks read `[secret]`, `[email]`, `[phone]`, `[ip]`, `[name]`; a memory with too little left is refused:

1. **Secrets:** the existing `Redactor` masks every stored secret value; then generic patterns (private key blocks, `sk-…`, AWS keys, JWTs, `password=` pairs) are masked too. A masked memory that says nothing useful is dropped.
2. **Personal data:** emails and phone numbers (only in phone-number shapes, so dates, versions, ports and ids stay) are masked by pattern, and so are public IPv4 addresses outside the project's scope (loopback, private, Tailscale and documentation ranges stay). **Names** can't be caught by pattern, and findings have no field for people, so each project keeps a **keep-out list** (`memory_keep_out`): agents doing OSINT or sales add the names they meet (the MCP tool comes with step 7), and the owner can too. Adding a name also scrubs it from memories, ledgers, task nodes and summaries already stored. Limit: a name nobody put on the list can still slip through; extraction's prompt forbids names (step 6) and certification (2.6) is the human check. IPv6 isn't masked yet.
3. Exploit techniques and payloads are allowed.

Done when: a test feeds memories, ledger entries and summaries holding vault secrets, generic keys, emails, phones and kept-out names, and finds none in the graph or the summaries.

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

- **The brief** (`get_my_task`) asks `related` for each task it builds on and each of its files (one hop), and `recall` with its title and description; it keeps up to 12, certified first, each with its type, task, files and id, and marks them used (`lastUsedAt`). When Neo4j is down the section says memory is offline and the brief still arrives.
- **Team MCP tools:** `recall(query)` and `related(taskId | path | memoryId)` are read-only for every agent; `remember(type, text, about?, taskId?)` writes uncertified (on the agent's current task by default); `keep_out_of_memory(name)` adds to the project's keep-out list (section 6). All are scoped to the agent's own project by its token; the two that write are refused in read-only projects.
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
