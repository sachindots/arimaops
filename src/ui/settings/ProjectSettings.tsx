import { BRAND } from "../../data/brand";
import { useState } from "react";
import { officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";
import { CommitInput, Toggle } from "./controls";

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
    const color = pct >= 100 ? "#ff2a4b" : pct >= 80 ? "#ffb020" : "#3fb950";
    return (
      <div className="mt-1 h-3 rounded-lg border border-white/10 bg-cream-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    );
  };
  return (
    <section className="panel p-3">
      <SectionTitle>Spend caps</SectionTitle>
      {spend?.paused && (
        <div className="mb-2 rounded-lg border border-white/10 bg-[#ff2a4b] px-2 py-1 text-[13px] font-bold text-white" role="status">
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
    <section className="panel p-3">
      <SectionTitle>Scope</SectionTitle>
      {rulesCfg?.labMode && (
        <div className="mb-2 rounded-lg border border-white/10 bg-[#ffb020] px-2 py-1 text-[13px] font-bold text-ink" role="status">
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

/** The outcomes this project works toward; the lead links tasks to them and records where each number is. */
function Goals() {
  const goals = useOffice((s) => s.snap?.goals) ?? [];
  const [draft, setDraft] = useState({ title: "", metric: "", target: "" });
  const add = () => {
    if (!draft.title.trim()) return;
    officeActions.addGoal({ title: draft.title.trim(), metric: draft.metric.trim() || undefined, target: draft.target.trim() || undefined });
    setDraft({ title: "", metric: "", target: "" });
  };
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>Goals</SectionTitle>
      <p className="text-[13px] text-muted">A few outcomes this project works toward. The lead links each task to one and records where the number is now.</p>
      {goals.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {goals.map((g) => (
            <li key={g.id} className={`panel grid grid-cols-[48px_minmax(0,1fr)_auto_auto] items-center gap-2 p-2 text-[13px] ${g.status === "active" ? "" : "opacity-60"}`}>
              <span className="font-term text-muted">{g.id}</span>
              <div className="min-w-0">
                <CommitInput className="field" value={g.title} aria-label={`${g.id} title`} onCommit={(v) => v.trim() && officeActions.updateGoal(g.id, { title: v.trim() })} />
                <div className="mt-1 text-[12px] text-muted">
                  {g.metric ? `${g.metric}${g.target ? `: target ${g.target}` : ""}${g.current ? `, now ${g.current}` : ""} · ` : ""}
                  {g.done} of {g.total} tasks done · ${g.usd.toFixed(2)} spent
                </div>
              </div>
              <div className="h-1.5 w-20 overflow-hidden rounded bg-white/10" role="img" aria-label={`${g.done} of ${g.total} tasks done`}>
                <div className="h-full bg-accent" style={{ width: `${g.total ? Math.round((g.done / g.total) * 100) : 0}%` }} />
              </div>
              <select className="field w-auto" value={g.status} aria-label={`${g.id} status`} onChange={(e) => officeActions.updateGoal(g.id, { status: e.target.value as "active" | "done" | "dropped" })}>
                <option value="active">Active</option>
                <option value="done">Done</option>
                <option value="dropped">Dropped</option>
              </select>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="field" value={draft.title} placeholder="Launch the beta" aria-label="New goal" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <input className="field" value={draft.metric} placeholder="Metric: signups" aria-label="Metric" onChange={(e) => setDraft({ ...draft, metric: e.target.value })} />
        <input className="field" value={draft.target} placeholder="Target: 200" aria-label="Target" onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
        <button className="btn" type="submit" disabled={!draft.title.trim()}>
          Add goal
        </button>
      </form>
    </section>
  );
}

export function ProjectSettings() {
  const project = useOffice((s) => s.snap?.config.project);
  const snap = useOffice((s) => s.snap);
  if (!project) return null;
  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-3 panel p-3">
        <div className="col-span-2">
          <SectionTitle>Project</SectionTitle>
        </div>
        <Field label="Name">
          <CommitInput className="field" value={project.name} onCommit={(v) => v.trim() && officeActions.updateProject({ name: v.trim() })} />
        </Field>
        <Field label="Team template" hint="Roles, flow and rules come from the template this project was made from. Edit roles in Settings → Team.">
          <div className="field text-muted">{snap?.config.template ? `${snap.config.template.name} (v${snap.config.template.version})` : "None: made before templates, read-only"}</div>
        </Field>
        <Field label="GitHub repo" hint="owner/name. HQ only reads PRs, checks and comments.">
          <CommitInput className="field font-term text-[13px]" value={project.repo} onCommit={(v) => v.trim() && officeActions.updateProject({ repo: v.trim() })} />
        </Field>
        <Field label="Local path">
          <CommitInput className="field font-term text-[13px]" value={project.path} onCommit={(v) => v.trim() && officeActions.updateProject({ path: v.trim() })} />
        </Field>
        <Field label="HQ port" hint="Sandboxes reach HQ at host.docker.internal on this port.">
          <CommitInput
            className="field font-term text-[13px]"
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
      <Goals />
      <section className="flex flex-col gap-3">
        <SectionTitle>How the team works</SectionTitle>
        <Toggle
          checked={project.standup !== false}
          onChange={(v) => officeActions.updateProject({ standup: v })}
          label="Morning (09:00) and evening (18:00) note from the team"
        />
        <Field
          label="The company"
          hint={`What every agent in every project knows: the product, customers, voice, prices, do and don't. Owner only; up to 3000 characters. Agents get it at their next start.`}
        >
          <CommitInput
            multiline
            className="field h-[140px] text-[13px]"
            maxLength={3000}
            value={snap?.company ?? ""}
            placeholder={"We build Askwell, a support inbox for small shops.\nCustomers: 2-20 person e-commerce teams.\nVoice: plain, friendly, no hype. Never promise dates."}
            onCommit={(v) => officeActions.setCompany(v)}
          />
        </Field>
        <Field
          label="Team charter"
          hint="This project's rules for working together: who owns which area, how to disagree, when to ask you. Up to 1500 characters; agents get it at their next start."
        >
          <CommitInput
            multiline
            className="field h-[110px] text-[13px]"
            maxLength={1500}
            value={project.charter ?? ""}
            placeholder={"Ghost owns server/, Vortex owns src/ui/.\nDisagree in one message with evidence; the lead decides.\nAsk the owner only for money, accounts and anything sent outside."}
            onCommit={(v) => officeActions.updateProject({ charter: v })}
          />
        </Field>
      </section>
      <section>
        <SectionTitle>Plan</SectionTitle>
        <Toggle checked={!!project.exportPlan} onChange={(v) => officeActions.updateProject({ exportPlan: v })} label="Export plan to docs/plan.md" />
        <p className="mt-1 text-[13px] text-muted">
          {BRAND.name} keeps the plan in .arima/arima.db. With this on, it also writes a readable copy to docs/plan.md every time the plan changes, so you can commit it or read it on GitHub. Edits to that file are overwritten.
        </p>
      </section>
      <section className="panel p-3 text-[13px]">
        <SectionTitle>Multi-Project &amp; Multi-Team Operations</SectionTitle>
        <Toggle checked={!!project.crossProject} onChange={(v) => officeActions.updateProject({ crossProject: v })} label="Let the lead see and change other projects' tasks" />
        <p className="mt-1 text-muted">Off by default. With it on, this project's lead can list the other projects on this machine and create or update their tasks. Only the owner can change it; agents pick it up on their next session.</p>
        <p className="mt-1 text-muted">
          Every project gets its own isolated team config (<code>&lt;repo&gt;/.arima/arima.db</code>), agent workspaces (<code>~/.arima/{project.id}/&lt;agent&gt;</code>), and sandbox/tmux session names (<code>hq-{project.id}-&lt;agent&gt;</code>). You can run multiple teams across multiple projects simultaneously by assigning each a different port:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-cream-2 p-2 font-term text-[12px] text-ink">
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
