// Security findings for an engagement (docs/core-model.md section 5): agents file them with the Team
// MCP tool report_finding (in-scope assets only); you and the lead triage and verify them. Template
// projects keep them in the HQ database; projects made before templates show theirs read-only.
// Every change rewrites <repo>/deliverables/security-report.md, so the report is versioned with the repo.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { ASSET_KINDS, EVIDENCE_KINDS, type AssetKind, type EvidenceKind, type Finding, type Ssvc } from "../src/data/model";
import { FINDING_STATUSES, SEVERITIES, type FindingStatus, type Severity } from "../src/data/types";
import { redactor } from "./credentials/registry";
import { scoreCvss4, severityOf } from "./cvss";
import type { Hub } from "./hub";
import { legacyFindings } from "./legacy";
import { hqDb } from "./lib/db";
import { log } from "./lib/log";
import { renderMarkdown } from "./reports";
import { checkScope } from "./scope";

export const FINDINGS_REPORT = join("deliverables", "security-report.md");
const REPORT = FINDINGS_REPORT;
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
/** Network assets must be in scope; code, cloud and app findings name things scope doesn't list. */
const NETWORK: ReadonlySet<AssetKind> = new Set(["url", "host", "ip"]);
const ID_RULES: Record<"cwe" | "attack" | "d3fend", [RegExp, string]> = {
  cwe: [/^CWE-\d{1,5}$/, "CWE-89"],
  attack: [/^T\d{4}(\.\d{3})?$/, "T1190 or T1059.001"],
  d3fend: [/^D3-[A-Z0-9]{2,12}$/, "D3-IAA"],
};
const WSTG = /^WSTG-[A-Z]{4}-\d{2}$/;
const SSVC: { [K in keyof Ssvc]: readonly Ssvc[K][] } = {
  exploitation: ["none", "poc", "active"],
  automatable: [true, false],
  technicalImpact: ["partial", "total"],
  decision: ["track", "track*", "attend", "act"],
};

function atomicWrite(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function idList(kind: keyof typeof ID_RULES, raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => clip(x, 20).toUpperCase()).filter(Boolean);
  const [re, example] = ID_RULES[kind];
  const bad = list.filter((x) => !re.test(x));
  if (bad.length) throw new Error(`${kind} ids look like ${example}; not ${bad.join(", ")}.`);
  return [...new Set(list)].slice(0, 20);
}

function ssvcOf(raw: unknown): Ssvc | null {
  if (raw === undefined || raw === null) return null;
  const v = raw as Record<string, unknown>;
  for (const k of Object.keys(SSVC) as (keyof Ssvc)[])
    if (!(SSVC[k] as readonly unknown[]).includes(v[k])) throw new Error(`SSVC ${k} is one of ${SSVC[k].join(", ")}.`);
  return { exploitation: v.exploitation, automatable: v.automatable, technicalImpact: v.technicalImpact, decision: v.decision } as Ssvc;
}

function evidenceOf(raw: unknown): Finding["evidence"] {
  const items = typeof raw === "string" ? [{ kind: "note", content: raw }] : Array.isArray(raw) ? raw : [];
  return items
    .map((e) => ({
      kind: (EVIDENCE_KINDS as readonly string[]).includes((e as { kind?: string }).kind ?? "") ? ((e as { kind: EvidenceKind }).kind) : "note",
      content: redactor().redact(clip((e as { content?: unknown }).content, 16000)),
    }))
    .filter((e) => e.content)
    .slice(0, 30);
}

// ---------------------------------------------------------------- storage

interface Row {
  id: string; task_id: string | null; reporter_id: string; title: string; asset_kind: AssetKind; asset_value: string; location: string | null;
  cvss_vector: string | null; cvss_score: number | null; severity: Severity; ssvc: string | null; cwe: string; attack: string; d3fend: string;
  wstg: string | null; description: string; impact: string; remediation: string; evidence: string; verified: number; verified_by: string | null;
  status: FindingStatus; at: number; updated_at: number;
}

