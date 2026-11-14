// Security findings for an engagement: what agents reported (report_finding), triaged here.
// The same list is written to deliverables/security-report.md in the repo.
import { useState } from "react";
import { FINDING_STATUSES, SEVERITIES, type Finding, type Severity } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ago, SectionTitle, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";

export const SEVERITY_COLOR: Record<Severity, string> = { critical: "#ff2a4b", high: "#ff7a1a", medium: "#ffb020", low: "#818cf8", info: "#8b9bb4" };

const closed = (f: Finding) => f.status === "fixed" || f.status === "accepted" || f.status === "false-positive";

export function FindingsDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(30_000);
  const [hideClosed, setHideClosed] = useState(true);
  const [only, setOnly] = useState<Severity | null>(null);
  if (!snap) return null;
  const all = snap.findings ?? [];
  const open = all.filter((f) => !closed(f));
  const list = all
    .filter((f) => (!hideClosed || !closed(f)) && (!only || f.severity === only))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.at.localeCompare(a.at));
  const locked = isViewer || !snap.config.template;
  const name = (id: string) => snap.config.team.find((a) => a.id === id)?.name ?? id;

  return (
    <>
      <DrawerHeader>
        <b className="font-display text-[19px] font-semibold">Findings</b>
        <span className="text-[13px] text-muted">
          {open.length} open of {all.length}
        </span>
      </DrawerHeader>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 min-[1100px]:flex-row min-[1100px]:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="grid grid-cols-5 gap-2" role="group" aria-label="Open findings by severity">
            {SEVERITIES.map((sev) => {
              const n = open.filter((f) => f.severity === sev).length;
              const on = only === sev;
              return (
                <button
                  key={sev}
                  className={`hud-glass hud-scan flex flex-col items-start gap-1 rounded-xl px-3 py-2.5 text-left transition-colors ${on ? "hud-corners bg-white/[0.06]" : "hover:border-white/25"}`}
                  style={{ ["--corner" as string]: SEVERITY_COLOR[sev], borderColor: on ? SEVERITY_COLOR[sev] : undefined, boxShadow: `inset 0 3px 0 ${SEVERITY_COLOR[sev]}${n ? `, 0 0 18px ${SEVERITY_COLOR[sev]}22` : ""}` }}
                  aria-pressed={on}
                  onClick={() => setOnly(on ? null : sev)}
                  title={on ? "Show every severity" : `Show only ${sev}`}
                >
                  <b className="font-display text-[28px] font-semibold leading-none" style={{ color: n ? SEVERITY_COLOR[sev] : undefined, textShadow: n ? `0 0 12px ${SEVERITY_COLOR[sev]}66` : undefined }}>
                    {n}
                  </b>
                  <span className="text-[12px] capitalize text-muted">{sev}</span>
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} /> Hide fixed, accepted and false positives
          </label>
          {list.length === 0 ? (
            <p className="m-0 rounded-xl border border-white/[0.08] px-4 py-6 text-center text-[14px] text-muted">
              {all.length ? "Nothing here with this filter." : "No findings yet. Agents add them with report_finding as they test in-scope targets."}
            </p>
          ) : (
            <div className="hud-glass overflow-x-auto rounded-xl">
              <table className="w-full border-collapse text-left text-[13px]">
                <thead className="bg-navy/70 text-[12px] text-muted">
                  <tr>
                    <th className="w-px whitespace-nowrap px-3 py-2 font-medium">Severity</th>
                    <th className="px-3 py-2 font-medium">Finding</th>
                    <th className="w-px px-3 py-2 font-medium">Status</th>
                    <th className="w-px px-3 py-2 font-medium">Verified</th>
                    <th className="w-px px-3 py-2 font-medium">Agent</th>
                    <th className="w-px px-3 py-2 text-right font-medium">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((f) => (
                    <FindingRow key={f.id} f={f} now={now} locked={locked} reporter={name(f.reporterId)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <ScopePanel snap={snap} />
      </div>
    </>
  );
}

/** What may be tested, the rules, and the report: beside the table on wide screens, above it on narrow ones. */
function ScopePanel({ snap }: { snap: NonNullable<ReturnType<typeof useOffice.getState>["snap"]> }) {
  const scope = snap.config.project.scope;
  const hosts = (label: string, list: string[] | undefined, tone: string) => (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-muted">{label}</span>
      {list?.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {list.map((h) => (
            <li key={h} className={`rounded-md border px-1.5 font-term text-[12px] ${tone}`}>
              {h}
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-[12px] text-muted">None</span>
      )}
    </div>
  );
  return (
    <aside className="hud-glass hud-corners flex shrink-0 flex-col gap-3 rounded-xl p-3.5 min-[1100px]:w-[280px]" aria-label="Scope and report">
      <b className="font-display text-[15px] font-semibold">Scope</b>
      {scope ? (
        <>
          {hosts("In scope", scope.inScope, "border-green/30 text-green")}
          {hosts("Out of scope", scope.outOfScope, "border-red/30 text-red")}
          {scope.rules && (
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted">Rules of engagement</span>
              <p className="m-0 whitespace-pre-wrap text-[12px]">{scope.rules}</p>
            </div>
          )}
        </>
      ) : (
        <p className="m-0 text-[12px] text-muted">Not set. Agents can't test anything until it is: Settings → Project.</p>
      )}
      <div className="flex flex-col gap-1.5 border-t border-white/[0.08] pt-3">
        <b className="font-display text-[15px] font-semibold">Report</b>
        <span className="font-term text-[12px] text-muted">deliverables/security-report.md</span>
        {snap.config.template && <Exports projectId={snap.config.project.id} />}
      </div>
    </aside>
  );
}

const EXPORTS: { format: string; label: string }[] = [
  { format: "html", label: "Report (print to PDF)" },
  { format: "markdown", label: "Markdown" },
  { format: "json", label: "JSON" },
  { format: "sarif", label: "SARIF" },
  { format: "hackerone", label: "HackerOne" },
  { format: "bugcrowd", label: "Bugcrowd" },
];

/** Fetches an export with the session's token in the request, never in a link, then saves or opens it. */
async function exportFindings(projectId: string, format: string) {
  let tok = "";
  try {
    tok = sessionStorage.getItem("hq-token") ?? "";
  } catch {
    /* storage blocked: the cookie still signs the request */
  }
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/findings/export?format=${format}`, {
    credentials: "same-origin",
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });
  if (!r.ok) return;
  const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? `findings.${format}`;
  const url = URL.createObjectURL(await r.blob());
  if (format === "html") window.open(url, "_blank", "noopener");
  else Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Exports({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="text-muted">Export</span>
      {EXPORTS.map((e) => (
        <button key={e.format} className="btn px-2 py-0.5 text-[12px]" onClick={() => void exportFindings(projectId, e.format)}>
          {e.label}
        </button>
      ))}
    </div>
  );
}

function Ids({ label, list }: { label: string; list: string[] }) {
  return list.length ? (
    <span>
      <b className="text-muted">{label}</b> <span className="font-term">{list.join(", ")}</span>
    </span>
  ) : null;
}

/** One table row; click it for the details, severity and evidence underneath. `locked`: a viewer, or a project made before templates. */
function FindingRow({ f, now, reporter, locked }: { f: Finding; now: number; reporter: string; locked: boolean }) {
  const [open, setOpen] = useState(false);
  const where = f.location ? `${f.location.file}${f.location.startLine ? `:${f.location.startLine}` : ""}` : f.asset.value;
  const color = SEVERITY_COLOR[f.severity];
  return (
    <>
      <tr className={`border-t border-white/[0.06] align-top ${closed(f) ? "opacity-60" : ""} ${open ? "bg-white/[0.03]" : "hover:bg-white/[0.02]"}`}>
        <td className="px-3 py-2" style={{ boxShadow: `inset 3px 0 0 ${color}` }}>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[12px] font-medium capitalize" style={{ color, borderColor: `${color}55` }}>
            {f.severity}
            {f.cvss && <span className="font-term">{f.cvss.score.toFixed(1)}</span>}
          </span>
        </td>
        <td className="w-full max-w-0 px-3 py-2">
          <button className="flex w-full min-w-0 flex-col text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-term text-[12px] text-muted">{f.id}</span>
              <b className="truncate font-medium hover:underline">{f.title}</b>
            </span>
            <span className="truncate font-term text-[12px] text-muted">{where}</span>
          </button>
        </td>
        <td className="px-3 py-2">
          <select
            className="field h-7 w-[124px] py-0 text-[12px]"
            value={f.status}
            disabled={locked}
            aria-label={`${f.id} status`}
            onChange={(e) => officeActions.updateFinding(f.id, { status: e.target.value as Finding["status"] })}
          >
            {FINDING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </td>
        <td className="px-3 py-2">
          <input type="checkbox" className="mt-1.5" checked={f.verified} disabled={locked} aria-label={`${f.id} verified`} onChange={(e) => officeActions.updateFinding(f.id, { verified: e.target.checked })} />
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-muted">{reporter}</td>
        <td className="whitespace-nowrap px-3 py-2 text-right font-term text-[12px] text-muted">{ago(f.at, now)}</td>
      </tr>
      {open && (
        <tr className="bg-white/[0.03]">
          <td colSpan={6} className="px-4 pb-4 pt-1">
            <div className="flex flex-col gap-2 text-[13px]">
              <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                <label className="flex items-center gap-1.5">
                  <span className="text-muted">Severity</span>
                  <select
                    className="field h-7 w-[110px] py-0 text-[12px]"
                    value={f.severity}
                    disabled={locked || !!f.cvss}
                    title={f.cvss ? "Follows the CVSS score" : undefined}
                    aria-label={`${f.id} severity`}
                    onChange={(e) => officeActions.updateFinding(f.id, { severity: e.target.value as Severity })}
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <Ids label="CWE" list={f.cwe} />
                <Ids label="ATT&CK" list={f.attack} />
                <Ids label="D3FEND" list={f.d3fend} />
                <Ids label="WSTG" list={f.wstg ? [f.wstg] : []} />
                {f.ssvc && (
                  <span>
                    <b className="text-muted">SSVC</b> {f.ssvc.decision}
                  </span>
                )}
              </p>
              {f.cvss && <p className="m-0 break-all font-term text-[12px] text-muted">{f.cvss.vector}</p>}
              <section>
                <SectionTitle>Description</SectionTitle>
                <p className="whitespace-pre-wrap">{f.description || "None"}</p>
              </section>
              {f.impact && (
                <section>
                  <SectionTitle>Impact</SectionTitle>
                  <p className="whitespace-pre-wrap">{f.impact}</p>
                </section>
              )}
              <section>
                <SectionTitle>Evidence</SectionTitle>
                {f.evidence.length ? (
                  f.evidence.map((e, i) => (
                    <div key={i} className="mb-1.5">
                      <span className="text-[12px] italic text-muted">{e.kind}</span>
                      <pre className="scroll-thin max-h-[300px] overflow-auto whitespace-pre-wrap rounded-lg bg-navy-2 p-2 font-term text-[12px]">{e.content}</pre>
                    </div>
                  ))
                ) : (
                  <p className="text-muted">None</p>
                )}
              </section>
              <section>
                <SectionTitle>Remediation</SectionTitle>
                <p className="whitespace-pre-wrap">{f.remediation || "None"}</p>
              </section>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
