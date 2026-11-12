// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed tables of the core model (docs/core-model.md), in the HQ database ~/.arima/arima.db
// next to the docs and log tables. Every project-scoped row carries project_id.
//
// MIGRATIONS only grows: a released entry is never edited, a change is a new entry.
// Each one runs in its own transaction, so a failing one leaves the database as it was.

import type { DatabaseSync } from "node:sqlite";
import { homeRoot } from "../paths";
import { openDb, tx } from "./docs";

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    updated_by TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE projects_model (
    project_id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    template_version INTEGER NOT NULL,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE boards (
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'planned', 'done')),
    ord INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
  );

  CREATE TABLE tasks (
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    title TEXT NOT NULL,
    owner_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('todo', 'in-progress', 'in-review', 'done', 'blocked')),
    needs TEXT NOT NULL DEFAULT '[]',
    files TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    done_when TEXT,
    note TEXT,
    pr_number INTEGER,
    deliverable_path TEXT,
    cli TEXT,
    model TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id, board_id) REFERENCES boards (project_id, id) ON DELETE CASCADE
  );

  CREATE TABLE gate_events (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('passed', 'failed', 'waived', 'reset')),
    by_kind TEXT NOT NULL CHECK (by_kind IN ('agent', 'user', 'hq')),
    by_id TEXT NOT NULL,
    proof TEXT NOT NULL DEFAULT '{}',
    at INTEGER NOT NULL,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE
  );
  CREATE INDEX gate_events_task ON gate_events (project_id, task_id, gate_id, id);

  CREATE TABLE findings (
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task_id TEXT,
    reporter_id TEXT NOT NULL,
    title TEXT NOT NULL,
    asset_kind TEXT NOT NULL CHECK (asset_kind IN ('url', 'host', 'ip', 'repo', 'cloud', 'app')),
    asset_value TEXT NOT NULL,
    location TEXT,
    cvss_vector TEXT,
    cvss_score REAL CHECK (cvss_score IS NULL OR cvss_score BETWEEN 0 AND 10),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    ssvc TEXT,
    cwe TEXT NOT NULL DEFAULT '[]',
    attack TEXT NOT NULL DEFAULT '[]',
    d3fend TEXT NOT NULL DEFAULT '[]',
    wstg TEXT,
    description TEXT NOT NULL,
    impact TEXT NOT NULL DEFAULT '',
    remediation TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '[]',
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    verified_by TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'confirmed', 'fixed', 'accepted', 'false-positive')),
    at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, id),
    CHECK ((cvss_vector IS NULL) = (cvss_score IS NULL))
  );

  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT,
    ledger TEXT NOT NULL CHECK (ledger IN ('task', 'progress')),
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'guess', 'plan', 'stall', 'replan', 'note')),
    text TEXT NOT NULL,
    by TEXT NOT NULL,
    at INTEGER NOT NULL,
    superseded_by INTEGER REFERENCES ledger (id)
  );
  CREATE INDEX ledger_project ON ledger (project_id, ledger, task_id, id);

  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT,
    agent_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('agent', 'helper', 'review')),
    account TEXT NOT NULL,
    provider TEXT NOT NULL,
    cli TEXT,
    model TEXT NOT NULL,
    input INTEGER NOT NULL CHECK (input >= 0),
    cached INTEGER NOT NULL CHECK (cached >= 0),
    output INTEGER NOT NULL CHECK (output >= 0),
    cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0)
  );
  CREATE INDEX usage_project ON usage_events (project_id, at);
  CREATE INDEX usage_account ON usage_events (account, at);
  CREATE INDEX usage_task ON usage_events (project_id, task_id);

  -- The meter totals HQ last turned into events, per agent and model; the next read records only what's new.
  CREATE TABLE usage_marks (
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL,
    cached INTEGER NOT NULL,
    output INTEGER NOT NULL,
    PRIMARY KEY (project_id, agent_id, model)
  );
  `,
  // Phase 2 step 1: the ledgers move into Neo4j (docs/memory-core.md). Writes go through this outbox, so
  // they survive a Neo4j outage and replay in order. The old ledger rows are queued once, here.
  `
  CREATE TABLE memory_outbox (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    op TEXT NOT NULL,
    at INTEGER NOT NULL,
    failed TEXT
  );
  CREATE INDEX memory_outbox_project ON memory_outbox (project_id);

  -- Ledger ids keep counting from the SQLite ledger, whether Neo4j is up or not.
  CREATE TABLE memory_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
  INSERT INTO memory_ids (id) SELECT max(id) FROM ledger WHERE id IS NOT NULL HAVING max(id) IS NOT NULL;

  INSERT INTO memory_outbox (project_id, op, at)
    SELECT project_id, json_object('op', 'ledger', 'e', json_object(
      'id', id, 'projectId', project_id, 'taskId', task_id, 'ledger', ledger, 'kind', kind,
      'text', text, 'by', by, 'at', strftime('%Y-%m-%dT%H:%M:%fZ', at / 1000.0, 'unixepoch'))), at
    FROM ledger ORDER BY id;
  INSERT INTO memory_outbox (project_id, op, at)
    SELECT project_id, json_object('op', 'supersede', 'id', id, 'by', superseded_by), at
    FROM ledger WHERE superseded_by IS NOT NULL ORDER BY id;
  `,
];

/** The schema version a database is at (0 = none of the core tables yet). */
export function schemaVersion(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/** Brings the database up to the last migration. Safe to run again; refuses a database a newer HQ wrote. */
export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS) {
  const at = schemaVersion(db);
  if (at > migrations.length)
    throw new Error(`The HQ database is at schema ${at}, newer than this HQ (${migrations.length}). Update ArimaOps before starting it.`);
  for (let v = at; v < migrations.length; v++) {
    tx(db, () => {
      db.exec(migrations[v]);
      db.exec("DELETE FROM schema_version");
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v + 1);
    });
  }
}

const migrated = new WeakSet<DatabaseSync>();

/** The HQ database with every migration applied. */
export function hqDb(dir = homeRoot()): DatabaseSync {
  const db = openDb(dir);
  if (!migrated.has(db)) {
    migrate(db);
    migrated.add(db);
  }
  return db;
}
