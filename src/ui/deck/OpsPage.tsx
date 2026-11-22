// Operations & Telemetry hub: Usage, Host Terminal, Environments, Command Grid, Setup, Settings & Switch Server.
import type { ReactNode } from "react";
import { switchServer, useIsNativeClient } from "../../lib/native";
import { signOut, useAuth } from "../../store/auth";
import { isViewer, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { DrawerHeader, PageTitle } from "../drawers/Drawer";
import { Icon } from "./Icon";

export function OpsPage() {
  const native = useIsNativeClient();
  const auth = useAuth((s) => s.status);
  const scheme = useUi((s) => s.scheme);
  const security = useOffice((s) => !!s.snap?.config.rules.findings);
  const openFindings = useOffice(
    (s) => (s.snap?.findings ?? []).filter((f) => f.status === "open" || f.status === "confirmed").length,
  );
  const envs = useOffice((s) => s.snap?.environments ?? []);

  const item = (icon: string, label: string, sub: string, onClick: () => void, show = true): ReactNode =>
    show && (
      <li key={label}>
        <button
          type="button"
          className="flex h-full w-full cursor-pointer items-start gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] px-4 py-3.5 text-left shadow-[var(--card-shadow)] transition-all hover:border-[var(--border-strong)] hover:shadow-[var(--card-shadow-hover)]"
          onClick={onClick}
        >
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-cream-2 text-accent">
            <Icon name={icon} size={19} />
          </span>
          <span className="min-w-0 flex-1">
            <b className="block font-display text-[15px] font-semibold text-ink">{label}</b>
            <span className="mt-0.5 block text-[12px] text-muted">{sub}</span>
          </span>
        </button>
      </li>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DrawerHeader>
        <PageTitle title="Ops & Tools" context="Telemetry, host shell, environments, and multi-project controls" />
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <ul className="m-0 mx-auto grid w-full max-w-[1000px] list-none grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3 p-0">
          {item("precision_manufacturing", "Factory & Benchmarks", "14-day metrics, task scorers, nightly proposals & replay suite", () => ui.openFactory())}
          {item("query_stats", "Usage & budgets", "Tokens, cost by agent, and daily role budgets", () => ui.openUsage())}
          {item("terminal", "Host terminal", "A shell on the server: the repo, an agent's folder, or any path", () => ui.openTerminal(), !isViewer)}
          {item(
            "cloud_done",
            `Environments${envs.length ? ` · ${envs.length}` : ""}`,
            "Deployed previews and per-agent environments",
            () => (envs[0] ? ui.openEnv(envs[0].name) : ui.openSettings("workflow")),
          )}
          {item("grid_view", "Command grid", "Every agent of every project, needs-you first", () => ui.setView("command", false))}
          {item("folder_open", "Projects", "Switch, create, pause, archive, or delete projects", () => ui.openCto())}
          {item("flag", "Goals & outcomes", "Project goals, metrics, and linked board tasks", () => ui.openGoals())}
          {item("groups", "Standups & meetings", "Lead-moderated rooms, voice call & 1-click minutes", () => ui.openMeetings())}
          {item("preview", "Live preview & draw", "Preview dev servers, pick DOM elements & annotate", () => ui.openPreview())}
          {item(
            "security",
            `Findings${openFindings ? ` · ${openFindings}` : ""}`,
            "Security findings, CVSS 4.0 scores, scope & 6-format exports",
            () => ui.openFindings(),
            security || openFindings > 0,
          )}
          {item("account_tree", "Flow", "Stages, who works them, and the gates between", () => ui.openFlow())}
          {item("merge_type", "Pull requests", "Reviews and what's ready to merge", () => ui.openPrs())}
          {item("checklist", "Setup checklist", "Check host tools, sandboxes, and containers", () => ui.openSetup())}
          {item("settings", "Settings", "Project, team & workflow, access & security, integrations", () => ui.openSettings("project"), !isViewer)}
          {item(
            scheme === "light" ? "dark_mode" : "light_mode",
            scheme === "light" ? "Dark mode" : "Light mode",
            `Switch from ${scheme} to ${scheme === "light" ? "dark" : "light"} surfaces`,
            () => ui.toggleScheme(),
          )}
          {item("dns", "Switch server", "Connect this app to another HQ instance", () => void switchServer(), native)}
          {item("logout", "Sign out", "Sign this device out of HQ", () => void signOut(), auth === "signed-in")}
        </ul>
      </div>
    </div>
  );
}
