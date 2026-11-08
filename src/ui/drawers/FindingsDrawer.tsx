// Security findings for an engagement: what agents reported (report_finding), triaged here.
// The same list is written to deliverables/security-report.md in the repo.
import { useState } from "react";
import { FINDING_STATUSES, SEVERITIES, type Finding, type Severity } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ago, SectionTitle, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";

export const SEVERITY_COLOR: Record<Severity, string> = { critical: "#ff1744", high: "#ff6d00", medium: "#ffd600", low: "#00e5ff", info: "#9da9c4" };

export function FindingsDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(30_000);
  const [hideClosed, setHideClosed] = useState(true);
  if (!snap) return null;
  const all = snap.findings ?? [];
  const closed = (f: Finding) => f.status === "fixed" || f.status === "accepted" || f.status === "false-positive";
  const list = [...all].filter((f) => !hideClosed || !closed(f)).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.at.localeCompare(a.at));
  const scope = snap.config.project.scope;
  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Findings</b>
        <span className="flex flex-wrap gap-1">
          {SEVERITIES.map((s) => {
            const n = all.filter((f) => f.severity === s && !closed(f)).length;
            return n ? (
              <span key={s} className="chip text-[11px]" style={{ ["--c" as string]: SEVERITY_COLOR[s] }}>
                {n} {s}
              </span>
            ) : null;
          })}
        </span>
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-[12px] text-muted">
          In scope: <span className="font-mono">{scope?.inScope.join(", ") || "not set (Settings → Project)"}</span>. Report: <span className="font-mono">deliverables/security-report.md</span>
        </p>
        <label className="mb-3 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} /> Hide fixed, accepted and false positives
        </label>
        {list.length === 0 && <p className="text-[14px] text-muted">{all.length ? "Nothing open." : "No findings yet. Agents add them with report_finding as they test in-scope targets."}</p>}
        <ul className="flex flex-col gap-2">
          {list.map((f) => (
            <FindingRow key={f.id} f={f} now={now} reporter={snap.config.team.find((a) => a.id === f.reporterId)?.name ?? f.reporterId} />
          ))}
        </ul>
      </div>
    </>
  );
}

function FindingRow({ f, now, reporter }: { f: Finding; now: number; reporter: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-2 border-ink bg-[#111520] px-2.5 py-2" style={{ borderLeft: `5px solid ${SEVERITY_COLOR[f.severity]}` }}>
      <button className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className="font-mono text-[12px] text-muted">{f.id}</span>
        <b className="min-w-0 flex-1 text-[14px]">{f.title}</b>
        <span className="font-mono text-[11px]" style={{ color: SEVERITY_COLOR[f.severity] }}>
          {f.severity}
        </span>
      </button>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <span className="font-mono">{f.target}</span>· {reporter} · {ago(f.at, now)} ago
        <select
          className="field ml-auto py-0 text-[12px]"
          value={f.status}
          disabled={isViewer}
          aria-label={`${f.id} status`}
          onChange={(e) => officeActions.updateFinding(f.id, { status: e.target.value as Finding["status"] })}
        >
          {FINDING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="field py-0 text-[12px]"
          value={f.severity}
          disabled={isViewer}
          aria-label={`${f.id} severity`}
          onChange={(e) => officeActions.updateFinding(f.id, { severity: e.target.value as Severity })}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2 text-[13px]">
          <section>
            <SectionTitle>Description</SectionTitle>
            <p className="whitespace-pre-wrap">{f.description || "—"}</p>
          </section>
          <section>
            <SectionTitle>Evidence</SectionTitle>
            <pre className="scroll-thin max-h-[300px] overflow-auto whitespace-pre-wrap bg-[#04060a] p-2 font-mono text-[12px]">{f.evidence || "—"}</pre>
          </section>
          <section>
            <SectionTitle>Remediation</SectionTitle>
            <p className="whitespace-pre-wrap">{f.remediation || "—"}</p>
          </section>
        </div>
      )}
    </li>
  );
}
