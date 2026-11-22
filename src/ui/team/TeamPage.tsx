import { modeOf } from "../../data/mode";
import { useOffice } from "../../store/office";
import { ui, useUi, type TeamTab } from "../../store/ui";
import { AgentsPage } from "../agents/AgentsPage";
import { ChatPage } from "../chat/ChatPage";
import { Icon } from "../deck/Icon";
import { MeetingsPanel } from "../meetings/MeetingsPanel";

export function TeamPage() {
  const snap = useOffice((s) => s.snap);
  const teamTab = useUi((s) => s.teamTab);
  const chatThread = useUi((s) => s.chatThread);
  if (!snap) return null;

  const workingCount = snap.agents.filter((a) => modeOf(a) === "working").length;
  const liveMeetings = (snap.meetings ?? []).filter((m) => m.status === "live" || m.status === "requested").length;
  const queuedMessages = snap.messages.filter((m) => m.delivered === "queued").length;

  const tabs: { id: TeamTab; label: string; icon: string; badge?: string | number; pulse?: boolean }[] = [
    {
      id: "agents",
      label: "Agents",
      icon: "smart_toy",
      badge: `${workingCount}/${snap.config.team.length}`,
    },
    {
      id: "chat",
      label: "Chat",
      icon: "forum",
      badge: queuedMessages > 0 ? queuedMessages : snap.messages.length || undefined,
    },
    {
      id: "meetings",
      label: "Meetings",
      icon: "groups",
      badge: liveMeetings > 0 ? `${liveMeetings} live` : (snap.meetings?.length ?? 0) || undefined,
      pulse: liveMeetings > 0,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-hairline)] bg-cream-2/40 px-4 py-1.5"
        aria-label="Team sections"
      >
        {tabs.map((t) => {
          const active = teamTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => ui.setTeamTab(t.id)}
              className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                active
                  ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] font-semibold text-ink"
                  : "font-medium text-muted hover:bg-cream-2 hover:text-ink"
              }`}
            >
              <Icon name={t.icon} size={17} className={`shrink-0 ${active ? "text-accent" : "text-muted"}`} />
              <span>{t.label}</span>
              {t.badge !== undefined && (
                <span
                  className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-px text-[12px] ${
                    t.pulse ? "bg-green/15 font-medium text-green" : "bg-cream-3 text-muted"
                  }`}
                >
                  {t.pulse && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-green" />}
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        {teamTab === "agents" && <AgentsPage />}
        {teamTab === "chat" && <ChatPage thread={chatThread} onThread={(id) => ui.setChatThread(id)} />}
        {teamTab === "meetings" && <MeetingsPanel />}
      </div>
    </div>
  );
}
