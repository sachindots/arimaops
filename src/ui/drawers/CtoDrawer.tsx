import { BRAND } from "../../data/brand";
import { useCallback, useEffect, useState } from "react";
import { type ProjectOverview, type TaskStatus } from "../../data/types";
import { isViewer, officeActions, openProject, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Field, Portrait, SectionTitle } from "../kit";
import { DrawerHeader } from "./Drawer";
import { presets } from "../../data/mock/presets";

const STATUS_BADGE: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: "TODO", color: "#8b9bb4" },
  "in-progress": { label: "DOING", color: "#818cf8" },
  "in-review": { label: "REVIEW", color: "#8b5cf6" },
  done: { label: "DONE", color: "#10b981" },
  blocked: { label: "BLOCKED", color: "#ef4444" },
};

export function CtoDrawer() {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const [projects, setProjects] = useState<ProjectOverview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; typed: string } | null>(null);
  const [auditSent, setAuditSent] = useState(false);

  const fetchProjects = useCallback(async () => {
    if (!live) {
      if (!snap) return;
      const tasks = snap.tasks;
      const count = (st: TaskStatus) => tasks.filter((t) => t.status === st).length;
      setProjects([
        {
          id: snap.config.project.id,
          name: snap.config.project.name,
          path: snap.config.project.path || "~/demo",
          repo: snap.config.project.repo,
          hqPort: snap.config.project.hqPort,
          online: true,
          paused: false,
          archived: false,
          isCurrent: true,
          readOnly: !snap.config.template && !snap.welcome,
          templateName: snap.config.template?.name ?? null,
          secure: snap.config.rules.findings,
          workflowMode: snap.config.workflow.mode ?? "github-pr",
          officeName: snap.config.project.officeName,
          lastUpdatedAt: new Date().toISOString(),
          team: snap.config.team.map((a) => ({
            id: a.id,
            name: a.name,
            roleId: a.roleId,
            role: a.role,
            isLead: a.isLead,
            cli: a.cli,
            model: a.model,
          })),
          boards: snap.boards,
          tasks: snap.tasks,
          counts: {
            todo: count("todo"),
            inProgress: count("in-progress"),
            inReview: count("in-review"),
            done: count("done"),
            blocked: count("blocked"),
            total: tasks.length,
          },
          ...(snap.spend ? { spend: snap.spend } : {}),
          waiting: (snap.actionItems ?? []).filter((i) => i.status === "open").length + snap.agents.filter((a) => a.state === "needs-input").length,
          goals: snap.goals ?? [],
        },
      ]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects`);
      const data = (await res.json()) as { projects?: ProjectOverview[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // The server serves every project; "current" is the one this tab shows.
      const list = (data.projects ?? []).map((p) => ({ ...p, isCurrent: p.id === snap?.config.project.id }));
      setProjects(list);
      setExpandedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [live, snap]);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects, snap?.tasks, snap?.config]);

  if (!snap) return null;

  const ctoAgent =
    snap.config.team.find((a) => a.role.toLowerCase().includes("cto")) ??
    snap.config.team.find((a) => a.isLead) ??
    snap.config.team[0];

  const askCtoToAudit = () => {
    if (!ctoAgent) return;
    officeActions.sendMessage(
      ctoAgent.id,
      "CTO Overwatch Directive: Call `list_projects` and `get_project_status` for every registered project on this machine. Audit task completion, active work, and any blockers across all projects, and reply with a short executive summary.",
    );
    setAuditSent(true);
    window.setTimeout(() => setAuditSent(false), 4000);
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || !live) return;
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, slug }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNewName("");
      await fetchProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!live) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDeleting(null);
      await fetchProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const active = projects.filter((p) => !p.archived);
  const totalTasksAll = projects.reduce((acc, p) => acc + p.counts.total, 0);
  const totalDoneAll = projects.reduce((acc, p) => acc + p.counts.done, 0);

  return (
    <>
      <DrawerHeader>
        {ctoAgent && <Portrait name={ctoAgent.name} color={ctoAgent.color} lead={ctoAgent.isLead} size={36} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-[15px] font-semibold">Projects</b>
            <span className="text-[13px] text-muted">
              {projects.length} {projects.length === 1 ? "project" : "projects"} · {totalDoneAll}/{totalTasksAll} tasks done
            </span>
          </div>
          <div className="truncate text-[12px] text-muted">
            {ctoAgent ? `Led by ${ctoAgent.name} (${ctoAgent.role} · ${ctoAgent.cli}${ctoAgent.model ? `:${ctoAgent.model}` : ""})` : `Global ${BRAND.name} Project Registry`}
          </div>
        </div>
      </DrawerHeader>

      <CompanyStrip projects={active} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {ctoAgent && (
            <>
              <button
                type="button"
                className="btn px-2.5 py-1 text-[12px]"
                onClick={askCtoToAudit}
              >
                {auditSent ? `✓ Sent to ${ctoAgent.name}` : `Ask ${ctoAgent.name} to review all projects`}
              </button>
              <button
                type="button"
                className="btn px-2 py-1 text-[12px]"
                onClick={() => ui.openAgent(ctoAgent.id)}
              >
                Open {ctoAgent.name}'s terminal
              </button>
            </>
          )}
        </div>
        <button type="button" className="btn px-2 py-1 text-[12px]" onClick={() => void fetchProjects()} disabled={loading}>
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {error && (
          <div role="alert" className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[13px] text-red">
            {error}
          </div>
        )}

        {!live && (
          <section className="flex flex-col gap-2">
            <SectionTitle>Sample projects</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <button key={p.id} type="button" className="btn text-[13px]" aria-pressed={snap?.config.project.name === p.config.project.name} onClick={() => officeActions.loadPreset(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <SectionTitle>Projects ({active.length})</SectionTitle>
          {live && !isViewer && (
            <form className="flex flex-wrap items-end gap-2" onSubmit={handleCreateProject}>
              <div className="min-w-[200px] flex-1">
                <Field label="New project" hint="Creates a new project workspace in HQ; you pick its team when you open it.">
                  <input className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-app" autoComplete="off" />
                </Field>
              </div>
              <button type="submit" className="btn btn-primary min-h-[36px] px-3" disabled={creating || !newName.trim()}>
                {creating ? "Creating…" : "Create project"}
              </button>
            </form>
          )}
          {active.map((p) => {
            const isExpanded = expandedId === p.id;
            const pct = p.counts.total > 0 ? Math.round((p.counts.done / p.counts.total) * 100) : 0;
            return (
              <div key={p.id} className="overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] shadow-[var(--card-shadow)]">
                <div
                  className="flex cursor-pointer flex-col gap-2 p-3 transition-colors hover:bg-cream-2/60"
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <b className="text-[15px]">{p.name}</b>
                      {p.isCurrent ? (
                        <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--accent)" }}>
                          Viewing
                        </span>
                      ) : p.online ? (
                        <span className="chip text-[12px]" style={{ ["--c" as string]: p.paused ? "#8b9bb4" : "#10b981" }}>{p.paused ? "Paused" : "Running"}</span>
                      ) : (
                        <span className="chip text-[12px]" style={{ ["--c" as string]: "#8b9bb4" }} title="Its data is in .arima/arima.db in the folder">
                          Not loaded
                        </span>
                      )}
                      <span className="text-[12px] text-muted">
                        {p.readOnly ? "Read-only (made before templates)" : p.templateName ?? "No team yet"}
                      </span>
                      {live && !p.isCurrent && p.online && (
                        <button
                          type="button"
                          className="btn px-2 py-0.5 text-[12px]"
                          onClick={(e) => {
                            e.stopPropagation();
                            openProject(p.id);
                          }}
                        >
                          Open
                        </button>
                      )}
                      {live && !isViewer && p.online && active.length > 1 && (
                        <button
                          type="button"
                          className={`btn px-2 py-0.5 text-[12px] ${deleting?.id === p.id ? "border-red text-red" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleting(deleting?.id === p.id ? null : { id: p.id, typed: "" });
                          }}
                        >
                          Delete…
                        </button>
                      )}
                    </div>
                    <span className="text-[12px] text-muted">
                      {p.counts.done}/{p.counts.total} done ({pct}%) {isExpanded ? "▾" : "▸"}
                    </span>
                  </div>

                  {deleting?.id === p.id && (
                    <form
                      className="flex flex-col gap-2 rounded-lg border border-red/50 p-2"
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleDeleteProject(p.id);
                      }}
                    >
                      <p className="m-0 text-[12px]">
                        Deletes everything {BRAND.name} keeps for <b>{p.name}</b>: its tasks, agents, findings, logs, and memory. This can&apos;t be undone. Type{" "}
                        <code>{p.id}</code> to confirm.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <input
                          className="field min-w-[160px] flex-1 font-term"
                          value={deleting.typed}
                          autoComplete="off"
                          autoCapitalize="off"
                          onChange={(e) => setDeleting({ id: p.id, typed: e.target.value })}
                          placeholder={p.id}
                        />
                        <button type="submit" className="btn min-h-[40px] border-red px-3 text-red" disabled={deleting.typed.trim() !== p.id}>
                          Delete for good
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="truncate font-term text-[12px] text-muted">{p.path}</div>

                  {/* Progress bar */}
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-cream-3">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: pct === 100 ? "#10b981" : "var(--accent)" }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                    <div className="flex flex-wrap gap-2.5">
                      <span className="text-muted">To do {p.counts.todo}</span>
                      <span className="text-[#818cf8]">Doing {p.counts.inProgress}</span>
                      <span className="text-[#8b5cf6]">Review {p.counts.inReview}</span>
                      <span className="text-green">Done {p.counts.done}</span>
                      {p.counts.blocked > 0 && <span className="text-red">Blocked {p.counts.blocked}</span>}
                      {p.spend && <span className="text-muted">Today ${p.spend.day.usd.toFixed(2)} · month ${p.spend.month.usd.toFixed(2)}{p.spend.paused ? " · paused" : ""}</span>}
                      {(p.waiting ?? 0) > 0 && <span className="text-amber">{p.waiting} waiting on you</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {p.team.slice(0, 6).map((m) => (
                        <span
                          key={m.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-1.5 py-0.5 text-[12px]"
                          title={`${m.name} — ${m.role} (${m.cli}${m.model ? `:${m.model}` : ""})`}
                        >
                          <span>{m.name}</span>
                        </span>
                      ))}
                      {p.team.length > 6 && <span className="text-[12px] text-muted">+{p.team.length - 6}</span>}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-[var(--border-hairline)] bg-cream-2/40 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[13px] font-semibold text-muted">
                        Tasks in {p.name} ({p.tasks.length})
                      </span>
                      {p.isCurrent && (
                        <button
                          type="button"
                          className="btn px-2 py-0.5 text-[12px]"
                          onClick={() => ui.openBoards()}
                        >
                          Open Full Kanban Board
                        </button>
                      )}
                    </div>

                    {p.tasks.length === 0 ? (
                      <p className="mb-1 text-[12px] text-muted">No tasks on this project&apos;s board yet.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {p.tasks.map((t) => {
                          const ownerName = p.team.find((m) => m.id === t.ownerId)?.name ?? "Unassigned";
                          return (
                            <div
                              key={t.id}
                              className="grid grid-cols-[72px_1fr_auto_auto] items-center gap-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-2 py-1.5 text-[12px]"
                            >
                              <span className="font-term text-muted">{t.id}</span>
                              <div className="min-w-0">
                                <div className="truncate font-semibold" title={t.title}>
                                  {t.title}
                                </div>
                                {t.note && <div className="truncate text-[12px] text-muted">{t.note}</div>}
                              </div>
                              <span className="truncate text-muted">{ownerName}</span>
                              <span className="chip text-[12px]" style={{ ["--c" as string]: STATUS_BADGE[t.status].color }}>
                                {STATUS_BADGE[t.status].label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </>
  );
}

/** Every project at a glance: spend today and this month, what waits on you, and each project's goals. */
function CompanyStrip({ projects }: { projects: ProjectOverview[] }) {
  const priced = projects.filter((p) => p.spend);
  const day = priced.reduce((n, p) => n + (p.spend?.day.usd ?? 0), 0);
  const month = priced.reduce((n, p) => n + (p.spend?.month.usd ?? 0), 0);
  const waiting = projects.reduce((n, p) => n + (p.waiting ?? 0), 0);
  const goals = projects.flatMap((p) => (p.goals ?? []).filter((g) => g.status === "active").map((g) => ({ ...g, project: p.name })));
  if (!projects.length) return null;
  return (
    <section className="flex flex-col gap-2 border-b border-white/[0.08] px-4 py-3" aria-label="Company">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        <span>
          <span className="text-muted">Spend today </span>
          <b className="font-display">${day.toFixed(2)}</b>
        </span>
        <span>
          <span className="text-muted">This month </span>
          <b className="font-display">${month.toFixed(2)}</b>
        </span>
        <span className={waiting ? "text-amber" : "text-muted"}>{waiting ? `${waiting} waiting on you` : "Nothing waits on you"}</span>
        {priced.length < projects.length && <span className="text-[12px] text-muted">Spend covers running projects and API-key accounts.</span>}
      </div>
      {goals.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5 p-0">
          {goals.map((g) => (
            <li key={`${g.project}-${g.id}`} className="rounded-lg border border-white/10 px-2 py-1.5 text-[12px]">
              <div className="truncate">
                <b>{g.title}</b> <span className="text-muted">· {g.project}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-muted">
                <div className="h-1 flex-1 overflow-hidden rounded-lg bg-cream-3" role="img" aria-label={`${g.done} of ${g.total} tasks done`}>
                  <div className="h-full bg-accent" style={{ width: `${g.total ? Math.round((g.done / g.total) * 100) : 0}%` }} />
                </div>
                <span>
                  {g.done}/{g.total}
                  {g.current ? ` · ${g.current}${g.target ? ` of ${g.target}` : ""}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
