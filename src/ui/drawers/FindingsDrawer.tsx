// Security findings for an engagement: what agents reported (report_finding), triaged here.
// The same list is written to deliverables/security-report.md in the repo.
import { useState, type ReactNode } from "react";
import { FINDING_STATUSES, SEVERITIES, type Finding, type Severity } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ago, useNow } from "../kit";
import { Icon } from "../deck/Icon";
import { SlideOver } from "./SlideOver";
import { DrawerHeader, PageTitle } from "./Drawer";

export const SEVERITY_COLOR: Record<Severity, string> = { critical: "#ff2a4b", high: "#ff7a1a", medium: "#ffb020", low: "#818cf8", info: "#8b9bb4" };

const closed = (f: Finding) => f.status === "fixed" || f.status === "accepted" || f.status === "false-positive";

export function FindingsDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(30_000);
  const [hideClosed, setHideClosed] = useState(true);
  const [only, setOnly] = useState<Severity | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  if (!snap) return null;
  const all = snap.findings ?? [];
  const open = all.filter((f) => !closed(f));
  const list = all
    .filter((f) => (!hideClosed || !closed(f)) && (!only || f.severity === only))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.at.localeCompare(a.at));
  const locked = isViewer || !snap.config.template;
  const name = (id: string) => snap.config.team.find((a) => a.id === id)?.name ?? id;
  const current = all.find((f) => f.id === openId);
  const counts = SEVERITIES.map((sev) => ({ sev, n: open.filter((f) => f.severity === sev).length }));

  return (
    <>
      <DrawerHeader>
        <PageTitle title="Findings" context={<>{open.length} open of {all.length}{snap.config.project.scope ? "" : " · scope not set"}</>} />
        <span className="ml-auto flex items-center gap-2">
          <button className="btn text-[13px]" onClick={() => setScopeOpen(true)}>
            <Icon name="my_location" size={16} /> Scope
          </button>
          {snap.config.template && <ExportMenu projectId={snap.config.project.id} />}
        </span>
      </DrawerHeader>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        <section className="flex shrink-0 flex-col gap-2.5" aria-label="Open findings by severity">
          <div className="flex h-2 overflow-hidden rounded-full bg-cream-3" aria-hidden="true">
            {counts.map(({ sev, n }) => (n ? <span key={sev} style={{ flexGrow: n, background: SEVERITY_COLOR[sev] }} className="h-full border-r-2 border-[var(--surface-card)] last:border-r-0" /> : null))}
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by severity">
            {counts.map(({ sev, n }) => {
              const on = only === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setOnly(on ? null : sev)}
                  title={on ? "Show every severity" : `Show only ${sev}`}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${on ? "border-[var(--border-strong)] bg-cream-2" : "border-[var(--border-hairline)] hover:bg-cream-2/60"}`}
                >
                  <i className="h-2.5 w-2.5 rounded-full" style={{ background: SEVERITY_COLOR[sev] }} aria-hidden="true" />
                  <span className="capitalize text-ink">{sev}</span>
                  <span className="font-semibold text-ink">{n}</span>
                </button>
              );
            })}
            <label className="ml-auto flex items-center gap-2 text-[13px] text-muted">
              <input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} /> Hide fixed, accepted and false positives
            </label>
          </div>
        </section>
        {list.length === 0 ? (
          <p className="m-0 rounded-xl border border-[var(--border-hairline)] px-4 py-8 text-center text-[13px] text-muted">
            {all.length ? "Nothing here with this filter." : "No findings yet. Agents add them with report_finding as they test in-scope targets."}
          </p>
        ) : (
          <div className="shrink-0 overflow-x-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)]">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead className="border-b border-[var(--border-hairline)] text-[12px] text-muted">
                <tr>
                  <th className="w-px whitespace-nowrap px-4 py-2.5 font-medium">Severity</th>
                  <th className="px-3 py-2.5 font-medium">Finding</th>
                  <th className="w-px px-3 py-2.5 font-medium">Status</th>
                  <th className="w-px px-3 py-2.5 font-medium">Verified</th>
                  <th className="w-px px-3 py-2.5 font-medium">Agent</th>
                  <th className="w-px px-4 py-2.5 text-right font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <FindingRow key={f.id} f={f} now={now} reporter={name(f.reporterId)} selected={f.id === openId} onOpen={() => setOpenId(f.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {current && (
        <SlideOver title={<>{current.id} · {current.title}</>} onClose={() => setOpenId(null)} width={560}>
          <FindingDetail f={current} locked={locked} reporter={name(current.reporterId)} now={now} />
        </SlideOver>
      )}
      {scopeOpen && (
        <SlideOver title="Scope and rules of engagement" onClose={() => setScopeOpen(false)}>
          <ScopePanel snap={snap} />
        </SlideOver>
      )}
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
    <div className="flex flex-col gap-4" aria-label="Scope">
      {scope ? (
        <>
          {hosts("In scope", scope.inScope, "border-green/30 text-green")}
          {hosts("Out of scope", scope.outOfScope, "border-red/30 text-red")}
          {scope.rules && (
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted">Rules of engagement</span>
              <p className="m-0 whitespace-pre-wrap text-[13px] leading-6 text-ink">{scope.rules}</p>
            </div>
          )}
        </>
      ) : (
        <p className="m-0 text-[13px] text-muted">Not set. Agents can't test anything until it is.</p>
      )}
      <p className="m-0 border-t border-[var(--border-hairline)] pt-3 text-[12px] text-muted">The report is kept in the repo at deliverables/security-report.md. Edit the scope in Settings → Project.</p>
    </div>
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

/** Export is the page's main action: one button, the formats in its menu. */
function ExportMenu({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <button className="btn btn-primary text-[13px]" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="download" size={16} /> Export report
      </button>
      {open && (
        <ul role="menu" className="absolute right-0 z-30 m-0 mt-1 w-56 list-none rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-1 shadow-[var(--card-shadow-hover)]">
          {EXPORTS.map((e) => (
            <li key={e.format} role="none">
              <button role="menuitem" className="w-full rounded-md px-3 py-2 text-left text-[13px] text-ink hover:bg-cream-2" onClick={() => (setOpen(false), void exportFindings(projectId, e.format))}>
                {e.label}
              </button>
            </li>
          ))}
        </ul>
      )}
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

const STATUS_TONE: Record<string, string> = { confirmed: "var(--color-red)", open: "var(--color-amber)", fixed: "#16a34a", accepted: "var(--color-muted)", "false-positive": "var(--color-muted)" };

/** One table row; click it for the finding in the slide-over. */
function FindingRow({ f, now, reporter, selected, onOpen }: { f: Finding; now: number; reporter: string; selected: boolean; onOpen: () => void }) {
  const where = f.location ? `${f.location.file}${f.location.startLine ? `:${f.location.startLine}` : ""}` : f.asset.value;
  const color = SEVERITY_COLOR[f.severity];
  return (
    <tr
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className={`cursor-pointer border-t border-[var(--border-hairline)] align-middle outline-none ${closed(f) ? "opacity-60" : ""} ${selected ? "bg-cream-2" : "hover:bg-cream-2/60 focus-visible:bg-cream-2"}`}
    >
      <td className="px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium capitalize text-ink">
          <i className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden="true" />
          {f.severity}
          {f.cvss && <span className="text-muted">{f.cvss.score.toFixed(1)}</span>}
        </span>
      </td>
      <td className="w-full max-w-0 px-3 py-2.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[12px] text-muted">{f.id}</span>
          <span className="truncate font-medium text-ink">{f.title}</span>
        </span>
        <span className="block truncate text-[12px] text-muted">{where}</span>
      </td>
      <td className="px-3 py-2.5">
        <span className="chip whitespace-nowrap capitalize" style={{ ["--c" as string]: STATUS_TONE[f.status] ?? "var(--color-muted)" }}>
          {f.status.replace("-", " ")}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {f.verified ? (
          <span className="flex items-center gap-1 text-[12px] text-green">
            <Icon name="verified" size={16} /> Yes
          </span>
        ) : (
          <span className="text-[12px] text-muted">Not yet</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-muted">{reporter}</td>
      <td className="whitespace-nowrap px-4 py-2.5 text-right text-[12px] text-muted">{ago(f.at, now)}</td>
    </tr>
  );
}

/** The finding in full: triage controls, then Description, Impact, Evidence, Remediation. `locked`: a viewer, or a project made before templates. */
function FindingDetail({ f, locked, reporter, now }: { f: Finding; locked: boolean; reporter: string; now: number }) {
  const where = f.location ? `${f.location.file}${f.location.startLine ? `:${f.location.startLine}` : ""}` : f.asset.value;
  const field = "field h-8 py-0 text-[13px]";
  const block = (title: string, body: ReactNode) => (
    <section>
      <h3 className="m-0 mb-1.5 text-[13px] font-semibold text-ink">{title}</h3>
      {body}
    </section>
  );
  return (
    <div className="flex flex-col gap-5 text-[13px]">
      <p className="m-0 text-[12px] text-muted">
        {where} · reported by {reporter} {ago(f.at, now)} ago
      </p>
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Severity
          <select className={field} value={f.severity} disabled={locked || !!f.cvss} title={f.cvss ? "Follows the CVSS score" : undefined} onChange={(e) => officeActions.updateFinding(f.id, { severity: e.target.value as Severity })}>
            {SEVERITIES.map((sv) => (
              <option key={sv} value={sv}>
                {sv}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Status
          <select className={field} value={f.status} disabled={locked} onChange={(e) => officeActions.updateFinding(f.id, { status: e.target.value as Finding["status"] })}>
            {FINDING_STATUSES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-1.5 text-[13px] text-ink">
          <input type="checkbox" checked={f.verified} disabled={locked} onChange={(e) => officeActions.updateFinding(f.id, { verified: e.target.checked })} /> Verified
        </label>
      </div>
      {(f.cvss || f.cwe.length > 0 || f.attack.length > 0 || f.ssvc || f.wstg || f.d3fend.length > 0) && (
        <div className="flex flex-col gap-1 rounded-lg bg-cream-2/70 px-3 py-2 text-[12px]">
          {f.cvss && (
            <span>
              <b className="text-muted">CVSS</b> {f.cvss.score.toFixed(1)} <span className="break-all text-muted">{f.cvss.vector}</span>
            </span>
          )}
          <span className="flex flex-wrap gap-x-3">
            <Ids label="CWE" list={f.cwe} />
            <Ids label="ATT&CK" list={f.attack} />
            <Ids label="D3FEND" list={f.d3fend} />
            <Ids label="WSTG" list={f.wstg ? [f.wstg] : []} />
            {f.ssvc && (
              <span>
                <b className="text-muted">SSVC</b> {f.ssvc.decision}
              </span>
            )}
          </span>
        </div>
      )}
      {block("Description", <p className="m-0 whitespace-pre-wrap leading-6 text-ink">{f.description || "None"}</p>)}
      {f.impact && block("Impact", <p className="m-0 whitespace-pre-wrap leading-6 text-ink">{f.impact}</p>)}
      {block(
        "Evidence",
        f.evidence.length ? (
          <div className="flex flex-col gap-2">
            {f.evidence.map((e, i) => (
              <div key={i}>
                <span className="text-[12px] text-muted">{e.kind}</span>
                <pre className="scroll-thin m-0 max-h-[300px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border-hairline)] bg-cream-2 p-2.5 font-term text-[12px] text-ink">{e.content}</pre>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-muted">None</p>
        ),
      )}
      {block("Fix", <p className="m-0 whitespace-pre-wrap leading-6 text-ink">{f.remediation || "None"}</p>)}
    </div>
  );
}
