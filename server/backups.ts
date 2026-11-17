// SPDX-License-Identifier: AGPL-3.0-or-later
// HQ's nightly backup: one consistent copy of the whole HQ database (people, plans, memory, usage) at 03:00,
// the last 7 nights kept, private to this user. To restore: stop HQ, copy a backup over ~/.arima/arima.db.
// Forgetting a project also removes it from every backup, so a deleted project doesn't live on in one.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hqDb } from "./lib/db";
import { log } from "./lib/log";
import { homeRoot } from "./paths";

export const KEEP_DAYS = 7;
const BACKUP_HOUR = 3;
const FILE = /^arima-(\d{4}-\d{2}-\d{2})\.db$/;

export const backupsDir = () => join(homeRoot(), "backups");

/** Local date, YYYY-MM-DD: the backup's name. */
export const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The next 03:00 local after `now`. */
export function nextBackupAt(now: Date): Date {
  const at = new Date(now);
  at.setHours(BACKUP_HOUR, 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

/** Backups, newest first (dates). */
export function listBackups(dir = backupsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => FILE.exec(f)?.[1] ?? []).sort().reverse();
}

/** Writes tonight's copy and keeps the newest KEEP_DAYS. */
export function backupDb(db: DatabaseSync = hqDb(), dir = backupsDir(), now = new Date()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `arima-${dayOf(now)}.db`);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  db.prepare("VACUUM INTO ?").run(tmp); // a consistent copy, even while HQ writes
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  for (const old of listBackups(dir).slice(KEEP_DAYS)) rmSync(join(dir, `arima-${old}.db`), { force: true });
  return file;
}

/** Runs `fn` on every backup, then compacts it so deleted rows leave no trace in the file. Returns how many it changed. */
export function eachBackup(fn: (db: DatabaseSync) => void, dir = backupsDir()): number {
  let n = 0;
  for (const day of listBackups(dir)) {
    const db = new DatabaseSync(join(dir, `arima-${day}.db`));
    try {
      fn(db);
      db.exec("VACUUM");
      n++;
    } finally {
      db.close();
    }
  }
  return n;
}

/** Runs backupDb at 03:00 local every night, then `after`. Returns a stop function. */
export function scheduleBackups(after: () => void = () => {}): () => void {
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(() => {
      try {
        log.info(`backup: saved ${backupDb()}`);
      } catch (err) {
        log.warn(`backup skipped: ${err instanceof Error ? err.message : err}`);
      }
      after();
      arm();
    }, nextBackupAt(new Date()).getTime() - Date.now());
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
