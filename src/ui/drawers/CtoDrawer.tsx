import { BRAND } from "../../data/brand";
import { useCallback, useEffect, useState } from "react";
import { type ProjectOverview, type TaskStatus } from "../../data/types";
import { isViewer, officeActions, openProject, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Field, Portrait, SectionTitle } from "../kit";
import { DrawerHeader } from "./Drawer";

const TASK_STATUSES: TaskStatus[] = ["todo", "in-progress", "in-review", "done", "blocked"];

const STATUS_BADGE: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: "TODO", color: "#9da9c4" },
  "in-progress": { label: "DOING", color: "#00e5ff" },
  "in-review": { label: "REVIEW", color: "#c04dff" },
  done: { label: "DONE", color: "#00ff66" },
  blocked: { label: "BLOCKED", color: "#ff1744" },
};

function getBrowserToken(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

export function CtoDrawer() {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const [projects, setProjects] = useState<ProjectOverview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [registerPath, setRegisterPath] = useState("");
  const [newName, setNewName] = useState("");
  const [archiving, setArchiving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; typed: string } | null>(null);
  /** The deletion record of the project just deleted, to hand to the client. */
  const [record, setRecord] = useState<{ name: string; project: string } | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState<Record<string, string>>({});
  const [newTaskOwner, setNewTaskOwner] = useState<Record<string, string>>({});
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
        },
      ]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const tok = getBrowserToken();
      const res = await fetch(`/api/projects?token=${encodeURIComponent(tok)}`);
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

  const handleRegisterProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!registerPath.trim() || !live) return;
    setError(null);
    try {
      const tok = getBrowserToken();
      const res = await fetch(`/api/projects/register?token=${encodeURIComponent(tok)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: registerPath.trim() }),
      });
      const data = (await res.json()) as { projects?: ProjectOverview[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.projects) setProjects(data.projects.map((p) => ({ ...p, isCurrent: p.id === snap?.config.project.id })));
      setRegisterPath("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateTask = async (projectId: string) => {
    const title = (newTaskTitle[projectId] ?? "").trim();
    if (!title || !live) return;
    setError(null);
    try {
      const tok = getBrowserToken();
      const ownerId = newTaskOwner[projectId] || undefined;
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks?token=${encodeURIComponent(tok)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, ownerId }),
      });
      const data = (await res.json()) as { projects?: ProjectOverview[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.projects) setProjects(data.projects.map((p) => ({ ...p, isCurrent: p.id === snap?.config.project.id })));
      setNewTaskTitle((prev) => ({ ...prev, [projectId]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdateTask = async (
    projectId: string,
    taskId: string,
    patch: { status?: TaskStatus; ownerId?: string | null },
  ) => {
    if (!live) return;
    setError(null);
    try {
      const tok = getBrowserToken();
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}?token=${encodeURIComponent(tok)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const data = (await res.json()) as { projects?: ProjectOverview[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.projects) setProjects(data.projects.map((p) => ({ ...p, isCurrent: p.id === snap?.config.project.id })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** POSTs to /api/projects/…; refreshes the list from the reply. */
  const post = async (path: string, body?: object) => {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${path}?token=${encodeURIComponent(getBrowserToken())}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json()) as { projects?: ProjectOverview[]; error?: string; record?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.projects) setProjects(data.projects.map((p) => ({ ...p, isCurrent: p.id === snap?.config.project.id })));
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const setPaused = async (projectId: string, pause: boolean) => {
    setError(null);
    try {
      const tok = getBrowserToken();
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${pause ? "pause" : "resume"}?token=${encodeURIComponent(tok)}`, { method: "POST" });
      const data = (await res.json()) as { projects?: ProjectOverview[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.projects) setProjects(data.projects.map((p) => ({ ...p, isCurrent: p.id === snap?.config.project.id })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const archived = projects.filter((p) => p.archived);
  const active = projects.filter((p) => !p.archived);
  const totalTasksAll = projects.reduce((acc, p) => acc + p.counts.total, 0);
  const totalDoneAll = projects.reduce((acc, p) => acc + p.counts.done, 0);

  return (
    <>
      <DrawerHeader>
        {ctoAgent && <Portrait color={ctoAgent.color} lead={ctoAgent.isLead} size={36} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-[18px]">Projects</b>
            <span className="border border-red bg-[rgba(255,23,68,0.16)] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-red">
              {projects.length} {projects.length === 1 ? "PROJECT" : "PROJECTS"} · {totalDoneAll}/{totalTasksAll} DONE
            </span>
          </div>
          <div className="truncate font-mono text-[12px] text-muted">
            {ctoAgent ? `Commanded by ${ctoAgent.name} (${ctoAgent.role} · ${ctoAgent.cli}${ctoAgent.model ? `:${ctoAgent.model}` : ""})` : `Global ${BRAND.name} Project Registry`}
          </div>
        </div>
      </DrawerHeader>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-ink bg-cream px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {ctoAgent && (
            <>
              <button
                type="button"
                className="btn border-red px-2.5 py-1 text-[12px] text-red"
                onClick={askCtoToAudit}
              >
                {auditSent ? "✓ Directive Sent to CTO" : `⚡ Ask ${ctoAgent.name} (CTO) to Audit All Projects`}
              </button>
              <button
                type="button"
                className="btn px-2 py-1 text-[12px]"
                onClick={() => ui.openAgent(ctoAgent.id)}
              >
                Open {ctoAgent.name} Terminal
              </button>
            </>
          )}
        </div>
        <button type="button" className="btn px-2 py-1 text-[12px]" onClick={() => void fetchProjects()} disabled={loading}>
          {loading ? "Syncing…" : "↻ Refresh"}
        </button>
      </div>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {error && (
          <div className="border-2 border-red bg-[rgba(255,23,68,0.16)] p-2 font-mono text-[12px] text-red">
            {error}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <SectionTitle>Projects ({active.length})</SectionTitle>
          {live && !isViewer && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) void post("create", { name: newName.trim() }).then((ok) => ok && setNewName(""));
              }}
            >
              <div className="min-w-[200px] flex-1">
                <Field label="New project" hint="Makes ~/projects/<name> with a fresh git repo and a lead.">
                  <input className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-app" autoComplete="off" />
                </Field>
              </div>
              <button type="submit" className="btn min-h-[44px] border-green px-3 text-green" disabled={!newName.trim()}>
                Create project
              </button>
            </form>
          )}
          {active.map((p) => {
            const isExpanded = expandedId === p.id;
            const pct = p.counts.total > 0 ? Math.round((p.counts.done / p.counts.total) * 100) : 0;
            return (
              <div key={p.id} className="border-[3px] border-ink bg-white">
                <div
                  className="flex cursor-pointer flex-col gap-2 p-3 hover:bg-cream"
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <b className="text-[16px]">{p.name}</b>
                      {p.isCurrent ? (
                        <span className="border border-green bg-[rgba(0,255,102,0.14)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-green">
                          VIEWING
                        </span>
                      ) : p.online ? (
                        <span className="border border-ink bg-cream-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">{p.paused ? "PAUSED" : "RUNNING"}</span>
                      ) : (
                        <span className="border border-ink bg-cream-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                          NOT LOADED (.arima/arima.db)
                        </span>
                      )}
                      <span className="border border-ink px-1.5 py-0.5 font-mono text-[10px] text-muted">
                        {p.readOnly ? "Read-only (made before templates)" : p.templateName ?? "No team yet"}
                      </span>
                      {live && !p.isCurrent && p.online && (
                        <button
                          type="button"
                          className="btn px-2 py-0.5 text-[11px]"
                          onClick={(e) => {
                            e.stopPropagation();
                            openProject(p.id);
                          }}
                        >
                          Open
                        </button>
                      )}
                      {live && !isViewer && p.online && (
                        <button
                          type="button"
                          className="btn px-2 py-0.5 text-[11px]"
                          title={p.paused ? "Resume GitHub and sandbox polling" : "Pause GitHub and sandbox polling (agents still report)"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void setPaused(p.id, !p.paused);
                          }}
                        >
                          {p.paused ? "Resume" : "Pause"}
                        </button>
                      )}
                      {live && !isViewer && p.online && active.length > 1 && (
                        <button
                          type="button"
                          className={`btn px-2 py-0.5 text-[11px] ${archiving === p.id ? "border-red text-red" : ""}`}
                          title="Stop its agents and move it to the archive. Nothing is deleted."
                          onClick={(e) => {
                            e.stopPropagation();
                            if (archiving !== p.id) return setArchiving(p.id);
                            setArchiving(null);
                            void post(`${encodeURIComponent(p.id)}/archive`);
                          }}
                        >
                          {archiving === p.id ? "Stop agents & archive" : "Archive"}
                        </button>
                      )}
                      {p.officeName && (
                        <span className="border border-red bg-[rgba(255,23,68,0.12)] px-1.5 py-0.5 font-mono text-[10px] text-red">
                          {p.officeName}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[12px] text-muted">
                      {p.counts.done}/{p.counts.total} done ({pct}%) {isExpanded ? "▾" : "▸"}
                    </span>
                  </div>

                  <div className="truncate font-mono text-[11px] text-muted">{p.path}</div>

                  {/* Progress bar */}
                  <div className="h-2 w-full overflow-hidden border border-ink bg-[#080b12]">
                    <div
                      className="h-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: pct === 100 ? "#00ff66" : "#ff1744" }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <div className="flex flex-wrap gap-1.5 font-mono">
                      <span className="text-muted">TODO: {p.counts.todo}</span>
                      <span className="text-[#00e5ff]">DOING: {p.counts.inProgress}</span>
                      <span className="text-[#c04dff]">REVIEW: {p.counts.inReview}</span>
                      <span className="text-green">DONE: {p.counts.done}</span>
                      {p.counts.blocked > 0 && <span className="text-red">BLOCKED: {p.counts.blocked}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {p.team.slice(0, 6).map((m) => (
                        <span
                          key={m.id}
                          className="inline-flex items-center gap-1 border border-ink bg-cream px-1.5 py-0.5 font-mono text-[10px]"
                          title={`${m.name} — ${m.role} (${m.cli}${m.model ? `:${m.model}` : ""})`}
                        >
                          <span>{m.name}</span>
                        </span>
                      ))}
                      {p.team.length > 6 && <span className="font-mono text-[10px] text-muted">+{p.team.length - 6}</span>}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t-[3px] border-ink bg-cream p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-muted">
                        Tasks in {p.name} ({p.tasks.length})
                      </span>
                      {p.isCurrent && (
                        <button
                          type="button"
                          className="btn px-2 py-0.5 text-[11px]"
                          onClick={() => ui.openBoards()}
                        >
                          Open Full Kanban Board
                        </button>
                      )}
                    </div>

                    {p.tasks.length === 0 ? (
                      <p className="mb-3 text-[12px] text-muted">No tasks on this project's board yet. Add one below.</p>
                    ) : (
                      <div className="mb-3 flex flex-col gap-1.5">
                        {p.tasks.map((t) => {
                          const st = STATUS_BADGE[t.status] ?? STATUS_BADGE.todo;
                          return (
                            <div
                              key={t.id}
                              className="grid grid-cols-2 items-center gap-2 border-2 border-ink bg-white px-2 py-1.5 text-[12px] sm:grid-cols-[72px_1fr_130px_125px]"
                            >
                              <span className="col-span-2 font-mono font-bold text-muted sm:col-span-1">{t.id}</span>
                              <div className="col-span-2 min-w-0 sm:col-span-1">
                                <div className="truncate font-semibold" title={t.title}>
                                  {t.title}
                                </div>
                                {t.note && <div className="truncate font-mono text-[10px] text-muted">{t.note}</div>}
                              </div>
                              <select
                                className="input min-w-0 py-0.5 font-mono text-[11px]"
                                value={t.ownerId ?? ""}
                                aria-label={`Owner for ${t.id}`}
                                onChange={(e) =>
                                  void handleUpdateTask(p.id, t.id, { ownerId: e.target.value || null })
                                }
                              >
                                <option value="">Unassigned</option>
                                {p.team.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name} ({m.role})
                                  </option>
                                ))}
                              </select>
                              <select
                                className="input min-w-0 py-0.5 font-mono text-[11px] font-bold"
                                style={{ color: st.color }}
                                value={t.status}
                                aria-label={`Status for ${t.id}`}
                                onChange={(e) =>
                                  void handleUpdateTask(p.id, t.id, { status: e.target.value as TaskStatus })
                                }
                              >
                                {TASK_STATUSES.map((s) => (
                                  <option key={s} value={s}>
                                    {STATUS_BADGE[s].label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Quick cross-project task creator */}
                    <form
                      className="grid grid-cols-[1fr_150px_auto] items-end gap-2 border-t-2 border-dashed border-ink pt-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleCreateTask(p.id);
                      }}
                    >
                      <Field label={`Dispatch new task to ${p.name}`}>
                        <input
                          className="field text-[12px]"
                          placeholder="Task title (e.g. Audit CSP headers, Build landing hero…)"
                          value={newTaskTitle[p.id] ?? ""}
                          onChange={(e) => setNewTaskTitle((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        />
                      </Field>
                      <Field label="Assign to">
                        <select
                          className="field font-mono text-[11px]"
                          value={newTaskOwner[p.id] ?? ""}
                          onChange={(e) => setNewTaskOwner((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        >
                          <option value="">Unassigned</option>
                          {p.team.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} ({m.role})
                            </option>
                          ))}
                        </select>
                      </Field>
                      <button type="submit" className="btn px-3 py-1.5 text-[12px]">
                        + Add Task
                      </button>
                    </form>
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {record && (
          <section className="flex flex-col gap-2 border-[3px] border-green p-3">
            <b className="text-[15px]">{record.project} is deleted</b>
            <p className="m-0 text-[13px] text-muted">
              The deletion record lists what was removed and what stays. Open it and save it as PDF to send your client; it's also kept under{" "}
              <code>~/{BRAND.homeDir}/deletion-records</code>.
            </p>
            <div className="flex flex-wrap gap-2">
              <a className="btn min-h-[40px] px-3 text-[12px]" href={`/api/projects/deletion-records/${encodeURIComponent(record.name)}.html?token=${encodeURIComponent(getBrowserToken())}`} target="_blank" rel="noreferrer">
                Open deletion record ↗
              </a>
              <a className="btn min-h-[40px] px-3 text-[12px]" href={`/api/projects/deletion-records/${encodeURIComponent(record.name)}.json?token=${encodeURIComponent(getBrowserToken())}`} target="_blank" rel="noreferrer">
                JSON
              </a>
              <button type="button" className="btn min-h-[40px] px-3 text-[12px]" onClick={() => setRecord(null)}>
                Close
              </button>
            </div>
          </section>
        )}

        {archived.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionTitle>Archive ({archived.length})</SectionTitle>
            {archived.map((p) => (
              <div key={p.id} className="flex flex-col gap-2 border-[3px] border-dashed border-ink p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-[15px]">{p.name}</b>
                  <span className="font-mono text-[11px] text-muted">
                    {p.team.length} agents · {p.counts.done}/{p.counts.total} tasks done
                  </span>
                  <span className="flex-1" />
                  {live && !isViewer && (
                    <>
                      <button type="button" className="btn min-h-[40px] px-3 text-[12px]" onClick={() => void post(`${encodeURIComponent(p.id)}/restore`)}>
                        Restore
                      </button>
                      <button
                        type="button"
                        className="btn min-h-[40px] border-red px-3 text-[12px] text-red"
                        onClick={() => setDeleting(deleting?.id === p.id ? null : { id: p.id, typed: "" })}
                      >
                        Delete…
                      </button>
                    </>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted">{p.path}</div>
                {deleting?.id === p.id && (
                  <form
                    className="flex flex-col gap-2 border-2 border-red p-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void post(`${encodeURIComponent(p.id)}/delete`, { confirm: deleting.typed.trim() }).then((d) => {
                        if (!d) return;
                        setDeleting(null);
                        if (d.record) setRecord({ name: d.record, project: p.name });
                      });
                    }}
                  >
                    <p className="m-0 text-[12px]">
                      Deletes everything {BRAND.name} keeps for <b>{p.name}</b>: the agents' folders, chats, tasks, findings, logs, the team's memory and its
                      backups. The code in {p.path} and its git history stay. You get a deletion record to send your client. This can't be undone. Type{" "}
                      <code>{p.id}</code> to confirm.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <input
                        className="field min-w-[160px] flex-1 font-mono"
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
              </div>
            ))}
          </section>
        )}

        {live && !isViewer && (
          <section className="border-[3px] border-dashed border-ink p-3">
            <SectionTitle>Add an existing folder</SectionTitle>
            <form className="flex items-end gap-2" onSubmit={handleRegisterProject}>
              <div className="flex-1">
                <Field
                  label="Repository / Project Path on Disk"
                  hint="Adds the folder to ~/.arima/projects.json and loads it into this server (a new folder gets a fresh .arima/arima.db)."
                >
                  <input
                    className="field font-mono text-[12px]"
                    value={registerPath}
                    onChange={(e) => setRegisterPath(e.target.value)}
                    placeholder="/home/sacd/.gemini/antigravity/scratch/another-project"
                  />
                </Field>
              </div>
              <button type="submit" className="btn px-3 py-1.5 text-[12px]">
                Register
              </button>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
