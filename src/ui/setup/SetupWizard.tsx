import { useEffect, useMemo, useState } from "react";
import { BRAND } from "../../data/brand";
import { clisFor, PROVIDER_SPECS, PROVIDERS, type Provider } from "../../data/providers";
import { CLI_LABEL, type AgentCli, type SetupCheck } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { PasswordInput } from "../auth/PasswordInput";
import { Icon } from "../deck/Icon";
import { Select } from "../primitives/Select";

type Way = "login" | "key";
interface Choice {
  way: Way;
  provider: Provider;
  secret: string;
}

const STEPS = ["Team", "Sign-in", "Ready", "Start"];

/** Providers a CLI can use with just a key (no region or project to fill in). */
const keyProviders = (cli: AgentCli): Provider[] => PROVIDERS.filter((p) => PROVIDER_SPECS[p].fields.length === 0 && clisFor(p).includes(cli));

/**
 * Steps 2 to 4 of first-run, after the team exists: how each CLI signs in, whether this machine can run agents,
 * and the first Start with its terminal open. Keys go straight to the vault and are never shown again.
 */
export function SetupWizard() {
  const snap = useOffice((s) => s.snap);
  const [step, setStep] = useState(1);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[data-select-popover="true"]')) return;
      e.preventDefault();
      ui.closeWizard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const team = snap?.config.team ?? [];
  const clis = useMemo(() => [...new Set(team.map((a) => a.cli))], [team]);
  if (!snap) return null;
  const lead = team.find((a) => a.isLead) ?? team[0];
  const choice = (cli: AgentCli): Choice => choices[cli] ?? { way: "login", provider: keyProviders(cli)[0] ?? "anthropic", secret: "" };
  const set = (cli: AgentCli, patch: Partial<Choice>) => setChoices({ ...choices, [cli]: { ...choice(cli), ...patch } });
  const keyReady = (cli: AgentCli) => choice(cli).way === "login" || choice(cli).secret.trim().length > 0;

  const saveSignIn = () => {
    for (const cli of clis) {
      const c = choice(cli);
      if (c.way !== "key" || !c.secret.trim()) continue;
      officeActions.saveAccount({ id: c.provider, provider: c.provider, secret: c.secret.trim() });
      for (const a of team.filter((t) => t.cli === cli)) officeActions.updateAgent(a.id, { account: c.provider });
    }
    setChoices({}); // the keys have left this page
    setStep(2);
  };

  const start = () => {
    if (!lead) return;
    setStarting(true);
    officeActions.startAgent(lead.id);
    ui.closeWizard();
    ui.openAgent(lead.id, "terminal");
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 backdrop-blur-xs" role="dialog" aria-modal="true" aria-label={`Set up ${BRAND.name}`}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="hud-drawer flex w-[min(720px,100%)] flex-col overflow-hidden rounded-xl border">
          <div className="border-b border-[var(--border-hairline)] bg-cream-2/50 px-5 py-3.5">
            <ol className="m-0 mb-2 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-[12px]">
              {STEPS.map((name, i) => (
                <li key={name} aria-current={i === step ? "step" : undefined} className={i === step ? "font-semibold text-accent" : i < step ? "text-ink" : "text-muted"}>
                  {i < step ? "✓ " : `${i + 1}. `}
                  {name}
                </li>
              ))}
            </ol>
            <h2 className="m-0 font-display text-[20px] font-semibold tracking-tight text-ink">
              {step === 1 && "How do your agents sign in?"}
              {step === 2 && "Can this machine run them?"}
              {step === 3 && `Start ${lead?.name ?? "your lead"}`}
            </h2>
          </div>

          <div className="flex flex-col gap-3 px-5 py-4">
            {step === 1 && (
              <>
                <p className="m-0 text-[13px] text-muted">
                  Each agent runs a coding CLI in its own container. Use your own subscription (you sign in once in the agent's terminal) or give it an API key. Keys are
                  encrypted on this server and only the agent that uses one receives it.
                </p>
                {clis.map((cli) => {
                  const c = choice(cli);
                  const names = team.filter((a) => a.cli === cli).map((a) => a.name).join(", ");
                  const providers = keyProviders(cli);
                  return (
                    <section key={cli} className="rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3">
                      <div className="mb-2 flex flex-wrap items-baseline gap-2">
                        <b className="text-[15px]">{CLI_LABEL[cli]}</b>
                        <span className="text-[12px] text-muted">{names}</span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={`${CLI_LABEL[cli]} sign-in`}>
                        {(
                          [
                            ["login", "Sign in with my subscription", "You sign in once, in the agent's terminal. No per-token cost."],
                            ["key", "Use an API key", providers.length ? "Billed per token. Counts toward your spend caps." : "No key-based provider for this CLI."],
                          ] as const
                        ).map(([way, title, hint]) => (
                          <button
                            key={way}
                            type="button"
                            role="radio"
                            aria-checked={c.way === way}
                            disabled={way === "key" && providers.length === 0}
                            onClick={() => set(cli, { way })}
                            className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${c.way === way ? "border-accent bg-cream-2" : "border-[var(--border-hairline)] hover:border-[var(--border-strong)]"}`}
                          >
                            <span className="text-[13px] font-semibold">{title}</span>
                            <span className="text-[12px] text-muted">{hint}</span>
                          </button>
                        ))}
                      </div>
                      {c.way === "key" && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
                          <Select
                            value={c.provider}
                            aria-label="Provider"
                            options={providers.map((p) => ({ value: p, label: PROVIDER_SPECS[p].label }))}
                            onChange={(v) => set(cli, { provider: v as Provider })}
                          />
                          <PasswordInput
                            placeholder={PROVIDER_SPECS[c.provider].secretHint}
                            aria-label={`${PROVIDER_SPECS[c.provider].label} ${PROVIDER_SPECS[c.provider].secretLabel}`}
                            value={c.secret}
                            autoComplete="off"
                            onChange={(e) => set(cli, { secret: e.target.value })}
                          />
                        </div>
                      )}
                    </section>
                  );
                })}
                <p className="m-0 text-[12px] text-muted">
                  Agents run with their CLI's permission prompts off, because the container is the boundary. Nothing leaves it except through the network you allow.
                </p>
              </>
            )}

            {step === 2 && <ReadyStep checks={snap.setup.checks} ready={snap.setup.containerReady} />}

            {step === 3 && (
              <>
                <p className="m-0 text-[13px] text-muted">
                  {lead?.name} is the lead: it plans the work and asks the others. Pressing Start launches its container and opens its terminal.
                </p>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted">
                  <li>If it shows a sign-in link, open it in your browser, approve, and paste the code back into the terminal.</li>
                  <li>Then type a task in Chat or on Home. The other agents start when the lead needs them.</li>
                  <li>Change roles, models and spend caps later in Settings.</li>
                </ul>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] px-4 py-2.5">
            <button type="button" className="btn" onClick={() => ui.closeWizard()}>
              {step === 3 ? "Start later" : "Finish later"}
            </button>
            <div className="flex items-center gap-2">
              {step > 1 && (
                <button type="button" className="btn" onClick={() => setStep(step - 1)}>
                  Back
                </button>
              )}
              {step === 1 && (
                <button type="button" className="btn btn-primary" disabled={!clis.every(keyReady)} onClick={saveSignIn}>
                  Next
                </button>
              )}
              {step === 2 && (
                <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
                  {snap.setup.containerReady ? "Next" : "Continue anyway"}
                </button>
              )}
              {step === 3 && (
                <button type="button" className="btn btn-primary" disabled={starting || !lead || !snap.setup.containerReady} onClick={start}>
                  {starting ? "Starting…" : `Start ${lead?.name ?? ""}`}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const MARK: Record<SetupCheck["status"], { icon: string; color: string; label: string }> = {
  ok: { icon: "check_circle", color: "var(--color-green)", label: "Ready" },
  warning: { icon: "info", color: "var(--color-amber)", label: "Needs attention" },
  missing: { icon: "error", color: "var(--color-red)", label: "Missing" },
  unsupported: { icon: "block", color: "var(--color-muted)", label: "Not available" },
};

function ReadyStep({ checks, ready }: { checks: SetupCheck[]; ready: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const shown = checks.filter((c) => c.id === "docker" || c.id === "agent-image");
  return (
    <>
      <p className="m-0 text-[13px] text-muted">
        Agents run in Docker containers. {ready ? "Docker is reachable." : "HQ can't reach Docker yet, so agents can't start."}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {shown.map((c) => {
          const m = MARK[c.status];
          return (
            <li key={c.id} className="flex items-start gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3">
              <span style={{ color: m.color }} aria-label={m.label} className="mt-0.5 shrink-0">
                <Icon name={m.icon} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <b className="text-[13px]">{c.label}</b>
                <div className="text-[13px] text-muted">{c.detail}</div>
                {c.fix?.command && c.status !== "ok" && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <code className="max-w-full break-all rounded-lg border border-[var(--border-hairline)] bg-cream-2 px-2 py-0.5 font-term text-[12px]">{c.fix.command}</code>
                    <button
                      type="button"
                      className="btn px-2 text-[12px]"
                      onClick={() => {
                        void navigator.clipboard?.writeText(c.fix?.command ?? "");
                        setCopied(c.id);
                        window.setTimeout(() => setCopied(null), 1200);
                      }}
                    >
                      {copied === c.id ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div>
        <button type="button" className="btn" onClick={() => officeActions.recheckSetup()}>
          Check again
        </button>
      </div>
    </>
  );
}
