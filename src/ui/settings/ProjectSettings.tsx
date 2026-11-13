import { BRAND } from "../../data/brand";
import { useState } from "react";
import { DEFAULT_OFFICE_NAME, OFFICE_NAME_MAX } from "../../data/names";
import { FONT_STYLES, savedFont, setFont, type FontStyle } from "../../theme/fonts";
import { officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";
import { CommitInput, Toggle } from "./controls";

function FontPicker() {
  const [font, setCurrent] = useState(savedFont);
  return (
    <section className="border-[3px] border-ink bg-white p-3">
      <SectionTitle>Font</SectionTitle>
      <Field label="Font style" hint="For panels, drawers, settings and agent terminals. The office stays pixel. Saved in this browser only.">
        <select
          className="field w-[320px]"
          value={font}
          onChange={(e) => {
            const f = e.target.value as FontStyle;
            setFont(f);
            setCurrent(f);
          }}
        >
          {FONT_STYLES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label} · {f.hint}
            </option>
          ))}
        </select>
      </Field>
    </section>
  );
}

/** Engagement scope: one entry per line. The server keeps only domains, IPs and CIDRs. */
const money = (n: number) => `$${n.toFixed(2)}`;

/** Spend caps per project on API-key accounts (docs/agent-engine.md section 8). */
function SpendCaps() {
  const caps = useOffice((s) => s.snap?.config.project.spendCaps) ?? { dailyUsd: 5, monthlyUsd: 50 };
  const spend = useOffice((s) => s.snap?.spend);
  const [daily, setDaily] = useState(String(caps.dailyUsd));
  const [monthly, setMonthly] = useState(String(caps.monthlyUsd));
  const d = Number(daily);
  const m = Number(monthly);
  const valid = d > 0 && m > 0 && d <= m;
  const dirty = d !== caps.dailyUsd || m !== caps.monthlyUsd;
  const bar = (used: number, cap: number) => {
    const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
    const color = pct >= 100 ? "#ff1744" : pct >= 80 ? "#ffab00" : "#00c853";
    return (
      <div className="mt-1 h-3 border-2 border-ink bg-cream-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    );
  };
  return (
    <section className="border-[3px] border-ink bg-white p-3">
      <SectionTitle>Spend caps</SectionTitle>
      {spend?.paused && (
        <div className="mb-2 border-[3px] border-ink bg-[#ff1744] px-2 py-1 text-[13px] font-bold text-white" role="status">
          Paused: the {spend.paused === "day" ? "daily" : "monthly"} cap is reached. Workers are stopped until {spend.paused === "day" ? "midnight" : "next month"}, or raise the cap.
        </div>
      )}
      <p className="mb-2 text-[13px] text-muted">
        On API-key accounts only: your own subscription sign-ins have no bill and aren't counted. At 80% you get one alert; at 100% HQ stops this project's workers until the period ends. Costs are estimates from list prices.
      </p>
      {spend && (
        <div className="mb-3 grid gap-3 md:grid-cols-2">
          <div className="text-[13px]">
            <b>Today</b> {money(spend.day.usd)} of {money(spend.day.cap)}
            {bar(spend.day.usd, spend.day.cap)}
          </div>
          <div className="text-[13px]">
            <b>This month</b> {money(spend.month.usd)} of {money(spend.month.cap)}
            {bar(spend.month.usd, spend.month.cap)}
          </div>
          {spend.unpriced > 0 && <p className="text-[12px] text-muted md:col-span-2">{spend.unpriced} usage events this month are on models without a price (GPT, Gemini) and count as $0.</p>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Per day (USD)">
          <input className="field" inputMode="decimal" type="number" min="0.01" step="0.5" value={daily} onChange={(e) => setDaily(e.target.value)} />
        </Field>
        <Field label="Per month (USD)">
          <input className="field" inputMode="decimal" type="number" min="0.01" step="5" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </Field>
      </div>
      {!valid && <p className="text-[12px] font-bold">Both caps are above $0, and the daily one is at most the monthly one.</p>}
      <button className="btn mt-2 min-h-[44px]" disabled={!dirty || !valid} onClick={() => officeActions.setSpendCaps({ dailyUsd: d, monthlyUsd: m })}>
        Save caps
      </button>
    </section>
  );
}

function ScopeEditor() {
  const scope = useOffice((s) => s.snap?.config.project.scope);
  const rulesCfg = useOffice((s) => s.snap?.config.rules);
  const [inScope, setIn] = useState((scope?.inScope ?? []).join("\n"));
  const [outOfScope, setOut] = useState((scope?.outOfScope ?? []).join("\n"));
  const [rules, setRules] = useState(scope?.rules ?? "");
  const lines = (v: string) => v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  const dirty = inScope !== (scope?.inScope ?? []).join("\n") || outOfScope !== (scope?.outOfScope ?? []).join("\n") || rules !== (scope?.rules ?? "");
  return (
    <section className="border-[3px] border-ink bg-white p-3">
      <SectionTitle>Scope</SectionTitle>
      {rulesCfg?.labMode && (
        <div className="mb-2 border-[3px] border-ink bg-[#ffab00] px-2 py-1 text-[13px] font-bold text-ink" role="status">
          Lab mode is on: agents start without a scope. Use it only for CTFs and practice ranges you're allowed to attack.
        </div>
      )}
      {rulesCfg?.scopeRequired && !rulesCfg.labMode && !scope?.inScope.length && (
        <p className="mb-2 text-[13px] font-bold">No agent but the lead starts until something is in scope.</p>
      )}
      <p className="mb-2 text-[13px] text-muted">
        Agents may only touch in-scope targets; out of scope always wins. One per line: <code>example.com</code>, <code>*.example.com</code>, <code>10.0.0.0/24</code>,{" "}
        <code>203.0.113.7</code>, optionally <code>:port</code>. Web traffic to them is allowed through the proxy; for scanners in Container mode, the setup checklist shows the firewall commands.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="In scope">
          <textarea className="field h-[120px] font-mono text-[13px]" value={inScope} onChange={(e) => setIn(e.target.value)} placeholder={"*.acme.test\n10.20.0.0/24"} />
        </Field>
        <Field label="Out of scope">
          <textarea className="field h-[120px] font-mono text-[13px]" value={outOfScope} onChange={(e) => setOut(e.target.value)} placeholder={"vpn.acme.test\n10.20.0.1"} />
        </Field>
      </div>
      <Field label="Rules of engagement" hint="Given to every agent: testing window, rate limits, no DoS, who to contact.">
        <textarea className="field h-[80px] text-[13px]" value={rules} onChange={(e) => setRules(e.target.value)} />
      </Field>
      <button
        className="btn mt-2"
        disabled={!dirty}
        onClick={() => officeActions.updateProject({ scope: { inScope: lines(inScope), outOfScope: lines(outOfScope), rules: rules.trim() } })}
      >
        Save scope
      </button>
      {rulesCfg?.scopeRequired && (
        <label className="mt-3 flex min-h-[44px] items-center gap-2 text-[13px]">
          <input type="checkbox" className="h-5 w-5" checked={!!rulesCfg.labMode} onChange={(e) => officeActions.setLabMode(e.target.checked)} />
          <span>
            <b>Lab mode</b>: a CTF or practice range. Agents start without a scope. Owner only.
          </span>
        </label>
      )}
    </section>
  );
}

export function ProjectSettings() {
  const project = useOffice((s) => s.snap?.config.project);
  const snap = useOffice((s) => s.snap);
  if (!project) return null;
  return (
    <div className="flex flex-col gap-5">
      <FontPicker />
      <section className="grid grid-cols-2 gap-3 border-[3px] border-ink bg-white p-3">
        <div className="col-span-2">
          <SectionTitle>Project</SectionTitle>
        </div>
        <Field label="Name">
          <CommitInput className="field" value={project.name} onCommit={(v) => v.trim() && officeActions.updateProject({ name: v.trim() })} />
        </Field>
        <Field label="Team template" hint="Roles, flow and rules come from the template this project was made from. Edit roles in Settings → Team.">
          <div className="field text-muted">{snap?.config.template ? `${snap.config.template.name} (v${snap.config.template.version})` : "None: made before templates, read-only"}</div>
        </Field>
        <Field label="Office name" hint={`The sign on the office wall. Up to ${OFFICE_NAME_MAX} characters; letters and numbers read best.`}>
          <CommitInput
            className="field"
            maxLength={OFFICE_NAME_MAX}
            value={project.officeName ?? ""}
            placeholder={DEFAULT_OFFICE_NAME}
            onCommit={(v) => officeActions.updateProject({ officeName: v.trim() })}
          />
        </Field>
        <Field label="GitHub repo" hint="owner/name. HQ only reads PRs, checks and comments.">
          <CommitInput className="field font-term text-[17px]" value={project.repo} onCommit={(v) => v.trim() && officeActions.updateProject({ repo: v.trim() })} />
        </Field>
        <Field label="Local path">
          <CommitInput className="field font-term text-[17px]" value={project.path} onCommit={(v) => v.trim() && officeActions.updateProject({ path: v.trim() })} />
        </Field>
        <Field label="HQ port" hint="Sandboxes reach HQ at host.docker.internal on this port.">
          <CommitInput
            className="field font-term text-[17px]"
            value={String(project.hqPort)}
            onCommit={(v) => {
              const n = Number(v);
              if (Number.isInteger(n) && n > 1023 && n < 65536) officeActions.updateProject({ hqPort: n });
            }}
          />
        </Field>
      </section>
      <SpendCaps />
      {snap?.config.rules.findings && <ScopeEditor />}
      <section>
        <SectionTitle>Plan</SectionTitle>
        <Toggle checked={!!project.exportPlan} onChange={(v) => officeActions.updateProject({ exportPlan: v })} label="Export plan to docs/plan.md" />
        <p className="mt-1 text-[13px] text-muted">
          {BRAND.name} keeps the plan in .arima/arima.db. With this on, it also writes a readable copy to docs/plan.md every time the plan changes, so you can commit it or read it on GitHub. Edits to that file are overwritten.
        </p>
      </section>
      <section className="border-[3px] border-ink bg-white p-3 text-[13px]">
        <SectionTitle>Multi-Project &amp; Multi-Team Operations</SectionTitle>
        <p className="mt-1 text-muted">
          Every project gets its own isolated team config (<code>&lt;repo&gt;/.arima/arima.db</code>), agent workspaces (<code>~/.arima/{project.id}/&lt;agent&gt;</code>), and sandbox/tmux session names (<code>hq-{project.id}-&lt;agent&gt;</code>). You can run multiple teams across multiple projects simultaneously by assigning each a different port:
        </p>
        <pre className="mt-2 overflow-x-auto border-[2px] border-ink bg-cream-2 p-2 font-term text-[15px] text-ink">
          {`# Project 1 (port ${project.hqPort})\nnpx arimaops --repo ${project.path} --port ${project.hqPort}\n\n# Project 2 (port ${project.hqPort + 1}, runs concurrently in its own sandboxes/tmux)\nnpx arimaops --repo ~/missions/second-project --port ${project.hqPort + 1}`}
        </pre>
      </section>
      <section className="text-[13px] text-muted">
        <SectionTitle>Security</SectionTitle>
        <ul className="list-disc pl-5">
          <li>HQ binds 127.0.0.1 unless you start it with --host or --remote.</li>
          <li>The link token changes on every start. Opening it signs this device in for 30 days (revoke it by signing out there, or by disabling the person).</li>
          <li>Each agent has its own token for hooks and the Team MCP, and can&apos;t act as another agent or use the projects API.</li>
          <li>From a remote device, risky actions need an authenticator code once a day.</li>
          <li>HQ never reads .env files. Sandboxes get keys from Docker's secret store.</li>
        </ul>
      </section>
    </div>
  );
}
