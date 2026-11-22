import { useEffect, useRef, useState } from "react";
import { switchServer, useIsNativeClient } from "../../lib/native";
import { signOut, useAuth } from "../../store/auth";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui, useUi, type WorkspaceId } from "../../store/ui";
import { DECK } from "./frame";
import { Icon } from "./Icon";

export type RailId = WorkspaceId;

interface RailItem {
  id: WorkspaceId;
  label: string;
  icon: string;
  hint: string;
}

const ITEMS: RailItem[] = [
  { id: "home", label: "Home", icon: "explore", hint: "Focus, Orbit & Quick Intent" },
  { id: "work", label: "Work", icon: "view_kanban", hint: "Board, PRs/Findings, Goals & Flow" },
  { id: "inbox", label: "Inbox", icon: "inbox", hint: "Visual Decisions & Approvals" },
  { id: "team", label: "Team", icon: "groups", hint: "Agents, Chat & Meetings" },
  { id: "preview", label: "Preview", icon: "preview", hint: "Live App Preview & Annotation" },
];

/**
 * Simplified 5-workspace navigation rail (Home, Work, Inbox, Team, Preview) with visible labels
 * in both compact (68px) and expanded (164px) modes, plus an Ops menu for Usage, Environments & Terminal.
 */
export function DeckRail({
  current,
  attention,
  onGo,
}: {
  current: WorkspaceId;
  security?: boolean;
  attention: number;
  onGo: (id: WorkspaceId) => void;
}) {
  const expanded = useUi((s) => s.railExpanded);
  const snap = useOffice((s) => s.snap);
  const liveMeetings = (snap?.meetings ?? []).filter((m) => m.status === "live" || m.status === "requested").length;
  const railWidth = expanded ? DECK.railExpanded : DECK.rail;

  return (
    <aside
      className="deck-rail fixed bottom-0 left-0 z-30 flex flex-col items-center justify-between border-r py-2.5 transition-[width] duration-150"
      style={{ top: DECK.header, width: railWidth }}
      aria-label="Workspaces"
    >
      <nav className="flex w-full flex-col gap-1 px-1.5" aria-label="Primary workspaces">
        {ITEMS.map((n) => {
          const on = current === n.id;
          const badge = n.id === "inbox" && attention > 0 ? attention : n.id === "team" && liveMeetings > 0 ? liveMeetings : 0;
          return (
            <button
              key={n.id}
              type="button"
              className={`deck-rail-btn group relative flex cursor-pointer items-center rounded-lg transition-colors ${
                expanded ? "h-10 w-full gap-2.5 px-2.5 text-left" : "w-full flex-col justify-center gap-0.5 py-1.5"
              } ${on ? "is-on" : ""}`}
              aria-current={on ? "page" : undefined}
              aria-label={badge ? `${n.label}, ${badge} waiting` : n.label}
              onClick={() => onGo(n.id)}
            >
              <Icon name={n.icon} size={20} className={on ? "text-accent" : ""} />
              <span className={`truncate text-[12px] ${on ? "font-semibold text-ink" : "font-medium"}`}>
                {n.label}
              </span>
              {badge > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[12px] font-semibold ${
                    n.id === "inbox" ? "bg-amber text-navy" : "bg-green/20 text-green"
                  } ${expanded ? "ml-auto" : "absolute right-1 top-1 h-2 w-2 !p-0"}`}
                  aria-hidden="true"
                >
                  {expanded ? badge : ""}
                </span>
              )}
              {!expanded && (
                <span
                  role="tooltip"
                  className="deck-tip pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-40 w-max max-w-[220px] -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-left text-[12px] opacity-0 group-hover:delay-200 group-hover:opacity-100 group-focus-visible:opacity-100"
                >
                  <b className="block font-semibold text-ink">{n.label}</b>
                  <span className="text-muted">{n.hint}</span>
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex w-full flex-col items-center gap-1.5 px-1.5">
        <OpsMenu expanded={expanded} activeUsage={current === "usage" || current === "ops" || current === "factory"} />
        <button
          type="button"
          onClick={() => ui.toggleRail()}
          className="deck-rail-btn flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-[12px]"
          aria-label={expanded ? "Collapse navigation rail" : "Expand navigation rail"}
          title={expanded ? "Collapse rail" : "Expand rail"}
        >
          <Icon name={expanded ? "chevron_left" : "chevron_right"} size={18} />
          {expanded && <span>Collapse</span>}
        </button>
        <UserMenu expanded={expanded} />
      </div>
    </aside>
  );
}

/** Compact Ops menu: Usage, Environments, Host Terminal, Command Grid & Setup Checklist. */
export function OpsMenu({ expanded = false, activeUsage = false }: { expanded?: boolean; activeUsage?: boolean }) {
  const snap = useOffice((s) => s.snap);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const envs = snap?.environments ?? [];

  return (
    <div ref={box} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ops menu: Usage, Environments and Terminal"
        className={`deck-rail-btn flex w-full cursor-pointer items-center rounded-lg ${
          expanded ? "h-9 gap-2.5 px-2.5 text-left" : "flex-col justify-center gap-0.5 py-1.5"
        } ${activeUsage || open ? "is-on" : ""}`}
      >
        <Icon name="tune" size={19} className={activeUsage ? "text-accent" : ""} />
        <span className="text-[12px] font-medium">Ops</span>
      </button>

      {open && (
        <div
          role="menu"
          className="deck-menu absolute bottom-0 left-[calc(100%+10px)] z-50 flex w-[230px] flex-col rounded-xl p-1.5 text-[13px]"
        >
          <div className="px-2.5 py-1 text-[12px] font-semibold text-muted">Operations & Telemetry</div>
          <button
            role="menuitem"
            type="button"
            className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            onClick={() => {
              setOpen(false);
              ui.openFactory();
            }}
          >
            <Icon name="precision_manufacturing" size={18} />
            <span>Factory &amp; Benchmarks</span>
          </button>

          <button
            role="menuitem"
            type="button"
            className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            onClick={() => {
              setOpen(false);
              ui.openUsage();
            }}
          >
            <Icon name="query_stats" size={18} />
            <span>Usage & Budgets</span>
          </button>

          {!isViewer && (
            <button
              role="menuitem"
              type="button"
              className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
              onClick={() => {
                setOpen(false);
                ui.openTerminal();
              }}
            >
              <Icon name="terminal" size={18} />
              <span>Host Terminal</span>
            </button>
          )}

          <button
            role="menuitem"
            type="button"
            className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            onClick={() => {
              setOpen(false);
              if (envs[0]) ui.openEnv(envs[0].name);
              else ui.openSettings("workflow");
            }}
          >
            <Icon name="cloud_done" size={18} />
            <span>Environments ({envs.length})</span>
          </button>

          <button
            role="menuitem"
            type="button"
            className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            onClick={() => {
              setOpen(false);
              ui.closeDrawer();
              ui.setView("command");
            }}
          >
            <Icon name="grid_view" size={18} />
            <span>Multi-Project Grid</span>
          </button>

          <button
            role="menuitem"
            type="button"
            className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            onClick={() => {
              setOpen(false);
              ui.openSetup();
            }}
          >
            <Icon name="checklist" size={18} />
            <span>Setup Checklist</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The signed-in person: Start all stopped agents, Light/Dark mode, Settings, Sign out. */
function UserMenu({ expanded }: { expanded: boolean }) {
  const auth = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const nativeClient = useIsNativeClient();
  const scheme = useUi((s) => s.scheme);
  const agents = useOffice((s) => s.snap?.agents);
  const stopped = (agents ?? []).filter((a) => a.session.state === "stopped" || a.session.state === "failed");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  const name = user?.name ?? (auth === "none" ? "OP" : "You");
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div ref={box} className="relative flex w-full justify-center">
      <button
        type="button"
        className={`deck-avatar relative flex cursor-pointer items-center justify-center rounded-full text-[12px] font-semibold ${
          expanded ? "h-8 w-full gap-2 rounded-lg px-2.5" : "h-8 w-8"
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: menu`}
        onClick={() => setOpen(!open)}
      >
        <span>{initials}</span>
        {expanded && <span className="truncate text-[12px] font-medium text-ink">{name}</span>}
        {stopped.length > 0 && !isViewer && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="deck-menu absolute bottom-0 left-[calc(100%+10px)] z-40 flex w-[220px] flex-col rounded-xl p-1.5 text-[13px]"
        >
          <div className="px-2.5 py-1.5 text-[12px] font-medium text-muted">{user?.name ?? "Operator"}</div>
          {!isViewer && (
            <button
              role="menuitem"
              type="button"
              className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left disabled:opacity-50"
              disabled={!stopped.length}
              onClick={() => {
                stopped.forEach((a) => officeActions.startAgent(a.agentId));
                setOpen(false);
              }}
            >
              <Icon name="play_arrow" size={18} />
              {stopped.length ? `Start all · ${stopped.length} stopped` : "Every agent is running"}
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            onClick={() => {
              ui.toggleScheme();
              setOpen(false);
            }}
          >
            <Icon name={scheme === "light" ? "dark_mode" : "light_mode"} size={18} />
            {scheme === "light" ? "Dark mode" : "Light mode"}
          </button>
          {!isViewer && (
            <button
              role="menuitem"
              type="button"
              className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
              onClick={() => (setOpen(false), ui.openSettings("project"))}
            >
              <Icon name="settings" size={18} />
              Settings
            </button>
          )}
          {nativeClient && (
            <button
              role="menuitem"
              type="button"
              className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
              onClick={() => {
                setOpen(false);
                void switchServer();
              }}
            >
              <Icon name="dns" size={18} />
              Switch server
            </button>
          )}
          {auth === "signed-in" && (
            <button
              role="menuitem"
              type="button"
              className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
              onClick={() => void signOut()}
            >
              <Icon name="logout" size={18} />
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Responsive bottom workspace bar (< 1000px): same 5 primary workspaces (Home, Work, Inbox, Team, Preview). */
export function DeckBottomNav({
  current,
  attention,
  onGo,
}: {
  current: WorkspaceId;
  attention: number;
  onGo: (id: WorkspaceId) => void;
}) {
  const snap = useOffice((s) => s.snap);
  const settingsOpen = useUi((s) => s.settings !== null);
  const liveMeetings = (snap?.meetings ?? []).filter((m) => m.status === "live" || m.status === "requested").length;

  return (
    <nav
      className="deck-bar fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 gap-1 border-t px-1.5 pt-1"
      style={{
        height: `calc(${DECK.bottomNav}px + env(safe-area-inset-bottom))`,
        paddingBottom: "max(4px, env(safe-area-inset-bottom))",
      }}
      aria-label="Primary workspaces"
    >
      {ITEMS.map((n) => {
        const on = !settingsOpen && current === n.id;
        const badge =
          n.id === "inbox" && attention > 0 ? attention : n.id === "team" && liveMeetings > 0 ? liveMeetings : 0;
        return (
          <button
            key={n.id}
            type="button"
            className={`relative flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg py-1 text-[12px] transition-colors ${
              on ? "bg-cream-2 font-semibold text-ink" : "font-medium text-muted hover:bg-cream-2/60 hover:text-ink"
            }`}
            aria-current={on ? "page" : undefined}
            aria-label={badge ? `${n.label}, ${badge} waiting` : n.label}
            onClick={() => onGo(n.id)}
          >
            <Icon name={n.icon} size={20} className={on ? "text-accent" : ""} />
            <span className="truncate">{n.label}</span>
            {badge > 0 && (
              <span
                className={`absolute right-[calc(50%-22px)] top-0.5 rounded-full px-1.5 text-[12px] font-semibold leading-4 ${
                  n.id === "inbox" ? "bg-amber text-navy" : "bg-green/20 text-green"
                }`}
                aria-hidden="true"
              >
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
