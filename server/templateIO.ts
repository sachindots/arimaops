// SPDX-License-Identifier: AGPL-3.0-or-later
// Saving a template to a file and importing one (docs/templates.md section 7). Export writes the project's template
// with the pins of the packs it names. Import checks the template, pins every pack it names (vetted, already approved,
// or fetched at the file's commit, hash-checked and scanned for the owner), and saves it to the library under a new id.
// Nothing runs until a project uses it, and a project can't use it while a pack it names waits for the owner.

import type { DatabaseSync } from "node:sqlite";
import type { TeamTemplate } from "../src/data/model";
import { BUILTIN_TEMPLATES } from "../src/data/templates";
import { packSkillsOf, readTemplateFile, toTemplateFile, type PackPinFile, type TemplateFile } from "../src/data/templateFile";
import { slugify } from "./paths";
import { type Fetcher, forgetPendingPack, ownerPacks, pinFor, proposePack, vettedPacks } from "./skillPacks";
import { getTemplate, listTemplates, saveTemplate, TemplateError } from "./templates";
import { liveHubs } from "./projectsRegistry";
import type { TemplateEntry } from "../src/data/types";

const BUILTIN = new Set(BUILTIN_TEMPLATES.map((t) => t.id));

/** The library for the welcome: every template, with what stops a project from using it. */
export const libraryState = (db: DatabaseSync): TemplateEntry[] => {
  // Built-ins in the order HQ ships them (Dev first, Blank last), then the owner's own by name.
  const at = (id: string) => BUILTIN_TEMPLATES.findIndex((t) => t.id === id);
  const list = listTemplates(db).sort((a, b) => (BUILTIN.has(a.id) && BUILTIN.has(b.id) ? at(a.id) - at(b.id) : BUILTIN.has(a.id) ? -1 : BUILTIN.has(b.id) ? 1 : a.name.localeCompare(b.name)));
  return list.map((t) => ({ template: t, builtin: BUILTIN.has(t.id), problems: packProblems(t) }));
};

/** Tells every open project that the library changed (an import, or a pack approved). */
export function broadcastLibrary(db: DatabaseSync) {
  const templateLibrary = libraryState(db);
  for (const h of liveHubs()) {
    h.snap.templateLibrary = templateLibrary;
    h.emit({ type: "templates.updated", templateLibrary });
  }
}

/** The template as a file, with the pins of the packs it names (packs nobody pinned yet are left out). */
export function exportTemplate(t: TeamTemplate, now = new Date()): TemplateFile {
  const packs: Record<string, PackPinFile> = {};
  for (const [source, names] of packSkillsOf(t)) {
    const pin = pinFor(source)?.pin;
    if (!pin) continue;
    const skills: PackPinFile["skills"] = {};
    for (const n of names) if (pin.skills[n]) skills[n] = { path: pin.skills[n].path, sha256: pin.skills[n].sha256 };
    packs[source] = { commit: pin.commit, skills };
  }
  return toTemplateFile(t, packs, now);
}

/** Packs a template names that can't be used yet, in words: empty when every pack skill is pinned and allowed. */
export function packProblems(t: TeamTemplate): string[] {
  const out: string[] = [];
  for (const [source, names] of packSkillsOf(t)) {
    const pin = pinFor(source)?.pin;
    const owner = ownerPacks()[source];
    if (!pin) out.push(owner?.status === "pending" ? `the skills from ${source} wait for your check (Action items)` : owner?.status === "rejected" ? `you rejected the skills from ${source}` : `${source} isn't pinned on this HQ`);
    else for (const n of names) if (!pin.skills[n]) out.push(`${source} has no skill ${n} at its pinned commit${owner?.blocked.includes(n) ? " (the scan blocked it)" : ""}`);
  }
  return out;
}

export interface ImportResult {
  template: TeamTemplate;
  /** Packs fetched and scanned for this import, waiting for the owner. */
  pending: string[];
  /** Things the owner should know (a vetted pin newer than the file's, for example). */
  notes: string[];
}

/** A library id from the template's own, never a built-in's or one already saved. */
function freeId(db: DatabaseSync, want: string): string {
  const builtin = new Set(BUILTIN_TEMPLATES.map((t) => t.id));
  const base = (slugify(want) || "imported").slice(0, 40).replace(/-+$/, "") || "imported";
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!builtin.has(id) && !getTemplate(db, id)) return id;
  }
}

/**
 * Imports a template file's text. Throws (and saves nothing) when the template is invalid, a pack's skill is missing,
 * or GitHub's files at the file's commit don't match its hashes.
 */
export async function importTemplate(db: DatabaseSync, text: string, by: string, get: Fetcher = fetch, now = new Date()): Promise<ImportResult> {
  const { template, packs } = readTemplateFile(text);
  const pending: string[] = [];
  const notes: string[] = [];
  // Packs this import proposed are dropped again if it fails: nothing is left waiting for a template that isn't there.
  const proposed: string[] = [];
  const fail = (why: string): never => {
    for (const s of proposed) forgetPendingPack(s);
    throw new TemplateError(why);
  };
  for (const [source, names] of packSkillsOf(template)) {
    const want = packs[source];
    const vetted = vettedPacks()[source];
    if (vetted) {
      const missing = [...names].filter((n) => !vetted.skills[n]);
      if (missing.length) fail(`${source} has no ${missing.join(", ")} at the commit this HQ vetted.`);
      if (want && want.commit !== vetted.commit) notes.push(`${source} is used at this HQ's vetted commit ${vetted.commit.slice(0, 7)}, not the file's ${want.commit.slice(0, 7)}.`);
      continue;
    }
    const owner = ownerPacks()[source];
    if (owner) {
      if (want && owner.commit !== want.commit) fail(`${source} is pinned here at ${owner.commit.slice(0, 7)}, the file at ${want.commit.slice(0, 7)}. Remove the pack here first, or export the template again.`);
      if (owner.status === "rejected") fail(`You rejected the skills from ${source}; a template that needs them can't be imported.`);
      if (owner.status === "pending") pending.push(source);
      continue;
    }
    const p = await proposePack(source, get, now, want?.commit).catch((e: unknown) => fail(`Couldn't fetch ${source}: ${e instanceof Error ? e.message : String(e)}`));
    proposed.push(source);
    if (!want) notes.push(`${source} had no pin in the file: pinned at its newest commit ${p.commit.slice(0, 7)}.`);
    for (const n of names) {
      if (!p.skills[n]) fail(`${source} has no skill ${n} at ${p.commit.slice(0, 7)}.`);
      if (want && p.skills[n].sha256 !== want.skills[n].sha256) fail(`${source}@${n} at ${p.commit.slice(0, 7)} isn't what the file says (its hash differs). Not imported.`);
    }
    pending.push(source);
  }
  let saved: TeamTemplate;
  try {
    saved = saveTemplate(db, { ...template, id: freeId(db, template.id) }, by);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return { template: saved, pending, notes };
}
