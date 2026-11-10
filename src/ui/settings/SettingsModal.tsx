import { motion, useReducedMotion } from "framer-motion";
import { ui, useUi, type SettingsTab } from "../../store/ui";
import { AccountsSettings } from "./AccountsSettings";
import { UsersSettings } from "./UsersSettings";
import { BoardsSettings } from "./BoardsSettings";
import { ProjectSettings } from "./ProjectSettings";
import { SandboxSettingsTab } from "./SandboxSettings";
import { StackSettings } from "./StackSettings";
import { McpSettings } from "./McpSettings";
import { TeamSettings } from "./TeamSettings";
import { WorkflowSettings } from "./WorkflowSettings";

const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "team", label: "Team", hint: "Agents, roles, skills" },
  { id: "accounts", label: "Accounts", hint: "API keys, cloud" },
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
      className="fixed inset-0 z-40 grid grid-cols-[minmax(0,1fr)] place-items-center bg-[rgba(36,26,46,0.55)] p-0 md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => e.target === e.currentTarget && ui.closeSettings()}
    >
      <motion.div
        initial={reduce ? false : { y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="panel flex h-[100dvh] w-full flex-col md:h-[min(760px,calc(100dvh-2rem))] md:w-[min(1080px,100%)]"
      >
        <div className="flex items-center gap-3 border-b-[3px] border-ink px-4 py-2">
          <h2 className="m-0 flex-1 text-[22px] font-bold">Settings</h2>
          <span className="hidden text-[13px] text-muted sm:inline">Changes apply right away.</span>
          <button className="btn px-2.5" aria-label="Close settings" onClick={() => ui.closeSettings()}>
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav className="scroll-thin flex shrink-0 gap-2 overflow-x-auto border-b-[3px] border-ink bg-cream-2 p-2 md:w-[200px] md:flex-col md:border-b-0 md:border-r-[3px] md:p-3" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="btn block shrink-0 px-2.5 py-1 text-left"
                aria-pressed={settings.tab === t.id}
                onClick={() => ui.openSettings(t.id, settings.agentId)}
              >
                <div className="text-[16px]">{t.label}</div>
                <div className="hidden text-[11px] font-normal text-muted md:block">{t.hint}</div>
              </button>
            ))}
          </nav>
          <div className="scroll-thin min-w-0 flex-1 overflow-auto p-3 md:p-5">
            {settings.tab === "team" && <TeamSettings />}
            {settings.tab === "accounts" && <AccountsSettings />}
            {settings.tab === "users" && <UsersSettings />}
            {settings.tab === "workflow" && <WorkflowSettings />}
            {settings.tab === "stack" && <StackSettings />}
            {settings.tab === "mcp" && <McpSettings />}
            {settings.tab === "sandbox" && <SandboxSettingsTab initialAgentId={settings.agentId} />}
            {settings.tab === "boards" && <BoardsSettings />}
            {settings.tab === "project" && <ProjectSettings />}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