export function loadFindings(db: DatabaseSync, projectId: string): Finding[] {
  return (db.prepare("SELECT * FROM findings WHERE project_id = ? ORDER BY id").all(projectId) as unknown as Row[]).map((r) => ({
    id: r.id, projectId, taskId: r.task_id, reporterId: r.reporter_id, title: r.title,
    asset: { kind: r.asset_kind, value: r.asset_value }, location: r.location ? JSON.parse(r.location) : null,
    cvss: r.cvss_vector && r.cvss_score !== null ? { vector: r.cvss_vector, score: r.cvss_score } : null, severity: r.severity,
    ssvc: r.ssvc ? JSON.parse(r.ssvc) : null, cwe: JSON.parse(r.cwe), attack: JSON.parse(r.attack), d3fend: JSON.parse(r.d3fend), wstg: r.wstg,
    description: r.description, impact: r.impact, remediation: r.remediation, evidence: JSON.parse(r.evidence),
    verified: !!r.verified, verifiedBy: r.verified_by, status: r.status, at: new Date(r.at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export function saveFinding(db: DatabaseSync, f: Finding) {
  db.prepare(
    `INSERT INTO findings (project_id, id, task_id, reporter_id, title, asset_kind, asset_value, location, cvss_vector, cvss_score, severity, ssvc, cwe, attack, d3fend, wstg, description, impact, remediation, evidence, verified, verified_by, status, at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, id) DO UPDATE SET title = excluded.title, location = excluded.location, cvss_vector = excluded.cvss_vector, cvss_score = excluded.cvss_score,
       severity = excluded.severity, ssvc = excluded.ssvc, cwe = excluded.cwe, attack = excluded.attack, d3fend = excluded.d3fend, wstg = excluded.wstg, impact = excluded.impact,
       remediation = excluded.remediation, verified = excluded.verified, verified_by = excluded.verified_by, status = excluded.status, updated_at = excluded.updated_at`,
  ).run(
    f.projectId, f.id, f.taskId, f.reporterId, f.title, f.asset.kind, f.asset.value, f.location ? JSON.stringify(f.location) : null, f.cvss?.vector ?? null, f.cvss?.score ?? null,
    f.severity, f.ssvc ? JSON.stringify(f.ssvc) : null, JSON.stringify(f.cwe), JSON.stringify(f.attack), JSON.stringify(f.d3fend), f.wstg, f.description, f.impact, f.remediation,
    JSON.stringify(f.evidence), f.verified ? 1 : 0, f.verifiedBy, f.status, Date.parse(f.at), Date.parse(f.updatedAt),
  );
}

// ---------------------------------------------------------------- the project's findings

export class Findings {
  constructor(private hub: Hub) {
    const cfg = hub.snap.config;
    try {
      hub.snap.findings = cfg.template ? loadFindings(hqDb(), cfg.project.id) : legacyFindings(hub.repo.root, cfg.project.id);
    } catch (err) {
      log.warn(`couldn't read findings: ${err instanceof Error ? err.message : err}`);
      hub.snap.findings = [];
    }
  }

  private get list(): Finding[] {
    return (this.hub.snap.findings ??= []);
  }

  private writable() {
    if (!this.hub.snap.config.template) throw new Error("This project was made before templates and is read-only.");
  }

  private save(f: Finding) {
    saveFinding(hqDb(), f);
    const { name, scope } = this.hub.snap.config.project;
    const report = renderMarkdown({ project: name, scope, findings: this.list, name: (id) => this.hub.name(id), generatedAt: new Date().toISOString() });
    atomicWrite(join(this.hub.repo.root, REPORT), report);
    this.hub.emit({ type: "finding.updated", finding: structuredClone(f) });
  }

  /** From an agent. Refused when the project isn't security work or a network asset is out of scope. */
  report(reporterId: string, taskId: string | null, input: Record<string, unknown>): Finding {
    this.writable();
    const { project, rules } = this.hub.snap.config;
    if (!rules.findings) throw new Error("This project isn't security work, so findings aren't tracked here. Write it as a deliverable instead.");
    const rawAsset = (input.asset ?? {}) as { kind?: unknown; value?: unknown };
    const kind = (ASSET_KINDS as readonly unknown[]).includes(rawAsset.kind) ? (rawAsset.kind as AssetKind) : null;
    const value = clip(rawAsset.value, 300);
    if (!kind || !value) throw new Error(`Name the asset: kind (${ASSET_KINDS.join(", ")}) and value.`);
    if (NETWORK.has(kind)) {
      const s = checkScope(project.scope, value);
      if (!s.ok) {
        this.hub.activity("scope.refused", reporterId, `${this.hub.name(reporterId)} tried to report on ${value}: refused, ${s.why}`);
        throw new Error(`Not recorded: ${s.why} Only report findings on in-scope targets.`);
      }
    }
    const title = clip(input.title, 160);
    if (!title) throw new Error("Give the finding a short title.");
    const cvss = typeof input.cvss === "string" && input.cvss.trim() ? scoreCvss4(input.cvss) : null;
    const severity = cvss ? severityOf(cvss.score) : SEVERITIES.includes(input.severity as Severity) ? (input.severity as Severity) : "info";
    const loc = input.location as { file?: unknown; startLine?: unknown; endLine?: unknown } | undefined;
    const line = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
    const wstg = clip(input.wstg, 20).toUpperCase() || null;
    if (wstg && !WSTG.test(wstg)) throw new Error(`WSTG ids look like WSTG-INPV-05; not ${wstg}.`);
    const n = Math.max(0, ...this.list.map((f) => Number(f.id.slice(2)) || 0)) + 1;
    const now = new Date().toISOString();
    const f: Finding = {
      id: `F-${String(n).padStart(3, "0")}`, projectId: project.id, taskId, reporterId, title,
      asset: { kind, value }, location: loc?.file ? { file: clip(loc.file, 300), startLine: line(loc.startLine), endLine: line(loc.endLine) } : null,
      cvss, severity, ssvc: ssvcOf(input.ssvc), cwe: idList("cwe", input.cwe), attack: idList("attack", input.attack), d3fend: idList("d3fend", input.d3fend), wstg,
      description: redactor().redact(clip(input.description, 8000)), impact: redactor().redact(clip(input.impact, 4000)), remediation: clip(input.remediation, 4000),
      evidence: evidenceOf(input.evidence), verified: false, verifiedBy: null, status: "open", at: now, updatedAt: now,
    };
    this.list.push(f);
    this.save(f);
    this.hub.activity(severity === "critical" || severity === "high" ? "agent.needs-input" : "message", reporterId, `${this.hub.name(reporterId)} reported ${f.id} (${severity}${cvss ? ` ${cvss.score}` : ""}): ${title}`);
    return f;
  }

  /** From you or the lead: triage, verification, scoring and text. */
  update(id: string, patch: Record<string, unknown>, byId = "you"): Finding {
    this.writable();
    const f = this.list.find((x) => x.id === id);
    if (!f) throw new Error(`No finding ${id}.`);
    if (typeof patch.cvss === "string") {
      f.cvss = patch.cvss.trim() ? scoreCvss4(patch.cvss) : null;
      if (f.cvss) f.severity = severityOf(f.cvss.score);
    }
    if (SEVERITIES.includes(patch.severity as Severity)) {
      if (f.cvss) throw new Error(`${f.id} is scored (CVSS ${f.cvss.score}); its severity follows the score. Change the vector instead.`);
      f.severity = patch.severity as Severity;
    }
    if (FINDING_STATUSES.includes(patch.status as FindingStatus)) f.status = patch.status as FindingStatus;
    if (typeof patch.verified === "boolean") {
      f.verified = patch.verified;
      f.verifiedBy = patch.verified ? byId : null;
    }
    if (patch.ssvc !== undefined) f.ssvc = ssvcOf(patch.ssvc);
    if (typeof patch.title === "string" && patch.title.trim()) f.title = clip(patch.title, 160);
    if (typeof patch.remediation === "string") f.remediation = clip(patch.remediation, 4000);
    if (typeof patch.impact === "string") f.impact = redactor().redact(clip(patch.impact, 4000));
    f.updatedAt = new Date().toISOString();
    this.save(f);
    return f;
  }
}
