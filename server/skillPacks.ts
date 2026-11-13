// SPDX-License-Identifier: AGPL-3.0-or-later
// Pinned skill packs (docs/templates.md section 2). A pack is a GitHub repo at one commit; each skill in it is the
// folder holding a SKILL.md, pinned by a hash of its files. HQ fetches only the skill folders it needs (the repo's
// tree from GitHub's API, the files from raw.githubusercontent.com), checks every hash, scans every file, and keeps
// them in ~/.arima/skill-packs/<owner>__<repo>@<commit>/. No `npx`, no git hooks, nothing runs.
//
// Pins come from two places:
// - skill-packs.lock.json, shipped with HQ: packs vetted by hand (the roadmap's list);
// - ~/.arima/skill-packs.json: packs a role or the stack named, pinned at the commit HQ saw first and usable only
//   after the owner approves their scan (owner's decision 1). They are never updated on their own.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vetted from "../skill-packs.lock.json";
import { BRAND } from "../src/data/brand";
import { readDoc, writeDoc } from "./lib/docs";
import { homeRoot } from "./paths";
import { scanFile, type ScanFinding } from "./skillScan";

export type PackUse = "any" | "scoped-offensive" | "github-action";

export interface PackPin {
  commit: string;
  licence: string | null;
  credit?: string;
  use: PackUse;
  /** skill name → its folder in the repo and the hash of its files. */
  skills: Record<string, { path: string; sha256: string }>;
}

