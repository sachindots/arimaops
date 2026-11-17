import { motion, useReducedMotion } from "framer-motion";
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
import { TeamSettings } from "./TeamSettings";
import { WorkflowSettings } from "./WorkflowSettings";

const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "team", label: "Team", hint: "Agents, roles, skills" },
  { id: "accounts", label: "Accounts", hint: "API keys, cloud" },
  { id: "memory", label: "Memory", hint: "Extraction, keep-out, backups" },
  { id: "users", label: "Users", hint: "People, roles, sign-out" },
  { id: "workflow", label: "Workflow", hint: "Review, merge, deploy" },
  { id: "stack", label: "Stack", hint: "Frameworks, tools" },
  { id: "mcp", label: "MCP", hint: "Servers for agents" },
  { id: "sandbox", label: "Sandbox", hint: "Network, proxy, secrets" },
  { id: "boards", label: "Boards", hint: "Progress boards" },
  { id: "project", label: "Project", hint: "Repo and HQ" },
];

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
        initial={reduce ? false : { y: -12, opacity: 0, scale: 0.99 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="hud-drawer flex h-[100dvh] w-full flex-col overflow-hidden border md:h-[min(760px,calc(100dvh-2rem))] md:w-[min(1080px,100%)] md:rounded-xl"
      >
        <div className="flex items-center gap-3 border-b border-[var(--border-hairline)] bg-cream-2/50 px-5 py-3">
          <h2 className="m-0 flex-1 font-display text-[15px] font-semibold tracking-tight text-ink">Settings</h2>
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
          <nav className="scroll-thin flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--border-hairline)] bg-cream-2/40 p-2 md:w-[200px] md:flex-col md:border-b-0 md:border-r md:p-2.5" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="btn block shrink-0 px-2.5 py-1.5 text-left"
                aria-pressed={settings.tab === t.id}
                onClick={() => ui.openSettings(t.id, settings.agentId)}
              >
                <div className="text-[13px] font-medium">{t.label}</div>
                <div className="hidden text-[12px] font-normal text-muted md:block">{t.hint}</div>
              </button>
            ))}
          </nav>
          <div className="scroll-thin min-w-0 flex-1 overflow-auto p-3 md:p-5">
            {settings.tab === "team" && <TeamSettings />}
            {settings.tab === "accounts" && <AccountsSettings />}
            {settings.tab === "memory" && <MemorySettings />}
            {settings.tab === "users" && <UsersSettings />}
            {settings.tab === "workflow" && <WorkflowSettings />}
            {settings.tab === "stack" && <StackSettings />}
            {settings.tab === "mcp" && (
              <>
                <McpSettings />
                <ConnectionsSettings />
              </>
            )}
            {settings.tab === "sandbox" && <SandboxSettingsTab initialAgentId={settings.agentId} />}
            {settings.tab === "boards" && <BoardsSettings />}
            {settings.tab === "project" && <ProjectSettings />}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
