import { motion, useReducedMotion } from "framer-motion";
import { useOffice } from "../../store/office";
import { ui, useUi, type WorkTab } from "../../store/ui";
import { GoalsPage } from "../deck/GoalsPage";
import { Icon } from "../deck/Icon";
import { BoardsDrawer } from "../drawers/BoardsDrawer";
import { FindingsDrawer } from "../drawers/FindingsDrawer";
import { FlowDrawer } from "../drawers/FlowDrawer";
import { PrDrawer } from "../drawers/PrDrawer";
import { projectTheme } from "../theme/projectTheme";

export function WorkPage() {
  const reduce = useReducedMotion();
  const snap = useOffice((s) => s.snap);
  const workTab = useUi((s) => s.workTab);
  const drawer = useUi((s) => s.drawer);
  const boardFilter = useUi((s) => s.boardFilter);
  if (!snap) return null;

  const theme = projectTheme(snap);
  const security = theme.security || (snap.findings?.length ?? 0) > 0 || Boolean(snap.config.rules.findings);

  const openTasks = snap.tasks.filter((t) => t.status !== "done").length;
  const openPrs = snap.pullRequests.filter((p) => !p.merged && !p.closed).length;
  const openFindings = (snap.findings ?? []).filter((f) => f.status === "open" || f.status === "confirmed").length;
  const activeGoals = (snap.goals ?? []).filter((g) => g.status === "active").length;

  const effectiveTab: WorkTab =
    drawer?.kind === "boards"
      ? "board"
      : drawer?.kind === "prs"
        ? "prs"
        : drawer?.kind === "findings"
          ? "findings"
          : drawer?.kind === "flow"
            ? "flow"
            : !security && workTab === "findings"
              ? "prs"
              : workTab;

  const tabs: { id: WorkTab; label: string; icon: string; count?: number }[] = [
    { id: "board", label: "Board", icon: "view_kanban", count: openTasks },
    ...(security
      ? [{ id: "findings" as const, label: "Findings", icon: "security", count: openFindings }]
      : []),
    { id: "prs", label: "PRs", icon: "merge_type", count: openPrs },
    { id: "goals", label: "Goals", icon: "flag", count: activeGoals },
    { id: "flow", label: "Flow", icon: "account_tree" }, // a stage count would read as unread items
  ];

  const boardArgs =
    drawer?.kind === "boards"
      ? { boardId: drawer.boardId, stageId: drawer.stageId, taskId: drawer.taskId }
      : boardFilter ?? {};

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-hairline)] bg-cream-2/40 px-4 py-1.5"
        aria-label="Work sections"
      >
        {tabs.map((t) => {
          const active = effectiveTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => ui.setWorkTab(t.id)}
              className={`relative flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                active ? "font-semibold text-ink" : "font-medium text-muted hover:bg-cream-2 hover:text-ink"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="work-tab"
                  aria-hidden
                  className="absolute inset-0 rounded-lg bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
                  transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38 }}
                />
              )}
              <Icon name={t.icon} size={17} className={`relative shrink-0 ${active ? "text-accent" : "text-muted"}`} />
              <span className="relative">{t.label}</span>
              {t.count !== undefined && (
                <span className="relative shrink-0 whitespace-nowrap rounded-full bg-cream-3 px-1.5 py-px text-[12px] text-muted">{t.count}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        {effectiveTab === "board" && (
          <BoardsDrawer
            key={`${boardArgs.boardId ?? "all"}:${boardArgs.stageId ?? "all"}:${boardArgs.taskId ?? ""}`}
            initialBoardId={boardArgs.boardId}
            initialStageId={boardArgs.stageId}
            initialTaskId={boardArgs.taskId}
          />
        )}
        {effectiveTab === "prs" && <PrDrawer />}
        {effectiveTab === "findings" && <FindingsDrawer />}
        {effectiveTab === "goals" && <GoalsPage />}
        {effectiveTab === "flow" && <FlowDrawer />}
      </div>
    </div>
  );
}
