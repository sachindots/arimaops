import type { DeployTool, ReviewTool, WorkflowMode } from "../../data/types";
import { deployToolLabel, officeActions, reviewToolLabel, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";
import { CommitInput, Toggle } from "./controls";
import { useState } from "react";
import { appManifest, GITHUB_STATE_KEY, newAppUrl, securityReviewWorkflow, WEBHOOK_PATH } from "../../data/githubApp";
import { BRAND } from "../../data/brand";
import { useAuth } from "../../store/auth";


/** Anthropic's security review on every PR (docs/templates.md section 3): a pinned workflow file the owner adds; HQ never commits it. */
function SecurityReviewSection() {
  const [copied, setCopied] = useState(false);
  const yaml = securityReviewWorkflow();
  return (
    <section className="border border-ink bg-white p-3">
      <SectionTitle>Security review on every PR</SectionTitle>
      <p className="mb-2 text-[13px] text-muted">
        Anthropic&apos;s security review comments on each pull request. Add this file to the repo as <code>.github/workflows/security-review.yml</code> and a repository secret <code>CLAUDE_API_KEY</code>. The action is pinned to a commit, like the skill packs. Each run uses that API key.
      </p>
      <pre className="max-h-[220px] overflow-auto border-2 border-ink bg-cream p-2 font-mono text-[12px]">{yaml}</pre>
      <button
        className="btn mt-2 min-h-[44px]"
        onClick={() => {
          void navigator.clipboard?.writeText(yaml).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy the workflow"}
      </button>
    </section>
  );
}

/**
 * The GitHub App (docs/agent-engine.md section 6): webhooks bring PR news in seconds, polling stays the fallback.
 * Created with GitHub's manifest flow; the webhook address is HQ's Tailscale Funnel URL.
 */
function GitHubAppSection() {
  const gh = useOffice((s) => s.snap?.githubApp);
  const { role } = useAuth();
  // The webhook gets its own Funnel port (deploy/github-webhook.sh): never the port HQ's pages are on.
  const funnel = location.protocol === "https:" && location.hostname.endsWith(".ts.net") ? `https://${location.hostname}:8443` : "";
  const [hookBase, setHookBase] = useState(funnel);
  const [org, setOrg] = useState("");
  const base = hookBase.trim().replace(/\/+$/, "");
  const validBase = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base);
  const create = () => {
    const state = crypto.randomUUID().replace(/-/g, "");
    try {
      sessionStorage.setItem(GITHUB_STATE_KEY, state);
    } catch {
      /* private window: the callback can't be matched, so the code is refused */
    }
    const form = document.createElement("form");
    form.method = "post";
    form.action = newAppUrl(state, org.trim());
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify(appManifest(`${BRAND.name} HQ`, `${base}${WEBHOOK_PATH}`, `${location.origin}/api/github/app/callback`));
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  };
  const owner = !role || role === "owner";
  return (
    <section className="border border-ink bg-white p-3">
      <SectionTitle>GitHub App</SectionTitle>
      {gh?.app ? (
        <>
          <p className="text-[13px]">
            <b>{gh.app.slug}</b>
            {gh.app.owner ? ` (${gh.app.owner})` : ""}: webhooks bring PR news in seconds; HQ still polls every 5 minutes as a safety net, and at its normal pace when no webhook arrived for 10 minutes.
          </p>
          <p className="mt-1 text-[13px] text-muted">{gh.lastDeliveryAt ? `Last webhook: ${new Date(gh.lastDeliveryAt).toLocaleString()}` : "No webhook received yet. Install the App on the repo and turn on the Funnel (below)."}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a className="btn min-h-[44px] px-3 text-[13px]" href={gh.app.installUrl} target="_blank" rel="noreferrer">
              Install on a repo
            </a>
            <a className="btn min-h-[44px] px-3 text-[13px]" href={gh.app.htmlUrl} target="_blank" rel="noreferrer">
              App on GitHub
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-[13px] text-muted">
            Without an App, HQ polls GitHub about once a minute. With one, GitHub tells HQ about PR changes in seconds. You create it on GitHub in one click; HQ keeps its key in the vault and reads only (pull requests, checks, contents).
          </p>
          <Field label="Webhook address (Tailscale Funnel)" hint={`Run deploy/github-webhook.sh on the server first: it makes only ${WEBHOOK_PATH} public, on port 8443. GitHub posts there.`}>
            <input className="field font-term text-[15px]" value={hookBase} placeholder="https://hq.your-tailnet.ts.net" onChange={(e) => setHookBase(e.target.value)} />
          </Field>
          <Field label="Organization (optional)" hint="Leave empty to create the App on your own account.">
            <input className="field" value={org} placeholder="your-org" onChange={(e) => setOrg(e.target.value)} />
          </Field>
          <button className="btn mt-1 min-h-[44px]" disabled={!validBase || !owner} onClick={create}>
            Create GitHub App
          </button>
          {!owner && <p className="mt-1 text-[12px]">Only the owner creates the App.</p>}
        </>
      )}
    </section>
  );
}

const REVIEW_HINT: Record<ReviewTool, string> = {
  coderabbit: "Reads CodeRabbit's check and comments on each PR.",
  greptile: "Reads Greptile's review status and comments.",
  copilot: "Reads GitHub Copilot code review results.",
  human: "A person reviews. HQ waits for an approving GitHub review.",
  custom: "Runs your command; exit code 0 = passed, anything else = changes.",
};

export function WorkflowSettings() {
  const wf = useOffice((s) => s.snap?.config.workflow);
  const live = useOffice((s) => s.live);
  if (!wf) return null;
  const mode: WorkflowMode = wf.mode ?? "github-pr";
  const isDeliverables = mode === "deliverables";

  const stage = (name: string, on: boolean, detail: string) => (
    <span className={`border border-ink px-2 py-0.5 ${on ? "bg-white" : "bg-cream-2 text-muted line-through"}`}>
      <b>{name}</b> <span className="text-[12px]">{detail}</span>
    </span>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="border border-ink bg-white p-3">
        <SectionTitle>Mission Workflow Mode</SectionTitle>
        <p className="text-[14px] font-semibold">{isDeliverables ? "Deliverables (any task, no PRs)" : "GitHub pull requests"}</p>
        <p className="mt-1 text-[13px] text-muted">Set by the project's team template: its flow decides how a task is finished.</p>
        <p className="mt-2 text-[13px] text-muted">
          {isDeliverables
            ? "Universal Deliverables mode works in any folder without requiring GitHub PRs. Operators write reports, security audits, research dossiers, content, or local code directly to task files and report completion to the Lead."
            : "GitHub Pull Requests mode enforces 1 task = 1 branch = 1 PR (`gh pr create`), automated PR review polling, and branch merges."}
        </p>
      </section>

      <section>
        <SectionTitle>Pipeline</SectionTitle>
        {isDeliverables ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              {stage("Plan", true, "lead creates tasks")}
              <span>→</span>
              {stage("Execute", true, "operator writes deliverable")}
              <span>→</span>
              {stage("Review", true, "lead / human verifies")}
              <span>→</span>
              {stage("Done", true, "artifact saved in workspace")}
            </div>
            <p className="mt-2 text-[13px] text-muted">
              Ideal for Cybersecurity/OSINT cells, deep research, technical writing, strategy, or local coding without GitHub PRs.
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              {stage("Build", true, "agent in its sandbox")}
              <span>→</span>
              {stage("Review", wf.review.enabled, reviewToolLabel[wf.review.tool])}
              <span>→</span>
              {stage("Merge", true, wf.merge.by === "lead" ? "by the lead" : "by you")}
              <span>→</span>
              {live ? (
                <span className="border border-dashed border-ink bg-cream-2 px-2 py-0.5 text-muted">
                  <b>Deploy</b> <span className="text-[12px]">coming soon</span>
                </span>
              ) : (
                stage("Deploy", wf.deploy.enabled, deployToolLabel[wf.deploy.tool])
              )}
            </div>
            <p className="mt-2 text-[13px] text-muted">One task = one branch = one PR. HQ only reads results from these tools; it never merges or deploys itself.</p>
          </>
        )}
      </section>

      {!isDeliverables && (
        <>
          <section className="border border-ink bg-white p-3">
            <div className="mb-3 flex items-center justify-between">
              <SectionTitle>Review</SectionTitle>
              <Toggle checked={wf.review.enabled} onChange={(v) => officeActions.updateWorkflow({ review: { enabled: v } })} label={wf.review.enabled ? "On" : "Off"} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tool" hint={REVIEW_HINT[wf.review.tool]}>
                <select
                  className="field"
                  disabled={!wf.review.enabled}
                  value={wf.review.tool}
                  onChange={(e) => officeActions.updateWorkflow({ review: { tool: e.target.value as ReviewTool } })}
                >
                  {(Object.keys(reviewToolLabel) as ReviewTool[]).map((t) => (
                    <option key={t} value={t}>
                      {reviewToolLabel[t]}
                    </option>
                  ))}
                </select>
              </Field>
              {wf.review.tool === "custom" && (
                <Field label="Command" hint="Runs on the host against the PR branch.">
                  <CommitInput className="field font-term text-[17px]" value={wf.review.command} placeholder="pnpm lint && pnpm test" onCommit={(v) => officeActions.updateWorkflow({ review: { command: v } })} />
                </Field>
              )}
            </div>
            <p className="mt-2 text-[12px] text-muted">When a review finishes with comments, HQ tells the PR's author to fix them.</p>
          </section>

          <GitHubAppSection />
          <SecurityReviewSection />

          <section className="border border-ink bg-white p-3">
            <SectionTitle>Merge</SectionTitle>
            <div className="flex gap-2" role="radiogroup" aria-label="Who merges">
              {(["human", "lead"] as const).map((by) => (
                <button key={by} className="btn text-[14px]" role="radio" aria-checked={wf.merge.by === by} aria-pressed={wf.merge.by === by} onClick={() => officeActions.updateWorkflow({ merge: { by } })}>
                  {by === "human" ? "You merge" : "The lead merges"}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-muted">The lead always sets the merge order and handles conflicts between PRs.</p>
          </section>


          {live ? (
            <section className="border border-dashed border-ink bg-cream-2 p-3">
              <div className="mb-1 flex items-center justify-between">
                <SectionTitle>Deploy</SectionTitle>
                <span className="chip text-[12px]">Coming soon</span>
              </div>
              <p className="m-0 text-[13px] text-muted">
                Preview deployments per PR (Vercel, InstaCloud) and one environment per agent, shown in the office's server room. Not available yet; agents can
                still deploy with their own tools.
              </p>
            </section>
          ) : (
            <section className="border border-ink bg-white p-3">
              <div className="mb-3 flex items-center justify-between">
                <SectionTitle>Deploy</SectionTitle>
                <Toggle checked={wf.deploy.enabled} onChange={(v) => officeActions.updateWorkflow({ deploy: { enabled: v } })} label={wf.deploy.enabled ? "On" : "Off"} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tool">
                  <select
                    className="field"
                    disabled={!wf.deploy.enabled}
                    value={wf.deploy.tool}
                    onChange={(e) => officeActions.updateWorkflow({ deploy: { tool: e.target.value as DeployTool } })}
                  >
                    {(Object.keys(deployToolLabel) as DeployTool[]).map((t) => (
                      <option key={t} value={t}>
                        {deployToolLabel[t]}
                      </option>
                    ))}
                  </select>
                </Field>
                {wf.deploy.tool === "custom" && (
                  <Field label="Command">
                    <CommitInput className="field font-term text-[17px]" value={wf.deploy.command} placeholder="./scripts/deploy.sh" onCommit={(v) => officeActions.updateWorkflow({ deploy: { command: v } })} />
                  </Field>
                )}
                <div className="col-span-2">
                  <Toggle
                    checked={wf.deploy.perAgentEnvironments}
                    onChange={(v) => officeActions.updateWorkflow({ deploy: { perAgentEnvironments: v } })}
                    label="One environment per agent (own app + database copy)"
                  />
                </div>
              </div>
              <p className="mt-2 text-[12px] text-muted">The server room shows one rack per environment. Turn deploy off to hide it.</p>
            </section>
          )}
        </>
      )}
          <section className="border border-ink bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <SectionTitle>Token saving</SectionTitle>
              <Toggle
                checked={wf.lean?.clearBetweenTasks !== false}
                onChange={(v) => officeActions.updateWorkflow({ lean: { clearBetweenTasks: v } })}
                label={wf.lean?.clearBetweenTasks !== false ? "On" : "Off"}
              />
            </div>
            <p className="m-0 text-[13px] text-muted">
              When a worker finishes a task, its next task starts in a fresh conversation instead of rereading everything before it. The task brief brings
              back what matters: short handoff notes and bounded repo facts in <code>.arima/facts.md</code>. The lead keeps its conversation.
              Repeated-error detection uses rules, with no background model calls.
            </p>
          </section>

    </div>
  );
}
