// SPDX-License-Identifier: AGPL-3.0-or-later
// The template library and each project's own copy (docs/core-model.md section 3).
// Built-in templates come from code and can't be overwritten; edits are saved under a new id.
// A project copies its template once, so library edits never change a running project.

import type { DatabaseSync } from "node:sqlite";
import { type Role, type Seat, type TeamTemplate, templateErrors } from "../src/data/model";
import type { AgentConfig, HqConfig, SandboxSettings, WorkflowMode } from "../src/data/types";
import { LEAD_NAME, nextAgentName } from "../src/data/names";
import { BUILTIN_TEMPLATES } from "../src/data/templates";
import { agentPalette } from "../src/theme/tokens";
import { slugify } from "./paths";

export const defaultSandbox = (): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null }, // sbx's own defaults
  allow: [],
  deny: [],
});

const BUILTIN_IDS = new Set(BUILTIN_TEMPLATES.map((t) => t.id));

export class TemplateError extends Error {}

function assertValid(t: TeamTemplate) {
  const errs = templateErrors(t);
  if (errs.length) throw new TemplateError(errs.join(" "));
}

/** Writes the built-in templates as this version of HQ ships them. Run at start. */
export function seedBuiltins(db: DatabaseSync) {
  const put = db.prepare(
    `INSERT INTO templates (id, version, body, builtin, updated_by, updated_at) VALUES (?, ?, ?, 1, 'hq', ?)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version, body = excluded.body, builtin = 1, updated_by = 'hq', updated_at = excluded.updated_at
     WHERE templates.version <> excluded.version OR templates.body <> excluded.body`,
  );
  for (const t of BUILTIN_TEMPLATES) {
    assertValid(t);
    put.run(t.id, t.version, JSON.stringify(t), Date.now());
  }
}

export function listTemplates(db: DatabaseSync): TeamTemplate[] {
  return (db.prepare("SELECT body FROM templates ORDER BY builtin DESC, id").all() as { body: string }[]).map((r) => JSON.parse(r.body));
}

export function getTemplate(db: DatabaseSync, id: string): TeamTemplate | null {
  const row = db.prepare("SELECT body FROM templates WHERE id = ?").get(id) as { body: string } | undefined;
  return row ? JSON.parse(row.body) : null;
}

