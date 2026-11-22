import { useEffect, useMemo, useRef, useState } from "react";
import type { OfficeSnapshot } from "../../data/types";
import { isViewer, selectAttention } from "../../store/office";
import { ui } from "../../store/ui";

interface CommandItem {
  id: string;
  label: string;
  sub: string;
  tag: string;
  run: () => void;
}

export function CommandBar({ snap }: { snap: OfficeSnapshot }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const attention = selectAttention(snap).total;
  const findingsCount = snap.findings?.length ?? 0;

  const items = useMemo<CommandItem[]>(() => {
    const base: CommandItem[] = [
      { id: "home", label: "Home — Focus & Orbit", sub: "Spatial team orbit, quick intent & waiting decisions", tag: "HOME", run: () => ui.setWorkspace("home") },
      { id: "boards", label: "Work — Task Board", sub: `${snap.tasks.length} tasks across boards`, tag: "WORK", run: () => ui.openBoards() },
      { id: "prs", label: "Work — Pull Requests", sub: `${snap.pullRequests.length} open`, tag: "WORK", run: () => ui.openPrs() },
      { id: "goals", label: "Work — Goals & Outcomes", sub: `${(snap.goals ?? []).length} active goals`, tag: "WORK", run: () => ui.openGoals() },
      { id: "flow", label: "Work — Pipeline Flow", sub: "Stages and gates", tag: "WORK", run: () => ui.openFlow() },
      { id: "findings", label: "Work — Security Findings", sub: `${findingsCount} recorded`, tag: "SEC", run: () => ui.openFindings() },
      { id: "inbox", label: "Inbox — Visual Decisions & Approvals", sub: attention > 0 ? `${attention} waiting` : "All clear", tag: "INBOX", run: () => ui.openActions() },
      { id: "agents", label: "Team — Agents Roster", sub: `${snap.config.team.length} agents in project`, tag: "TEAM", run: () => ui.setTeamTab("agents") },
      { id: "chat", label: "Team — Chat", sub: "Direct & team channels", tag: "TEAM", run: () => ui.openChat() },
      { id: "meetings", label: "Team — Standup & Meetings Room", sub: "Moderated standups, voice call & 1-click minutes", tag: "MEET", run: () => ui.openMeetings() },
      { id: "preview", label: "Live Preview & Annotation Studio", sub: "Viewport switcher, DOM picker & Freeze & Draw canvas", tag: "VIEW", run: () => ui.openPreview() },
      { id: "usage", label: "Ops — Usage & Budgets", sub: "Tokens, cost & role caps", tag: "OPS", run: () => ui.openUsage() },
      { id: "projects", label: "Switch / Manage Projects", sub: "Switch, create, pause, archive or delete", tag: "HQ", run: () => ui.openCto() },
      {
        id: "command",
        label: "Multi-Project Command Grid",
        sub: "All running projects & live screens",
        tag: "GRID",
        run: () => {
          ui.closeDrawer();
          ui.setView("command");
        },
      },
    ];
    if (!isViewer) {
      base.push(
        { id: "terminal", label: "Ops — Host Terminal", sub: "Host shell & logs", tag: "OPS", run: () => ui.openTerminal() },
        { id: "settings", label: "System Settings", sub: "Project, team & workflow, access & security, integrations", tag: "CFG", run: () => ui.openSettings("project") },
      );
    }
    for (const a of snap.config.team) {
      base.push({
        id: `agent:${a.id}`,
        label: a.name,
        sub: a.role,
        tag: "AGENT",
        run: () => ui.openAgent(a.id),
      });
    }
    return base;
  }, [snap, attention, findingsCount]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.label} ${i.sub} ${i.tag}`.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    setCursor(0);
  }, [query, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const inInput = Boolean(el?.closest("input, textarea, select, [contenteditable], .xterm"));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // The input is always on screen: focus it now, so keys typed right after ⌘K land in it.
        if (open) inputRef.current?.blur();
        else inputRef.current?.focus();
        setOpen(!open);
        return;
      }
      if (!inInput && e.key === "/") {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
        return;
      }
      if (open && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const runItem = (item: CommandItem | undefined) => {
    if (!item) return;
    setOpen(false);
    setQuery("");
    item.run();
  };


  return (
    <div className="pointer-events-auto relative flex flex-col items-center">
      <div className="flex w-full items-center gap-2 rounded-full border border-[var(--border-hairline)] bg-cream px-3 py-1 transition-colors focus-within:border-[var(--accent)]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-muted" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          id="hud-command-input"
          name="command"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(filtered.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runItem(filtered[cursor]);
            }
          }}
          placeholder="Command or jump…"
          aria-label="Command bar"
          className="w-full min-w-0 bg-transparent text-[12px] text-ink placeholder-muted outline-none"
        />
        <kbd className="kbd">⌘K</kbd>
      </div>

      {/* Command Palette Dropdown */}
      {open && (
        <>
          <div className="fixed inset-0 -z-10" onClick={() => setOpen(false)} />
          <div className="deck-menu scroll-thin absolute top-[calc(100%+6px)] z-50 max-h-[320px] w-[min(92vw,420px)] overflow-y-auto rounded-xl p-1.5">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-muted">No matching command or agent</div>
            ) : (
              filtered.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => runItem(item)}
                  className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                    idx === cursor ? "bg-cream-2 text-ink" : "text-ink hover:bg-cream-2/60"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">{item.label}</div>
                    <div className="truncate text-[12px] text-muted">{item.sub}</div>
                  </div>
                  <span className="kbd shrink-0">{item.tag}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
