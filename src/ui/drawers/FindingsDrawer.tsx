// Security findings for an engagement: CVSS 4.0 triage, scope-to-egress sync, and 6-format exports.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FINDING_STATUSES, SEVERITIES, type Finding, type Severity } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";
import { ago, useNow } from "../kit";
import { Select } from "../primitives/Select";
import { DrawerHeader, PageTitle } from "./Drawer";
import { SlideOver } from "./SlideOver";

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#f59e0b",
  low: "#38bdf8",
  info: "#94a3b8",
};

type ExportFormat = "html" | "markdown" | "hackerone" | "bugcrowd" | "json" | "sarif";

const EXPORTS: { value: ExportFormat; label: string; ext: string; mime: string }[] = [
  { value: "html", label: "HTML / PDF", ext: "html", mime: "text/html;charset=utf-8" },
  { value: "markdown", label: "Markdown", ext: "md", mime: "text/markdown;charset=utf-8" },
  { value: "hackerone", label: "HackerOne", ext: "hackerone.md", mime: "text/markdown;charset=utf-8" },
  { value: "bugcrowd", label: "Bugcrowd", ext: "bugcrowd.md", mime: "text/markdown;charset=utf-8" },
  { value: "json", label: "JSON", ext: "json", mime: "application/json;charset=utf-8" },
  { value: "sarif", label: "SARIF", ext: "sarif.json", mime: "application/sarif+json;charset=utf-8" },
];

interface ApiScope {
  inScope: string[];
  outOfScope: string[];
  notes: string;
}

interface RawSecurityFinding {
  id: string;
  projectId: string;
  title: string;
  target?: string;
  cwe?: string | string[] | null;
  cvssVector?: string | null;
  cvssScore?: number | null;
  severity?: string;
  status?: string;
  descriptionMarkdown?: string;
  reproductionMarkdown?: string;
  remediationMarkdown?: string;
  evidenceRefs?: string[];
  createdAt?: string;
  updatedAt?: string;
  // Also tolerate v1 Finding fields
  reporterId?: string;
  asset?: { kind: Finding["asset"]["kind"]; value: string };
  location?: Finding["location"];
  cvss?: { vector: string; score: number } | null;
  description?: string;
  impact?: string;
  remediation?: string;
  evidence?: Finding["evidence"];
  verified?: boolean;
  at?: string;
}

function authToken(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const tok = authToken();
  return {
    ...(extra ?? {}),
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
  };
}

function normalizeSeverity(raw?: string): Severity {
  const s = (raw ?? "info").toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low" || s === "info") return s;
  return "info";
}

function normalizeStatus(raw?: string): Finding["status"] {
  const s = (raw ?? "open").toLowerCase();
  if (s === "open" || s === "confirmed" || s === "fixed" || s === "accepted" || s === "false-positive") return s;
  return "open";
}

function normalizeApiFinding(raw: RawSecurityFinding): Finding {
  const cweList = Array.isArray(raw.cwe)
    ? raw.cwe.filter(Boolean)
    : typeof raw.cwe === "string" && raw.cwe.trim()
      ? raw.cwe.split(/[,\s]+/).filter(Boolean)
      : [];
  const cvss =
    raw.cvss ??
    (raw.cvssVector
      ? { vector: raw.cvssVector, score: typeof raw.cvssScore === "number" ? raw.cvssScore : 0 }
      : null);
  const evidence: Finding["evidence"] =
    raw.evidence ??
    [
      ...(raw.reproductionMarkdown ? [{ kind: "command" as const, content: raw.reproductionMarkdown }] : []),
      ...(raw.evidenceRefs ?? []).map((r) => ({ kind: "file" as const, content: r })),
    ];
  const at = raw.at ?? raw.createdAt ?? new Date().toISOString();
  return {
    id: raw.id,
    projectId: raw.projectId,
    taskId: null,
    reporterId: raw.reporterId ?? "hq",
    title: raw.title,
    asset: raw.asset ?? { kind: "url", value: raw.target ?? "in-scope target" },
    location: raw.location ?? null,
    cvss,
    severity: normalizeSeverity(raw.severity),
    ssvc: null,
    cwe: cweList,
    attack: [],
    d3fend: [],
    wstg: null,
    description: raw.description ?? raw.descriptionMarkdown ?? "",
    impact: raw.impact ?? "",
    remediation: raw.remediation ?? raw.remediationMarkdown ?? "",
    evidence,
    verified: Boolean(raw.verified || raw.status === "confirmed"),
    verifiedBy: null,
    status: normalizeStatus(raw.status),
    at,
    updatedAt: raw.updatedAt ?? at,
  };
}

