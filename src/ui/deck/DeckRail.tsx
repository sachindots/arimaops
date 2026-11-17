import { useEffect, useRef, useState } from "react";
import { signOut, useAuth } from "../../store/auth";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { DECK } from "./frame";
import { Icon } from "./Icon";

export type RailId = "home" | "board" | "inbox" | "agents" | "chat" | "goals" | "flow" | "prs" | "findings" | "usage" | "grid" | "more";

interface RailItem {
  id: RailId;
  label: string;
  icon: string;
  hint: string;
}

const ITEMS: RailItem[] = [
  { id: "home", label: "Home", icon: "explore", hint: "Spatial Orbit Home" },
  { id: "board", label: "Board", icon: "view_kanban", hint: "Task Board" },
  { id: "inbox", label: "Inbox", icon: "inbox", hint: "Inbox & Approvals" },
  { id: "agents", label: "Agents", icon: "smart_toy", hint: "Agent Fleet" },
  { id: "chat", label: "Chat", icon: "forum", hint: "Team Chat" },
  { id: "goals", label: "Goals", icon: "flag", hint: "Project Goals & Outcomes" },
  { id: "flow", label: "Flow", icon: "account_tree", hint: "Pipeline Flow" },
  { id: "prs", label: "PRs", icon: "merge_type", hint: "Pull Requests" },
  { id: "findings", label: "Findings", icon: "security", hint: "Security Findings" },
  { id: "usage", label: "Usage", icon: "query_stats", hint: "Usage Stats & Budgets" },
  { id: "grid", label: "Grid", icon: "grid_view", hint: "Multi-Project Command Grid" },
  { id: "more", label: "More", icon: "more_horiz", hint: "Environments, Terminal & More" },
];

/**
 * Micro navigation rail (w-14 = 56px): icon buttons (w-10 h-10 rounded-lg) with hover tooltips and an amber
 * notification dot on Inbox when items wait. Bottom holds the compact operator menu.
 */
export function DeckRail({ current, security, attention, onGo }: { current: RailId; security: boolean; attention: number; onGo: (id: RailId) => void }) {
  const items = ITEMS.filter((i) => (i.id === "prs" ? !security : i.id === "findings" ? security : true));
  return (
    <aside
      className="deck-rail fixed bottom-0 left-0 z-30 flex flex-col items-center justify-between border-r py-3"
      style={{ top: DECK.header, width: DECK.rail }}
      aria-label="Sections"
    >
      <nav className="flex w-full flex-col items-center gap-1 px-1.5">
        {items.map((n) => {
          const on = current === n.id;
          const badge = n.id === "inbox" && attention > 0 ? attention : 0;
          return (
            <button
              key={n.id}
              type="button"
              className={`deck-rail-btn group relative flex h-9 w-10 cursor-pointer items-center justify-center rounded-lg ${on ? "is-on" : ""}`}
              aria-current={on ? "page" : undefined}
              aria-label={badge ? `${n.label}, ${badge} waiting` : n.label}
              onClick={() => onGo(n.id)}
            >
              <Icon name={n.icon} size={20} />
              {badge > 0 && (
                <span
                  className="
                    absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber
                  "
                  aria-hidden="true"
                />
              )}
              <span
                role="tooltip"
                className="deck-tip pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-40 w-max max-w-[220px] -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-left text-[12px] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                <b className="block text-ink">{n.label}</b>
                <span className="text-muted">{n.hint}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <UserMenu />
    </aside>
  );
}

/** The signed-in person: Start all stopped agents, Light/Dark mode, Settings, Sign out. */
function UserMenu() {
  const auth = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
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
    <div ref={box} className="relative">
      <button
        type="button"
        className="deck-avatar relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[12px] font-semibold"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: menu`}
        onClick={() => setOpen(!open)}
      >
        {initials}
        {stopped.length > 0 && !isViewer && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber" aria-hidden="true" />}
      </button>
      {open && (
        <div role="menu" className="deck-menu absolute bottom-0 left-[calc(100%+10px)] z-40 flex w-[220px] flex-col rounded-xl p-1.5 text-[13px]">
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
            <button role="menuitem" type="button" className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left" onClick={() => (setOpen(false), ui.openSettings("project"))}>
              <Icon name="settings" size={18} />
              Settings
            </button>
          )}
          {auth === "signed-in" && (
            <button role="menuitem" type="button" className="deck-menu-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-left" onClick={() => void signOut()}>
              <Icon name="logout" size={18} />
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
