import { motion, useReducedMotion } from "framer-motion";
import { useEffect } from "react";
import { ui, useUi, type SettingsTab } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { AccountsSettings } from "./AccountsSettings";
import { MemorySettings } from "./MemorySettings";
import { UsersSettings } from "./UsersSettings";
import { BoardsSettings } from "./BoardsSettings";
import { ProjectSettings } from "./ProjectSettings";
import { SandboxSettingsTab } from "./SandboxSettings";
import { StackSettings } from "./StackSettings";
import { McpSettings } from "./McpSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { LicenseCard } from "./LicenseCard";
import { TeamSettings } from "./TeamSettings";
import { WorkflowSettings } from "./WorkflowSettings";

/** The sections, grouped into 4 clear categories; each item is one tab. */
const GROUPS: { label: string; items: { id: SettingsTab; label: string; hint: string }[] }[] = [
  {
    label: "Project",
    items: [
      { id: "project", label: "General", hint: "Name, repo, spend caps, scope, rituals" },
      { id: "stack", label: "Stack", hint: "Frameworks and tools" },
      { id: "boards", label: "Boards", hint: "Progress boards" },
    ],
  },
  {
    label: "Team & Workflow",
    items: [
      { id: "team", label: "Agents and roles", hint: "Models, budgets, skills" },
      { id: "workflow", label: "Review and merge", hint: "Gates, merge, deploy" },
    ],
  },
  {
    label: "Access & Security",
    items: [
      { id: "users", label: "People", hint: "Roles, passkeys, active devices and sign-in" },
      { id: "license", label: "License & Plan", hint: "Ed25519 tier, seat quota and feature entitlements" },
      { id: "sandbox", label: "Sandbox", hint: "Network, secrets, CPU, memory" },
      { id: "accounts", label: "API accounts", hint: "Keys, cloud, free models" },
    ],
  },
  {
    label: "Integrations & Data",
    items: [
      { id: "mcp", label: "MCP and connections", hint: "Servers and services for agents" },
      { id: "memory", label: "Memory", hint: "Extraction, keep-out, backups" },
    ],
  },
];
const ITEMS = GROUPS.flatMap((g) => g.items);

function Section({ tab, agentId }: { tab: SettingsTab; agentId?: string }) {
  return (
    <>
      {tab === "team" && <TeamSettings />}
      {tab === "accounts" && <AccountsSettings />}
      {tab === "memory" && <MemorySettings />}
      {tab === "users" && <UsersSettings />}
      {tab === "license" && <LicenseCard />}
      {tab === "workflow" && <WorkflowSettings />}
      {tab === "stack" && <StackSettings />}
      {tab === "mcp" && (
        <>
          <McpSettings />
          <ConnectionsSettings />
        </>
      )}
      {tab === "sandbox" && <SandboxSettingsTab initialAgentId={agentId} />}
      {tab === "boards" && <BoardsSettings />}
      {tab === "project" && <ProjectSettings />}
    </>
  );
}

function Nav({ tab, agentId }: { tab: SettingsTab; agentId?: string }) {
  return (
    <nav className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-hairline)] p-2 md:w-[240px] md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:px-3 md:py-4" aria-label="Settings sections">
      {GROUPS.map((g, gi) => (
        <div
          key={g.label}
          className={`flex shrink-0 gap-1 md:flex-col md:pb-3 ${
            gi > 0 ? "md:border-t md:border-[var(--border-hairline)] md:pt-3" : ""
          }`}
        >
          {(g.items.length > 1 || g.items[0].label !== g.label) && (
            <div className="hidden px-2.5 pb-1 text-[12px] font-semibold uppercase tracking-wider text-muted md:block">
              {g.label}
            </div>
          )}
          {g.items.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => ui.openSettings(t.id, agentId)}
              className={`shrink-0 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${tab === t.id ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] font-semibold text-ink" : "font-medium text-muted hover:bg-cream-2 hover:text-ink"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function Heading({ tab }: { tab: SettingsTab }) {
  const item = ITEMS.find((i) => i.id === tab);
  return (
    <header className="mb-5">
      <h1 className="m-0 text-[20px] font-semibold tracking-tight text-ink">{item?.label}</h1>
      <p className="m-0 mt-0.5 text-[13px] text-muted">{item?.hint}</p>
    </header>
  );
}

/** Responsive Settings page rendered inside the unified Deck shell across desktop, tablet, and phone. */
export function SettingsPage() {
  const settings = useUi((s) => s.settings);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[data-select-popover="true"], [data-restore-modal="true"]')) return;
      const t = e.target;
      if (!(t instanceof Element && t.closest("input, textarea, select, [role=dialog]"))) ui.closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!settings) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-[var(--border-hairline)] px-4 py-3 md:gap-3 md:px-6">
        <button
          type="button"
          className="btn px-2 py-1 text-[12px] min-[1000px]:hidden"
          aria-label="Back from Settings"
          onClick={() => ui.closeSettings()}
        >
          <Icon name="arrow_back" size={16} />
        </button>
        <h2 className="m-0 flex-1 text-[15px] font-semibold text-ink">Settings</h2>
        <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex">
          <i className="h-1.5 w-1.5 rounded-full bg-green" />
          Saved as you go
        </span>
        <button type="button" className="btn text-[13px]" onClick={() => ui.closeSettings()}>
          Done
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Nav tab={settings.tab} agentId={settings.agentId} />
        <div className="scroll-thin min-w-0 flex-1 overflow-auto px-4 py-4 md:px-8 md:py-6">
          <div className="mx-auto max-w-[920px]">
            <Heading tab={settings.tab} />
            <Section tab={settings.tab} agentId={settings.agentId} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Phones and tablets: the same sections, full screen. */
export function SettingsModal() {
  const settings = useUi((s) => s.settings);
  const reduce = useReducedMotion();
  if (!settings) return null;

  return (
    <div
      className="fixed inset-0 z-40 grid grid-cols-[minmax(0,1fr)] place-items-center bg-black/45 p-0 backdrop-blur-xs md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => e.target === e.currentTarget && ui.closeSettings()}
    >
      <motion.div
        initial={reduce ? false : { y: -12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="hud-drawer flex h-[100dvh] w-full flex-col overflow-hidden border md:h-[min(760px,calc(100dvh-2rem))] md:w-[min(1080px,100%)] md:rounded-xl"
      >
        <div className="flex items-center gap-3 border-b border-[var(--border-hairline)] px-5 py-3">
          <h2 className="m-0 flex-1 text-[15px] font-semibold text-ink">Settings</h2>
          <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex">
            <i className="h-1.5 w-1.5 rounded-full bg-green" />
            Saved as you go
          </span>
          <button
            type="button"
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-cream-2 hover:text-ink"
            aria-label="Close settings"
            onClick={() => ui.closeSettings()}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <Nav tab={settings.tab} agentId={settings.agentId} />
          <div className="scroll-thin min-w-0 flex-1 overflow-auto p-4 md:p-6">
            <Heading tab={settings.tab} />
            <Section tab={settings.tab} agentId={settings.agentId} />
          </div>
        </div>
      </motion.div>
    </div>
  );
}
