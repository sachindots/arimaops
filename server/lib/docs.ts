// HQ's saved state, in SQLite (built-in node:sqlite). Each folder that used to hold
// JSON files (~/.arima, ~/.arima/<project>, <repo>/.arima) gets one arima.db, and every
// old file becomes one row keyed by its file name, so callers still name a file path.
//
// Upgrade: the first time a path is read or written, an existing JSON file (or log) is
// copied into the database in one transaction, then renamed to <name>.pre-sqlite.bak.
// A crash between the two steps is safe: the row wins and the next start renames the file.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_FILE = "arima.db";
export const BACKUP_SUFFIX = ".pre-sqlite.bak";

const open = new Map<string, DatabaseSync>();

const dbFor = (file: string) => openDb(dirname(file));

/** The arima.db of a folder, opened once and shared (docs, logs and server/lib/db.ts's tables). */
export function openDb(dir: string): DatabaseSync {
  let db = open.get(dir);
  if (db) return db;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, DB_FILE);
  // Created 0600 first: SQLite gives its -wal and -shm files the same mode. It holds people, devices and push tokens.
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  // In a repo's .arima folder this keeps the database and backups out of git.
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, `${DB_FILE}*\n*${BACKUP_SUFFIX}\n`);
  db = new DatabaseSync(path);
  // WAL: readers never block the writer, and a crash mid-write rolls back to the last commit.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS docs (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, name TEXT NOT NULL, line TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS log_name ON log (name, id);
  `);
  chmodSync(path, 0o600); // a database from before this check
  open.set(dir, db);
  return db;
}

export function tx(db: DatabaseSync, fn: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Moves a leftover JSON file into the database once; `isLog` imports it line by line. */
function adopt(db: DatabaseSync, file: string, isLog: boolean) {
  if (!existsSync(file)) return;
  const name = basename(file);
  if (isLog) {
    const imported = db.prepare("SELECT 1 FROM log WHERE name = ? LIMIT 1").get(name);
    if (!imported) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const add = db.prepare("INSERT INTO log (name, line) VALUES (?, ?)");
      tx(db, () => { for (const l of lines) add.run(name, l); });
    }
  } else if (!db.prepare("SELECT 1 FROM docs WHERE name = ?").get(name)) {
    const text = readFileSync(file, "utf8");
    JSON.parse(text); // a corrupt file throws here and stays where it is, like before
    db.prepare("INSERT INTO docs (name, value, updated) VALUES (?, ?, ?)").run(name, text, Date.now());
  }
  renameSync(file, file + BACKUP_SUFFIX);
}

/** The saved value for this path, or null if there is none. */
export function readDoc<T>(file: string): T | null {
  if (!existsSync(join(dirname(file), DB_FILE)) && !existsSync(file)) return null; // reading never creates a database
  const db = dbFor(file);
  adopt(db, file, false);
  const row = db.prepare("SELECT value FROM docs WHERE name = ?").get(basename(file)) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export const hasDoc = (file: string) => readDoc(file) !== null;

/** Saves the value atomically (one SQLite transaction). */
export function writeDoc(file: string, value: unknown) {
  const db = dbFor(file);
  adopt(db, file, false);
  db.prepare("INSERT INTO docs (name, value, updated) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated = excluded.updated")
    .run(basename(file), JSON.stringify(value), Date.now());
}

/** Appends one line to a log (the old append-only text file). */
export function appendLine(file: string, line: string) {
  const db = dbFor(file);
  adopt(db, file, true);
  db.prepare("INSERT INTO log (name, line) VALUES (?, ?)").run(basename(file), line.replace(/\n+$/, ""));
}

/** Every line of a log, oldest first. */
export function readLines(file: string): string[] {
  if (!existsSync(join(dirname(file), DB_FILE)) && !existsSync(file)) return [];
  const db = dbFor(file);
  adopt(db, file, true);
  return (db.prepare("SELECT line FROM log WHERE name = ? ORDER BY id").all(basename(file)) as { line: string }[]).map((r) => r.line);
}

/** Closes every open database (tests, and before a folder is moved). */
export function closeDocs() {
  for (const db of open.values()) db.close();
  open.clear();
}