function escapeHtmlText(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMockExport(projectName: string, findings: Finding[], format: ExportFormat): string {
  if (format === "json") {
    return JSON.stringify({ project: projectName, generatedAt: new Date().toISOString(), findings }, null, 2);
  }
  if (format === "sarif") {
    return JSON.stringify(
      {
        version: "2.1.0",
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        runs: [
          {
            tool: { driver: { name: "ArimaOps Security", version: "2.0.0" } },
            results: findings.map((f) => ({
              ruleId: f.cwe[0] ?? f.id,
              level: f.severity === "critical" || f.severity === "high" ? "error" : f.severity === "medium" ? "warning" : "note",
              message: { text: `${f.title}${f.cvss ? ` (CVSS 4.0 ${f.cvss.score.toFixed(1)})` : ""}` },
              locations: [{ physicalLocation: { artifactLocation: { uri: f.location?.file ?? f.asset.value } } }],
            })),
          },
        ],
      },
      null,
      2,
    );
  }
  if (format === "hackerone") {
    return findings
      .map(
        (f) =>
          `## [${f.severity.toUpperCase()}] ${f.title}\n\n- **Asset:** ${f.asset.value}\n- **CVSS 4.0:** ${f.cvss ? `${f.cvss.score.toFixed(1)} (${f.cvss.vector})` : "N/A"}\n- **Weakness:** ${f.cwe.join(", ") || "N/A"}\n\n### Summary\n${f.description || "N/A"}\n\n### Impact\n${f.impact || "N/A"}\n\n### Remediation\n${f.remediation || "N/A"}\n`,
      )
      .join("\n---\n\n");
  }
  if (format === "bugcrowd") {
    return findings
      .map(
        (f) =>
          `# ${f.title}\n\n**Priority:** ${f.severity.toUpperCase()} | **CVSS 4.0:** ${f.cvss ? f.cvss.score.toFixed(1) : "N/A"} | **Target:** ${f.asset.value}\n\n## Description\n${f.description || "N/A"}\n\n## Steps / Evidence\n${f.evidence[0]?.content || "See attached evidence"}\n\n## Recommended Fix\n${f.remediation || "N/A"}\n`,
      )
      .join("\n---\n\n");
  }
  if (format === "html") {
    const rows = findings
      .map(
        (f) =>
          `<section><h2>${escapeHtmlText(f.id)} · ${escapeHtmlText(f.title)}</h2><p><strong>Severity:</strong> ${escapeHtmlText(f.severity)}${f.cvss ? ` · <strong>CVSS 4.0:</strong> ${f.cvss.score.toFixed(1)} (${escapeHtmlText(f.cvss.vector)})` : ""}</p><p>${escapeHtmlText(f.description)}</p></section>`,
      )
      .join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtmlText(projectName)} Security Report</title></head><body><h1>${escapeHtmlText(projectName)} Security Findings</h1>${rows}</body></html>`;
  }
  // markdown
  return (
    `# ${projectName} — Security Findings Report\n\n` +
    findings
      .map(
        (f) =>
          `## ${f.id}: ${f.title}\n- **Severity:** ${f.severity}${f.cvss ? ` · **CVSS 4.0:** ${f.cvss.score.toFixed(1)} (\`${f.cvss.vector}\`)` : ""}\n- **Target:** \`${f.asset.value}\`\n- **CWE:** ${f.cwe.join(", ") || "—"}\n\n${f.description}\n\n**Remediation:** ${f.remediation || "—"}\n`,
      )
      .join("\n")
  );
}

const closed = (f: Finding) => f.status === "fixed" || f.status === "accepted" || f.status === "false-positive";

