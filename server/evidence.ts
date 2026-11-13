// SPDX-License-Identifier: AGPL-3.0-or-later
// The verifier's evidence (docs/factory.md section 7): screenshots or a short recording of the running app for a
// task's PR, at one commit, kept under ~/.arima/<project>/evidence/<task>/<sha>/ with what it did. No binaries go in
// the repo; the PR gets a comment that points here. Files are copied from the verifier's workspace only, and only
// real images or videos (checked by their first bytes).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, sep } from "node:path";
import type { TaskEvidence } from "../src/data/types";
import { projectHome } from "./paths";

export const MAX_FILES = 12;
export const MAX_BYTES = 15 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;
export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.(png|jpg|webp|webm|mp4)$/;

export const evidenceRoot = (slug: string) => join(projectHome(slug), "evidence");
const taskDir = (slug: string, taskId: string) => join(evidenceRoot(slug), taskId);

/** What a file is, by its first bytes; null for anything that isn't an image or video we keep. */
export function kindOf(head: Buffer): "png" | "jpg" | "webp" | "webm" | "mp4" | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  return null;
}

function head(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(16);
    readSync(fd, b, 0, 16, 0);
    return b;
  } finally {
    closeSync(fd);
  }
}

export interface EvidenceInput {
  taskId: string;
  prNumber: number | null;
  sha: string;
  by: string;
  steps: string[];
  files: { path: string; label: string }[];
}

/**
 * Copies the verifier's files from its workspace and writes the manifest. Throws, saying why, for a bad commit, a
 * file outside the workspace, too many or too big files, or one that isn't an image or video.
 */
export function saveEvidence(slug: string, workspace: string, input: EvidenceInput, now = new Date()): TaskEvidence {
  if (!TASK.test(input.taskId)) throw new Error(`Bad task id "${input.taskId}".`);
  if (!SHA.test(input.sha)) throw new Error("Give the PR's full head commit (40 hex characters): git rev-parse HEAD after checking it out.");
  if (!input.files.length) throw new Error("Attach at least one screenshot or recording.");
  if (input.files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files.`);
  const base = realpathSync(workspace);
  const picked = input.files.map((f, i) => {
    let real: string;
    try {
      real = realpathSync(join(base, f.path));
    } catch {
      throw new Error(`No file ${f.path} in your workspace.`);
    }
    if (!real.startsWith(base + sep)) throw new Error(`${f.path} is outside your workspace.`);
    const st = statSync(real);
    if (!st.isFile()) throw new Error(`${f.path} isn't a file.`);
    if (st.size > MAX_BYTES) throw new Error(`${f.path} is over ${MAX_BYTES / 1024 / 1024} MB.`);
    const kind = kindOf(head(real));
    if (!kind) throw new Error(`${f.path} isn't a PNG, JPEG, WebP, WebM or MP4.`);
    const label = f.label.replace(/\s+/g, " ").trim().slice(0, 80) || `Shot ${i + 1}`;
    const slugged = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shot";
    return { real, file: `${String(i + 1).padStart(2, "0")}-${slugged}.${kind}`, label };
  });
  const dir = join(taskDir(slug, input.taskId), input.sha);
  mkdirSync(dir, { recursive: true });
  for (const p of picked) copyFileSync(p.real, join(dir, p.file));
  const ev: TaskEvidence = {
    sha: input.sha,
    prNumber: input.prNumber,
    by: input.by,
    at: now.toISOString(),
    steps: input.steps.map((s) => s.replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(0, 20),
    shots: picked.map((p) => ({ file: p.file, label: p.label })),
  };
  writeFileSync(join(dir, "evidence.json"), JSON.stringify(ev, null, 2));
  return ev;
}

/** The newest evidence for a task, at any commit. */
export function latestEvidence(slug: string, taskId: string): TaskEvidence | null {
  const dir = taskDir(slug, taskId);
  if (!TASK.test(taskId) || !existsSync(dir)) return null;
  const all = readdirSync(dir)
    .filter((d) => SHA.test(d) && existsSync(join(dir, d, "evidence.json")))
    .map((d) => JSON.parse(readFileSync(join(dir, d, "evidence.json"), "utf8")) as TaskEvidence)
    .sort((a, b) => a.at.localeCompare(b.at));
  return all.at(-1) ?? null;
}

/** A stored evidence file's path, or null when the parts don't name one (the HTTP route serves only these). */
export function evidenceFile(slug: string, taskId: string, sha: string, file: string): string | null {
  if (!TASK.test(taskId) || !SHA.test(sha) || !SAFE_NAME.test(file)) return null;
  const p = join(taskDir(slug, taskId), sha, file);
  return existsSync(p) ? p : null;
}

export const CONTENT_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", webm: "video/webm", mp4: "video/mp4" };

/** The PR comment: what was checked, at which commit, and where to see it. */
export function prComment(ev: TaskEvidence, taskId: string, verifier: string, link: string | null): string {
  return [
    `**ArimaOps verifier** (${verifier}) checked this PR at \`${ev.sha.slice(0, 7)}\` with the app running:`,
    "",
    ...ev.steps.map((s) => `- ${s}`),
    "",
    `${ev.shots.length} screenshot${ev.shots.length === 1 ? "" : "s"}: ${ev.shots.map((s) => s.label).join(", ")}.`,
    link ? `See them on ${taskId} in HQ: ${link}` : `They're on ${taskId} in ArimaOps HQ (kept on the HQ machine, not in the repo).`,
  ].join("\n");
}