export interface OwnerPack extends PackPin {
  /** pending: scanned, waiting for the owner; approved: usable; rejected: never used. */
  status: "pending" | "approved" | "rejected";
  addedAt: string;
  /** What the scan found, per skill (blocks first). */
  findings: ScanFinding[];
  blocked: string[];
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

const SOURCE = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;

export const vettedPacks = (): Record<string, PackPin> => (vetted as { packs: Record<string, PackPin> }).packs;
const ownerFile = () => join(homeRoot(), "skill-packs.json");
export const ownerPacks = (): Record<string, OwnerPack> => readDoc<Record<string, OwnerPack>>(ownerFile()) ?? {};
const saveOwnerPacks = (p: Record<string, OwnerPack>) => writeDoc(ownerFile(), p);
export const packsRoot = () => join(homeRoot(), "skill-packs");
const packDir = (source: string, commit: string) => join(packsRoot(), `${source.replace("/", "__")}@${commit}`);

/** The pin to use for a source: vetted first, then an approved owner pack. */
export function pinFor(source: string): { pin: PackPin; vetted: boolean } | null {
  const v = vettedPacks()[source];
  if (v) return { pin: v, vetted: true };
  const o = ownerPacks()[source];
  return o?.status === "approved" ? { pin: o, vetted: false } : null;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The hash of a skill: its files' paths (relative to the skill folder) and contents, in a fixed order. */
export function skillHash(files: { path: string; content: Buffer }[]): string {
  return sha([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\0${sha(f.content)}\n`).join(""));
}

interface TreeEntry { path: string; type: string; mode: string; size?: number }

async function tree(source: string, commit: string, get: Fetcher): Promise<TreeEntry[]> {
  const r = await get(`https://api.github.com/repos/${source}/git/trees/${commit}?recursive=1`);
  if (!r.ok) throw new Error(`GitHub didn't list ${source}@${commit.slice(0, 7)} (${r.status}).`);
  const t = JSON.parse(await r.text()) as { truncated?: boolean; tree?: TreeEntry[] };
  if (t.truncated) throw new Error(`${source} is too big for GitHub to list in one go.`);
  return t.tree ?? [];
}

/** Skill folders in a repo tree: every folder holding a SKILL.md, named by the folder. The shallowest wins a name clash. */
export function skillsInTree(entries: Pick<TreeEntry, "path" | "type">[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries.filter((x) => x.type === "blob" && /(^|\/)SKILL\.md$/.test(x.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length)) {
    const dir = dirname(e.path);
    const name = dir === "." ? null : dir.split("/").pop()!;
    if (name && SKILL_NAME.test(name) && !(name in out)) out[name] = dir;
  }
  return out;
}

/** Fetches one skill folder's files at the commit. Symlinks and submodules are refused. */
async function fetchSkill(source: string, commit: string, dir: string, entries: TreeEntry[], get: Fetcher) {
  const files: { path: string; content: Buffer }[] = [];
  let bytes = 0;
  for (const e of entries.filter((x) => x.path.startsWith(`${dir}/`))) {
    if (e.type === "tree") continue;
    if (e.type !== "blob" || e.mode === "120000") throw new Error(`${source}: ${e.path} is a link or submodule; skills may hold plain files only.`);
    const rel = e.path.slice(dir.length + 1);
    if (rel.split("/").some((p) => p === ".." || p === "" || p.startsWith(".git"))) throw new Error(`${source}: refusing the path ${e.path}.`);
    bytes += e.size ?? 0;
    if (bytes > MAX_SKILL_BYTES) throw new Error(`${source}: the ${dir} skill is over ${MAX_SKILL_BYTES >> 20} MB.`);
    const r = await get(`https://raw.githubusercontent.com/${source}/${commit}/${e.path.split("/").map(encodeURIComponent).join("/")}`);
    if (!r.ok) throw new Error(`${source}: couldn't fetch ${e.path} (${r.status}).`);
    files.push({ path: rel, content: Buffer.from(await r.arrayBuffer()) });
  }
  return files;
}

async function licenceText(source: string, commit: string, entries: TreeEntry[], get: Fetcher): Promise<string | null> {
  const f = entries.find((e) => e.type === "blob" && /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(e.path));
  if (!f) return null;
  const r = await get(`https://raw.githubusercontent.com/${source}/${commit}/${encodeURIComponent(f.path)}`);
  return r.ok ? await r.text() : null;
}

/**
 * Makes these skills of a pinned pack available in the local cache, checking each against its pin. Returns the
 * cached folder of each skill. Throws when a skill isn't pinned, doesn't match its hash, or its scan blocks it.
 */
export async function ensurePinnedSkills(source: string, names: string[], get: Fetcher = fetch): Promise<Record<string, string>> {
  const found = pinFor(source);
  if (!found) throw new Error(`${source} isn't pinned yet: approve its scan in Action items first.`);
  const { pin } = found;
  const base = packDir(source, pin.commit);
  const want = names.includes("*") ? Object.keys(pin.skills) : names;
  const out: Record<string, string> = {};
  let entries: TreeEntry[] | null = null;
  for (const name of want) {
    const s = pin.skills[name];
    if (!s) throw new Error(`${source}@${pin.commit.slice(0, 7)} has no pinned skill "${name}".`);
    const dest = join(base, "skills", name);
    if (existsSync(join(dest, ".arima-ok")) && readFileSync(join(dest, ".arima-ok"), "utf8") === s.sha256) {
      out[name] = dest;
      continue;
    }
    entries ??= await tree(source, pin.commit, get);
    const files = await fetchSkill(source, pin.commit, s.path, entries, get);
    const got = skillHash(files);
    if (got !== s.sha256) throw new Error(`${source}@${pin.commit.slice(0, 7)}: the ${name} skill doesn't match its pin. Not used.`);
    const scan = files.flatMap((f) => scanFile(f.path, f.content));
    const blocks = scan.filter((f) => f.level === "block");
    if (blocks.length) throw new Error(`${source}: the ${name} skill is blocked by the scanner (${blocks[0].path}: ${blocks[0].why}).`);
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    for (const f of files) {
      mkdirSync(dirname(join(tmp, f.path)), { recursive: true });
      writeFileSync(join(tmp, f.path), f.content);
    }
    const licence = existsSync(join(base, "LICENSE")) ? readFileSync(join(base, "LICENSE"), "utf8") : await licenceText(source, pin.commit, entries, get);
    if (licence) {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, "LICENSE"), licence);
    }
    writeFileSync(join(tmp, "LICENSE-PACK.md"), packNotice(source, pin, licence));
    writeFileSync(join(tmp, ".arima-ok"), s.sha256);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(tmp, dest);
    out[name] = dest;
  }
  return out;
}

/** Credit and licence, next to every skill an agent gets from a pack (CC-BY-SA needs the credit and the licence). */
function packNotice(source: string, pin: PackPin, licence: string | null): string {
  return [
    `# From ${source}`,
    "",
    `Pinned at commit ${pin.commit} by ${BRAND.name}. ${pin.credit ? `Credit: ${pin.credit}. ` : ""}Licence: ${pin.licence ?? "none stated"}.`,
    "These files are unmodified and stay under their own licence.",
    ...(licence ? ["", "---", "", licence] : []),
  ].join("\n");
}

/**
 * A pack nobody vetted: pin its current commit, fetch every skill, hash and scan them, and keep the result for the
 * owner to approve. Nothing is copied to an agent until they do. Returns the pending (or existing) record.
 */
export async function proposePack(source: string, get: Fetcher = fetch, now = new Date()): Promise<OwnerPack> {
  if (!SOURCE.test(source)) throw new Error(`"${source}" isn't a GitHub owner/repo.`);
  if (vettedPacks()[source]) throw new Error(`${source} is already vetted.`);
  const packs = ownerPacks();
  if (packs[source]) return packs[source];
  const repo = await get(`https://api.github.com/repos/${source}`);
  if (!repo.ok) throw new Error(`GitHub doesn't know ${source} (${repo.status}).`);
  const info = JSON.parse(await repo.text()) as { default_branch?: string; license?: { spdx_id?: string } | null };
  const head = await get(`https://api.github.com/repos/${source}/commits/${encodeURIComponent(info.default_branch ?? "HEAD")}`);
  if (!head.ok) throw new Error(`Couldn't read ${source}'s latest commit (${head.status}).`);
  const commit = String((JSON.parse(await head.text()) as { sha?: string }).sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${source}: no commit to pin.`);
  const entries = await tree(source, commit, get);
  const dirs = skillsInTree(entries);
  const skills: PackPin["skills"] = {};
  const findings: ScanFinding[] = [];
  const blocked: string[] = [];
  for (const [name, dir] of Object.entries(dirs)) {
    const files = await fetchSkill(source, commit, dir, entries, get);
    skills[name] = { path: dir, sha256: skillHash(files) };
    const f = files.flatMap((x) => scanFile(`${dir}/${x.path}`, x.content));
    findings.push(...f);
    if (f.some((x) => x.level === "block")) blocked.push(name);
  }
  const spdx = info.license?.spdx_id && info.license.spdx_id !== "NOASSERTION" ? info.license.spdx_id : null;
  const pack: OwnerPack = { commit, licence: spdx, use: "any", skills, status: "pending", addedAt: now.toISOString(), findings: findings.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1)).slice(0, 200), blocked };
  saveOwnerPacks({ ...ownerPacks(), [source]: pack });
  return pack;
}

/** The owner's answer on a proposed pack. Blocked skills stay unusable even in an approved pack. */
export function decidePack(source: string, approve: boolean): OwnerPack {
  const packs = ownerPacks();
  const p = packs[source];
  if (!p) throw new Error(`No proposed pack ${source}.`);
  p.status = approve ? "approved" : "rejected";
  if (approve) for (const name of p.blocked) delete p.skills[name];
  saveOwnerPacks(packs);
  return p;
}

/** Packs and skills on this machine, for Settings. */
export function packsState() {
  const v = Object.entries(vettedPacks()).map(([source, p]) => ({ source, commit: p.commit, licence: p.licence, credit: p.credit ?? null, use: p.use, skills: Object.keys(p.skills).length, status: "vetted" as const, blocked: [] as string[], warnings: 0 }));
  const o = Object.entries(ownerPacks()).map(([source, p]) => ({ source, commit: p.commit, licence: p.licence, credit: p.credit ?? null, use: p.use, skills: Object.keys(p.skills).length, status: p.status, blocked: p.blocked, warnings: p.findings.filter((f) => f.level === "warn").length }));
  return [...v, ...o];
}

/** Cached pack folders on disk, for "forget" and tests. */
export const cachedPacks = () => (existsSync(packsRoot()) ? readdirSync(packsRoot()) : []);