export function FindingsDrawer() {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const projectId = snap?.config.project.id ?? "";
  const now = useNow(30_000);
  const [hideClosed, setHideClosed] = useState(true);
  const [only, setOnly] = useState<Severity | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("sarif");
  const [exporting, setExporting] = useState(false);
  const [exportBanner, setExportBanner] = useState<{ format: ExportFormat; filename: string; preview?: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [liveFindings, setLiveFindings] = useState<Finding[] | null>(null);
  const [liveScope, setLiveScope] = useState<ApiScope | null>(null);

  const loadLiveSecurity = useCallback(async () => {
    if (!live || !projectId) return;
    try {
      const [fRes, sRes] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectId)}/findings`, {
          credentials: "same-origin",
          headers: authHeaders(),
        }).catch(() => null),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/scope`, {
          credentials: "same-origin",
          headers: authHeaders(),
        }).catch(() => null),
      ]);
      if (fRes?.ok) {
        const data = (await fRes.json()) as { findings?: RawSecurityFinding[] };
        if (Array.isArray(data.findings)) {
          setLiveFindings(data.findings.map(normalizeApiFinding));
        }
      }
      if (sRes?.ok) {
        const sc = (await sRes.json()) as Partial<ApiScope>;
        setLiveScope({
          inScope: Array.isArray(sc.inScope) ? sc.inScope : [],
          outOfScope: Array.isArray(sc.outOfScope) ? sc.outOfScope : [],
          notes: typeof sc.notes === "string" ? sc.notes : "",
        });
      }
    } catch {
      /* keep snapshot fallback */
    }
  }, [live, projectId]);

  useEffect(() => {
    void loadLiveSecurity();
  }, [loadLiveSecurity]);

  if (!snap) return null;

  const snapFindings = snap.findings ?? [];
  const all = live && liveFindings ? liveFindings : snapFindings;
  const open = all.filter((f) => !closed(f));
  const list = all
    .filter((f) => (!hideClosed || !closed(f)) && (!only || f.severity === only))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.at.localeCompare(a.at));
  const locked = isViewer || !snap.config.template;
  const name = (id: string) => snap.config.team.find((a) => a.id === id)?.name ?? id;
  const current = all.find((f) => f.id === openId);
  const counts = SEVERITIES.map((sev) => ({ sev, n: open.filter((f) => f.severity === sev).length }));

  const effectiveScope: ApiScope = live && liveScope
    ? liveScope
    : {
        inScope: snap.config.project.scope?.inScope ?? [],
        outOfScope: snap.config.project.scope?.outOfScope ?? [],
        notes: snap.config.project.scope?.rules ?? "",
      };

  const handleExport = async () => {
    setExportError(null);
    setExporting(true);
    const meta = EXPORTS.find((e) => e.value === exportFormat) ?? EXPORTS[0];
    try {
      if (live && projectId) {
        const r = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/findings/export?format=${encodeURIComponent(exportFormat)}`,
          {
            credentials: "same-origin",
            headers: authHeaders(),
          },
        );
        if (!r.ok) {
          throw new Error(`Export failed (HTTP ${r.status})`);
        }
        const filename =
          /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ??
          `${projectId}-findings.${meta.ext}`;
        const text = await r.text();
        const blob = new Blob([text], { type: meta.mime });
        const url = URL.createObjectURL(blob);
        if (exportFormat === "html") window.open(url, "_blank", "noopener");
        else Object.assign(document.createElement("a"), { href: url, download: filename }).click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setExportBanner({ format: exportFormat, filename, preview: text.slice(0, 600) });
      } else {
        const content = buildMockExport(snap.config.project.name, all, exportFormat);
        const filename = `${snap.config.project.id}-findings.${meta.ext}`;
        const blob = new Blob([content], { type: meta.mime });
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement("a"), { href: url, download: filename }).click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setExportBanner({ format: exportFormat, filename, preview: content.slice(0, 600) });
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const handlePatchFinding = async (findingId: string, patch: { severity?: Severity; status?: Finding["status"]; verified?: boolean; cvss?: string }) => {
    officeActions.updateFinding(findingId, patch);
    if (live && projectId) {
      try {
        const r = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/findings/${encodeURIComponent(findingId)}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              status: patch.status,
              severity: patch.severity,
              cvssVector: patch.cvss,
            }),
          },
        );
        if (r.ok) await loadLiveSecurity();
      } catch {
        /* fallback already dispatched */
      }
    }
  };

  return (
    <>
      <DrawerHeader>
        <PageTitle
          title="Findings"
          context={
            <>
              {open.length} open of {all.length}
              {effectiveScope.inScope.length > 0
                ? ` · Scope: ${effectiveScope.inScope.length} in / ${effectiveScope.outOfScope.length} out`
                : " · scope not set"}
            </>
          }
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className="btn text-[13px]" onClick={() => setScopeOpen(true)}>
            <Icon name="my_location" size={16} /> Scope
          </button>
          <div className="flex items-center gap-1.5">
            <Select
              size="sm"
              className="w-auto min-w-[138px]"
              value={exportFormat}
              aria-label="Export report format"
              options={EXPORTS.map((e) => ({ value: e.value, label: e.label }))}
              onChange={(v) => setExportFormat(v as ExportFormat)}
            />
            <button
              type="button"
              className="btn btn-primary text-[13px]"
              disabled={exporting}
              onClick={() => void handleExport()}
            >
              <Icon name="download" size={16} />
              {exporting ? "Exporting…" : "Export Report"}
            </button>
          </div>
        </div>
      </DrawerHeader>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
        {exportError && (
          <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
            {exportError}
          </div>
        )}
        {exportBanner && (
          <div
            className="flex flex-col gap-2 rounded-xl border border-[var(--accent)]/40 bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface-card))] p-3 text-[12px]"
            role="status"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-semibold text-ink">
                <Icon name="check_circle" size={16} className="text-green" />
                Exported {EXPORTS.find((e) => e.value === exportBanner.format)?.label} report ({exportBanner.filename})
              </span>
              <button
                type="button"
                className="cursor-pointer text-[12px] text-muted hover:text-ink"
                onClick={() => setExportBanner(null)}
              >
                Dismiss
              </button>
            </div>
            {exportBanner.preview && (
              <pre className="scroll-thin m-0 max-h-[120px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-2 font-term text-[12px] text-muted">
                {exportBanner.preview}
              </pre>
            )}
          </div>
        )}

        <section className="flex shrink-0 flex-col gap-2.5" aria-label="Open findings by severity">
          <div className="flex h-2 overflow-hidden rounded-full bg-cream-3" aria-hidden="true">
            {counts.map(({ sev, n }) =>
              n ? (
                <span
                  key={sev}
                  style={{ flexGrow: n, background: SEVERITY_COLOR[sev] }}
                  className="h-full border-r-2 border-[var(--surface-card)] last:border-r-0"
                />
              ) : null,
            )}
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
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
                    on ? "border-[var(--border-strong)] bg-cream-2" : "border-[var(--border-hairline)] hover:bg-cream-2/60"
                  }`}
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
            {all.length
              ? "Nothing here with this filter."
              : "No findings yet. Agents add them with report_finding as they test in-scope targets."}
          </p>
        ) : (
          <div className="shrink-0 overflow-x-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)]">
            <table className="w-full min-w-[680px] border-collapse text-left text-[13px]">
              <thead className="border-b border-[var(--border-hairline)] text-[12px] text-muted">
                <tr>
                  <th className="w-px whitespace-nowrap px-4 py-2.5 font-medium">Severity &amp; CVSS 4.0</th>
                  <th className="px-3 py-2.5 font-medium">Finding</th>
                  <th className="w-px px-3 py-2.5 font-medium">Status</th>
                  <th className="w-px px-3 py-2.5 font-medium">Verified</th>
                  <th className="w-px px-3 py-2.5 font-medium">Agent</th>
                  <th className="w-px px-4 py-2.5 text-right font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <FindingRow
                    key={f.id}
                    f={f}
                    now={now}
                    reporter={name(f.reporterId)}
                    selected={f.id === openId}
                    onOpen={() => setOpenId(f.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {current && (
        <SlideOver
          title={
            <>
              {current.id} · {current.title}
            </>
          }
          onClose={() => setOpenId(null)}
          width={580}
        >
          <FindingDetail
            f={current}
            locked={locked}
            reporter={name(current.reporterId)}
            now={now}
            onPatch={(patch) => void handlePatchFinding(current.id, patch)}
          />
        </SlideOver>
      )}
      {scopeOpen && (
        <SlideOver title="Scope & egress rules of engagement" onClose={() => setScopeOpen(false)} width={520}>
          <ScopePanel
            projectId={projectId}
            live={live}
            scope={effectiveScope}
            locked={isViewer}
            onSaved={(next) => {
              setLiveScope(next);
              officeActions.updateProject({
                scope: { inScope: next.inScope, outOfScope: next.outOfScope, rules: next.notes },
              });
            }}
          />
        </SlideOver>
      )}
    </>
  );
}

/** Scope viewer & editor synced to arima-proxy egress policy (with cloud IMDS always blocked). */
function ScopePanel({
  projectId,
  live,
  scope,
  locked,
  onSaved,
}: {
  projectId: string;
  live: boolean;
  scope: ApiScope;
  locked: boolean;
  onSaved: (next: ApiScope) => void;
}) {
  const [inScopeText, setInScopeText] = useState(scope.inScope.join("\n"));
  const [outOfScopeText, setOutOfScopeText] = useState(scope.outOfScope.join("\n"));
  const [notes, setNotes] = useState(scope.notes);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parseLines = (raw: string) =>
    raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleSave = async () => {
    setError(null);
    setSavedNotice(null);
    const next: ApiScope = {
      inScope: parseLines(inScopeText),
      outOfScope: parseLines(outOfScopeText),
      notes: notes.trim(),
    };
    setSaving(true);
    try {
      if (live && projectId) {
        const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/scope`, {
          method: "PUT",
          credentials: "same-origin",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(next),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
      }
      onSaved(next);
      setSavedNotice("Scope saved and synced with egress proxy policy.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" aria-label="Scope">
      <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 px-3 py-2 text-[12px] text-muted">
        Allowed targets synchronize into the egress proxy policy. Out-of-scope entries and cloud IMDS endpoints (
        <code>169.254.169.254</code>, <code>fe80::/10</code>) are always blocked.
      </div>

      <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
        In-scope targets (one domain, host, IP, or CIDR per line)
        <textarea
          className="field min-h-[88px] py-2 font-term text-[13px]"
          value={inScopeText}
          disabled={locked}
          onChange={(e) => setInScopeText(e.target.value)}
          placeholder={"*.staging.example.com\napi.example.com"}
        />
      </label>

      <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
        Out-of-scope targets (always denied)
        <textarea
          className="field min-h-[72px] py-2 font-term text-[13px]"
          value={outOfScopeText}
          disabled={locked}
          onChange={(e) => setOutOfScopeText(e.target.value)}
          placeholder={"billing.example.com\n169.254.169.254"}
        />
      </label>

      <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
        Rules of engagement &amp; notes
        <textarea
          className="field min-h-[72px] py-2 text-[13px]"
          value={notes}
          disabled={locked}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Testing window, rate limits, escalation contact…"
        />
      </label>

      {error && (
        <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
          {error}
        </div>
      )}
      {savedNotice && (
        <div className="flex items-center gap-1.5 rounded-lg border border-green/40 bg-green/10 px-3 py-2 text-[12px] font-medium text-green" role="status">
          <Icon name="check_circle" size={16} />
          <span>{savedNotice}</span>
        </div>
      )}

      {!locked && (
        <div className="flex justify-end">
          <button
            type="button"
            className="btn btn-primary text-[13px]"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : "Save Scope"}
          </button>
        </div>
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

const STATUS_TONE: Record<string, string> = {
  confirmed: "var(--color-red)",
  open: "var(--color-amber)",
  fixed: "#16a34a",
  accepted: "var(--color-muted)",
  "false-positive": "var(--color-muted)",
};

/** One table row; click it for the finding in the slide-over. */
function FindingRow({
  f,
  now,
  reporter,
  selected,
  onOpen,
}: {
  f: Finding;
  now: number;
  reporter: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const where = f.location ? `${f.location.file}${f.location.startLine ? `:${f.location.startLine}` : ""}` : f.asset.value;
  const color = SEVERITY_COLOR[f.severity];
  return (
    <tr
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className={`cursor-pointer border-t border-[var(--border-hairline)] align-middle outline-none ${
        closed(f) ? "opacity-60" : ""
      } ${selected ? "bg-cream-2" : "hover:bg-cream-2/60 focus-visible:bg-cream-2"}`}
    >
      <td className="px-4 py-2.5">
        <div className="inline-flex items-center gap-2 whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium capitalize text-ink">
            <i className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden="true" />
            {f.severity}
          </span>
          {f.cvss && (
            <span
              className="chip font-term text-[12px] font-semibold"
              style={{ ["--c" as string]: color }}
              title={f.cvss.vector}
            >
              CVSS {f.cvss.score.toFixed(1)}
            </span>
          )}
        </div>
      </td>
      <td className="w-full max-w-0 px-3 py-2.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[12px] text-muted">{f.id}</span>
          <span className="truncate font-medium text-ink">{f.title}</span>
          {f.cwe[0] && (
            <span className="shrink-0 rounded bg-cream-2 px-1.5 py-px font-term text-[12px] text-muted">
              {f.cwe[0]}
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-muted">{where}</span>
      </td>
      <td className="px-3 py-2.5">
        <span
          className="chip whitespace-nowrap capitalize"
          style={{ ["--c" as string]: STATUS_TONE[f.status] ?? "var(--color-muted)" }}
        >
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

/** The finding in full: CVSS 4.0 vector badge/editor, triage controls, Description, Impact, Evidence, Remediation. */
function FindingDetail({
  f,
  locked,
  reporter,
  now,
  onPatch,
}: {
  f: Finding;
  locked: boolean;
  reporter: string;
  now: number;
  onPatch: (patch: { severity?: Severity; status?: Finding["status"]; verified?: boolean; cvss?: string }) => void;
}) {
  const [vectorInput, setVectorInput] = useState(f.cvss?.vector ?? "");
  useEffect(() => {
    setVectorInput(f.cvss?.vector ?? "");
  }, [f.id, f.cvss?.vector]);

  const where = f.location ? `${f.location.file}${f.location.startLine ? `:${f.location.startLine}` : ""}` : f.asset.value;
  const color = SEVERITY_COLOR[f.severity];
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

      {/* Prominent CVSS 4.0 pill & vector summary */}
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-hairline)] bg-cream-2/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted">CVSS 4.0 Severity</span>
          <span className="chip font-term text-[12px] font-semibold capitalize" style={{ ["--c" as string]: color }}>
            {f.cvss ? `${f.cvss.score.toFixed(1)} · ${f.severity}` : f.severity}
          </span>
        </div>
        {f.cvss && (
          <code className="break-all rounded-md border border-[var(--border-hairline)] bg-[var(--surface-card)] px-2.5 py-1.5 font-term text-[12px] text-ink">
            {f.cvss.vector}
          </code>
        )}
        {!locked && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (vectorInput.trim()) onPatch({ cvss: vectorInput.trim() });
            }}
          >
            <input
              className="field flex-1 font-term text-[12px]"
              value={vectorInput}
              onChange={(e) => setVectorInput(e.target.value)}
              placeholder="CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N"
              aria-label="CVSS 4.0 vector"
            />
            <button type="submit" className="btn px-2.5 text-[12px]" disabled={!vectorInput.trim() || vectorInput.trim() === f.cvss?.vector}>
              Update
            </button>
          </form>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1 text-[12px] text-muted">
          <span>Severity</span>
          <Select
            size="sm"
            value={f.severity}
            disabled={locked || !!f.cvss}
            title={f.cvss ? "Derived from CVSS 4.0 score" : undefined}
            aria-label="Severity"
            options={SEVERITIES.map((sv) => ({ value: sv, label: sv }))}
            onChange={(v) => onPatch({ severity: v as Severity })}
          />
        </div>
        <div className="flex flex-col gap-1 text-[12px] text-muted">
          <span>Status</span>
          <Select
            size="sm"
            value={f.status}
            disabled={locked}
            aria-label="Status"
            options={FINDING_STATUSES.map((st) => ({ value: st, label: st }))}
            onChange={(v) => onPatch({ status: v as Finding["status"] })}
          />
        </div>
        <label className="flex items-center gap-2 self-end pb-1.5 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={f.verified}
            disabled={locked}
            onChange={(e) => onPatch({ verified: e.target.checked })}
          />{" "}
          Verified
        </label>
      </div>

      {(f.cwe.length > 0 || f.attack.length > 0 || f.ssvc || f.wstg || f.d3fend.length > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-cream-2/70 px-3 py-2 text-[12px]">
          <Ids label="CWE" list={f.cwe} />
          <Ids label="ATT&CK" list={f.attack} />
          <Ids label="D3FEND" list={f.d3fend} />
          <Ids label="WSTG" list={f.wstg ? [f.wstg] : []} />
          {f.ssvc && (
            <span>
              <b className="text-muted">SSVC</b> {f.ssvc.decision}
            </span>
          )}
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
                <pre className="scroll-thin m-0 max-h-[300px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border-hairline)] bg-cream-2 p-2.5 font-term text-[12px] text-ink">
                  {e.content}
                </pre>
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
