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
  /** What the tooltip says it opens. */
  hint: string;
}

const ITEMS: RailItem[] = [
  { id: "home", label: "Home", icon: "home", hint: "The team around the core" },
  { id: "board", label: "Board", icon: "view_kanban", hint: "Boards and tasks" },
  { id: "inbox", label: "Inbox", icon: "inbox", hint: "Everything waiting on you" },
  { id: "agents", label: "Agents", icon: "groups", hint: "Every agent and what it's doing" },
  { id: "chat", label: "Chat", icon: "forum", hint: "Talk to an agent or the whole team" },
  { id: "goals", label: "Goals", icon: "flag", hint: "What the work adds up to" },
  { id: "flow", label: "Flow", icon: "account_tree", hint: "Tasks by stage and gate" },
  { id: "prs", label: "PRs", icon: "merge", hint: "Pull requests and reviews" },
  { id: "findings", label: "Findings", icon: "shield", hint: "Security findings and the report" },
  { id: "usage", label: "Usage", icon: "monitoring", hint: "Tokens, spend and budgets" },
  { id: "grid", label: "Grid", icon: "grid_view", hint: "Every terminal at once" },
  { id: "more", label: "More", icon: "more_horiz", hint: "Environments, boards and the rest" },
];

/**
 * The icon rail down the left: each section with a visible label, a tooltip and a badge where something waits.
 * Software projects show PRs, security projects Findings. The user menu at the bottom holds Start all and Sign out.
 */
export function DeckRail({ current, security, attention, onGo }: { current: RailId; security: boolean; attention: number; onGo: (id: RailId) => void }) {
  const items = ITEMS.filter((i) => (i.id === "prs" ? !security : i.id === "findings" ? security : true));
  return (
    <nav className="deck-rail fixed bottom-0 left-0 z-20 flex flex-col items-center gap-0.5 border-r py-2" style={{ top: DECK.header, width: DECK.rail }} aria-label="Sections">
      {items.map((n) => {
        const on = current === n.id;
        const badge = n.id === "inbox" && attention > 0 ? attention : 0;
        return (
          <button
            key={n.id}
            type="button"
            className={`deck-rail-btn group relative flex w-[64px] flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] ${on ? "is-on" : ""}`}
            aria-current={on ? "page" : undefined}
            aria-label={badge ? `${n.label}, ${badge} waiting` : n.label}
            onClick={() => onGo(n.id)}
          >
            <Icon name={n.icon} size={22} />
            <span>{n.label}</span>
            {badge > 0 && (
              <span className="absolute right-1.5 top-0.5 min-w-[18px] rounded-full bg-amber px-1 text-center text-[11px] font-semibold leading-[18px] text-navy" aria-hidden="true">
                {badge}
              </span>
            )}
            <span role="tooltip" className="deck-tip pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-40 w-max max-w-[220px] -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-left text-[12px] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
              <b className="block text-ink">{n.label}</b>
              <span className="text-muted">{n.hint}</span>
            </span>
          </button>
        );
      })}
      <div className="flex-1" />
      <UserMenu />
    </nav>
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
  const name = user?.name ?? (auth === "none" ? "Demo" : "You");
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className="deck-avatar grid h-10 w-10 place-items-center rounded-full text-[14px] font-semibold"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: menu`}
        onClick={() => setOpen(!open)}
      >
        {name.slice(0, 1).toUpperCase()}
        {stopped.length > 0 && !isViewer && <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full bg-amber" aria-hidden="true" />}
      </button>
      {open && (
        <div role="menu" className="deck-menu absolute bottom-0 left-[calc(100%+10px)] z-40 flex w-[220px] flex-col rounded-xl p-1.5 text-[13px]">
          <div className="px-2.5 py-1.5 text-[12px] text-muted">{name}</div>
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