/** Saves a template to the library. The version is HQ's to bump; the caller's value is ignored. */
export function saveTemplate(db: DatabaseSync, t: TeamTemplate, by: string): TeamTemplate {
  if (BUILTIN_IDS.has(t.id)) throw new TemplateError(`"${t.id}" is built in. Save your changes under a new id.`);
  const prev = db.prepare("SELECT version FROM templates WHERE id = ?").get(t.id) as { version: number } | undefined;
  const saved = { ...t, version: (prev?.version ?? 0) + 1 };
  assertValid(saved);
  db.prepare(
    `INSERT INTO templates (id, version, body, builtin, updated_by, updated_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version, body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(saved.id, saved.version, JSON.stringify(saved), by, Date.now());
  return saved;
}

/** Gives a new project its own copy of a library template. */
export function copyToProject(db: DatabaseSync, projectId: string, templateId: string): TeamTemplate {
  const t = getTemplate(db, templateId);
  if (!t) throw new TemplateError(`No template "${templateId}".`);
  if (projectTemplate(db, projectId)) throw new TemplateError(`Project "${projectId}" already has a template. Re-sync it instead.`);
  db.prepare("INSERT INTO projects_model (project_id, template_id, template_version, body, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    projectId,
    t.id,
    t.version,
    JSON.stringify(t),
    Date.now(),
  );
  return t;
}

/** Drops a project's template copy: when the project is deleted, or a welcome starts over. */
export function forgetProjectTemplate(db: DatabaseSync, projectId: string) {
  db.prepare("DELETE FROM projects_model WHERE project_id = ?").run(projectId);
}

/** The project's own template, or null for a project made before templates (read-only). */
export function projectTemplate(db: DatabaseSync, projectId: string): TeamTemplate | null {
  const row = db.prepare("SELECT body FROM projects_model WHERE project_id = ?").get(projectId) as { body: string } | undefined;
  return row ? JSON.parse(row.body) : null;
}

/** Edits the project's copy only; the library is untouched. */
export function updateProjectTemplate(db: DatabaseSync, projectId: string, t: TeamTemplate): TeamTemplate {
  const cur = projectTemplate(db, projectId);
  if (!cur) throw new TemplateError(`Project "${projectId}" has no template.`);
  const saved = { ...t, id: cur.id, version: cur.version };
  assertValid(saved);
  db.prepare("UPDATE projects_model SET body = ?, updated_at = ? WHERE project_id = ?").run(JSON.stringify(saved), Date.now(), projectId);
  return saved;
}

/** Replaces the project's copy with the library's current version of its template, on purpose. */
export function resyncProject(db: DatabaseSync, projectId: string): TeamTemplate {
  const row = db.prepare("SELECT template_id FROM projects_model WHERE project_id = ?").get(projectId) as { template_id: string } | undefined;
  if (!row) throw new TemplateError(`Project "${projectId}" has no template.`);
  const t = getTemplate(db, row.template_id);
  if (!t) throw new TemplateError(`Template "${row.template_id}" is no longer in the library.`);
  db.prepare("UPDATE projects_model SET template_version = ?, body = ?, updated_at = ? WHERE project_id = ?").run(t.version, JSON.stringify(t), Date.now(), projectId);
  return t;
}

/** The role's colour while no one else wears it, else the first free palette colour. */
export function freeColor(want: string, taken: string[]): string {
  if (!taken.includes(want)) return want;
  return agentPalette.find((c) => !taken.includes(c)) ?? agentPalette[taken.length % agentPalette.length];
}

/** The seats a new project starts with: each role's seat count, the lead first, with default names. */
export function seatsFor(t: TeamTemplate): Seat[] {
  const taken: string[] = [];
  const colors: string[] = [];
  const roles = [...t.roles].sort((a, b) => Number(b.isLead) - Number(a.isLead));
  return roles.flatMap((r) =>
    Array.from({ length: r.seats }, () => {
      const name = r.isLead && !taken.includes(LEAD_NAME) ? LEAD_NAME : nextAgentName(taken);
      taken.push(name);
      const color = freeColor(r.color, colors);
      colors.push(color);
      return {
        id: slugify(name),
        name,
        roleId: r.id,
        color,
        mode: "sandbox",
        account: "",
        workspacePath: null,
        sandbox: defaultSandbox(),
        mcp: [],
      } satisfies Seat;
    }),
  );
}

/** The role a seat fills; its CLI, model, skills and role text come from here. */
export function roleOf(t: TeamTemplate, seat: Pick<Seat, "roleId">): Role {
  const r = t.roles.find((x) => x.id === seat.roleId);
  if (!r) throw new TemplateError(`No role "${seat.roleId}" in template "${t.id}".`);
  return r;
}

const SEAT_KEYS = ["id", "name", "roleId", "color", "mode", "nextMode", "account", "workspacePath", "sandbox", "mcp"] as const;

/** What config.json keeps of an agent in a template project. */
export function seatOf(a: AgentConfig): Seat {
  const s = Object.fromEntries(SEAT_KEYS.map((k) => [k, a[k]])) as unknown as Seat;
  return { ...s, account: a.account ?? "", mcp: a.mcp ?? [] };
}

/**
 * A mode change for a seat: applied now when its session is down, else kept as `nextMode` for its next start, so a
 * running agent never changes mode mid-task (docs/agent-engine.md section 9).
 */
export function changeMode(seat: Seat, mode: Seat["mode"], running: boolean) {
  if (!running || mode === seat.mode) {
    seat.mode = mode;
    delete seat.nextMode;
  } else seat.nextMode = mode;
}

/** The agent HQ runs for a seat: the seat plus its role's title, CLI, model, skills and role text. */
export function resolveSeat(t: TeamTemplate, seat: Seat): AgentConfig {
  const r = roleOf(t, seat);
  return { ...seat, role: r.title, isLead: r.isLead, cli: r.cli, model: r.model, skills: [...r.skills], roleMd: r.roleMd };
}

/** Until gates replace it (step 5): a flow that waits for a merged PR works in pull requests. */
export const flowMode = (t: TeamTemplate): WorkflowMode =>
  t.flow.stages.some((s) => s.gates.some((g) => g.kind === "pr-merged")) ? "github-pr" : "deliverables";

/** Puts a project on its template: rules, workflow mode and every seat resolved from it. */
export function applyTemplate(cfg: HqConfig, t: TeamTemplate) {
  cfg.template = t;
  cfg.rules = t.rules;
  cfg.workflow.mode = flowMode(t);
  // In place: other parts of HQ hold these agent objects.
  for (const a of cfg.team) Object.assign(a, resolveSeat(t, seatOf(a)));
}
