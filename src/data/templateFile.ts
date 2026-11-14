// SPDX-License-Identifier: AGPL-3.0-or-later
// A template saved to a file and imported on another HQ (docs/templates.md section 7): the TeamTemplate plus the pins
// of the skill packs its roles name, so the other HQ fetches the same commit and checks the same hashes. No secrets,
// no seats, no project data: a TeamTemplate holds none of those.

import { type TeamTemplate, templateErrors } from "./model";

export const TEMPLATE_FORMAT = "arimaops-template";
/** Biggest file accepted on import. */
export const MAX_TEMPLATE_BYTES = 512 * 1024;

export interface PackPinFile {
  commit: string;
  /** skill name → its folder and hash, for the skills the template names only. */
  skills: Record<string, { path: string; sha256: string }>;
}

export interface TemplateFile {
  format: typeof TEMPLATE_FORMAT;
  v: 1;
  exportedAt: string;
  template: TeamTemplate;
  /** owner/repo → its pin. A pack missing here is pinned at its newest commit on import (and scanned). */
  packs: Record<string, PackPinFile>;
}

const PACK_SKILL = /^([A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100})@([A-Za-z0-9][A-Za-z0-9._-]{0,80})$/;

/** The pack skills a template's roles name: owner/repo → skill names. Built-in skills (no "@") aren't packs. */
export function packSkillsOf(t: TeamTemplate): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of t.roles)
    for (const s of r.skills) {
      const m = s.match(PACK_SKILL);
      if (!m) continue;
      const set = out.get(m[1]) ?? new Set<string>();
      set.add(m[2]);
      out.set(m[1], set);
    }
  return out;
}

/** Only the fields a TeamTemplate has, so nothing else in a file rides along into the library. */
function cleanTemplate(t: TeamTemplate): TeamTemplate {
  const { id, version, name, description, roles, flow, starter, rules, memoryTypes } = t;
  return { id, version, name, description, roles, flow, starter, rules, memoryTypes };
}

export function toTemplateFile(t: TeamTemplate, packs: Record<string, PackPinFile>, now = new Date()): TemplateFile {
  return { format: TEMPLATE_FORMAT, v: 1, exportedAt: now.toISOString(), template: cleanTemplate(t), packs };
}

/** Reads and checks a file's text. Throws with every problem in plain words. */
export function readTemplateFile(text: string): { template: TeamTemplate; packs: Record<string, PackPinFile> } {
  if (new TextEncoder().encode(text).length > MAX_TEMPLATE_BYTES) throw new Error(`The file is over ${MAX_TEMPLATE_BYTES / 1024} KB: not a template.`);
  let data: Partial<TemplateFile>;
  try {
    data = JSON.parse(text) as Partial<TemplateFile>;
  } catch {
    throw new Error("The file isn't JSON.");
  }
  if (!data || typeof data !== "object" || data.format !== TEMPLATE_FORMAT) throw new Error(`Not an ArimaOps template file (format "${TEMPLATE_FORMAT}").`);
  if (data.v !== 1) throw new Error(`Template file version ${String(data.v)} isn't one this HQ reads (1).`);
  if (!data.template || typeof data.template !== "object") throw new Error("The file has no template.");
  const template = cleanTemplate(data.template);
  let errs: string[];
  try {
    errs = templateErrors(template);
  } catch {
    errs = ["The template is malformed."];
  }
  if (errs.length) throw new Error(`The template isn't valid: ${errs.join(" ")}`);
  const packs: Record<string, PackPinFile> = {};
  const raw = data.packs && typeof data.packs === "object" ? data.packs : {};
  const used = packSkillsOf(template);
  for (const [source, p] of Object.entries(raw)) {
    if (!used.has(source)) continue; // pins for packs the template doesn't use are ignored
    if (!p || typeof p !== "object" || !/^[0-9a-f]{40}$/.test(String(p.commit))) throw new Error(`The pin for ${source} has no commit.`);
    const skills: PackPinFile["skills"] = {};
    for (const name of used.get(source)!) {
      const s = p.skills?.[name];
      if (!s || typeof s.path !== "string" || !/^[0-9a-f]{64}$/.test(String(s.sha256))) throw new Error(`The pin for ${source} has no hash for ${name}.`);
      skills[name] = { path: s.path, sha256: s.sha256 };
    }
    packs[source] = { commit: p.commit, skills };
  }
  return { template, packs };
}
