// Multi-Project CTO Overwatch REST API (/api/projects/*): for the UI only (browser/viewer token or
// device cookie), never agents. Writes require operator/owner role, valid Origin, and remote step-up.

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";
import { backupsDir } from "./backups";
import { redactor } from "./credentials/registry";
import { CONTENT_TYPE, evidenceFile } from "./evidence";
import { forgetProject, recordsDir, saveRecord } from "./forget";
import { hqDb } from "./lib/db";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { metricsReport } from "./metrics";
import { releasePortBlock } from "./ports";
import type { Runtime } from "./project";
import {
  createCrossProjectTask,
  listProjectsOverview,
  registerProjectPath,
  removeFromRegistry,
  setRegistryArchived,
  setRegistryPaused,
  updateCrossProjectTask,
} from "./projectsRegistry";
import { canOperate, type Role } from "./remote";
import { EXPORT_FORMATS, RENDER, type ExportFormat } from "./reports";
import { agentUsage } from "./usageEvents";

export interface ProjectsApiContext {
  who: { role: Role; deviceId: string; userId?: string; userName?: string } | null;
  okOrigin: boolean;
  remote: boolean;
  elevated: boolean;
  projects: Map<string, Runtime>;
  loadProject: (path: string) => Promise<void>;
  unloadProject: (slug: string) => Promise<void>;
  refreshPush: () => void;
  closeSockets: (rt: Runtime) => void;
  readBody: (req: IncomingMessage, limit?: number) => Promise<string>;
}

const send = (res: ServerResponse, code: number, body: string, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
};

export async function handleProjectsApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ProjectsApiContext): Promise<void> {
  const { who, okOrigin, remote, elevated, projects, loadProject, unloadProject, refreshPush, closeSockets, readBody } = ctx;
  const operator = !!who && canOperate(who.role);
  const viewer = who?.role === "viewer";
  if (viewer && req.method !== "GET") return send(res, 403, JSON.stringify({ error: "viewer token is read-only" }));
  if (!operator && !viewer) return send(res, 401, JSON.stringify({ error: "unauthorized" }));
  if (req.method !== "GET" && !okOrigin) return send(res, 403, JSON.stringify({ error: "bad origin" }));
  if (req.method !== "GET" && remote && !elevated)
    return send(res, 403, JSON.stringify({ error: "step-up required: enter your authenticator code in HQ first" }));

  try {
    if (req.method === "GET" && url.pathname === "/api/projects") {
      return send(res, 200, JSON.stringify({ projects: listProjectsOverview() }));
    }
    if (req.method === "POST" && (url.pathname === "/api/projects/register" || url.pathname === "/api/projects/create")) {
      // A new project runs agents in that folder: the owner's call, like a seat's folder.
      if (who?.role !== "owner") return send(res, 403, JSON.stringify({ error: "only the owner can add a project" }));
      const create = url.pathname.endsWith("/create");
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string; name?: string };
      // New project by name: a fresh folder under ~/projects.
      const slug = String(body.name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      const path = body.path?.trim() || (create && slug ? join(homedir(), "projects", slug) : "");
      if (!path) return send(res, 400, JSON.stringify({ error: create ? "name or path required" : "path required" }));
      const added = registerProjectPath(path, create);
      setRegistryArchived(added.path, null); // adding an archived folder again restores it
      // A new folder has no config yet, so no overview until it's loaded (it opens on the welcome screen).
      if (!added.project || !projects.has(added.project.id)) { await loadProject(added.path); refreshPush(); }
      const list = listProjectsOverview();
      const project = list.find((p) => p.path === added.path) ?? null;
      return send(res, 200, JSON.stringify({ project, projects: list }));
    }
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "projects", projectId, "tasks", taskId?]
    // A deletion record, for the owner to hand to the client: /api/projects/deletion-records/<name>.html|.json
    if (parts.length === 4 && parts[2] === "deletion-records" && req.method === "GET") {
      if (who?.role !== "owner") return send(res, 403, JSON.stringify({ error: "only the owner can open deletion records" }));
      const m = /^([a-z0-9._-]+)\.(html|json)$/.exec(decodeURIComponent(parts[3]));
      const file = m && join(recordsDir(), `${m[1]}.${m[2]}`);
      if (!m || !file || !existsSync(file)) return send(res, 404, JSON.stringify({ error: "no such deletion record" }));
      if (m[2] === "html") res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      return send(res, 200, readFileSync(file, "utf8"), m[2] === "html" ? "text/html; charset=utf-8" : "application/json");
    }
    // Findings exports (Markdown, JSON, SARIF, printable HTML, HackerOne, Bugcrowd), secrets masked. Read-only.
    if (parts.length === 5 && parts[3] === "findings" && parts[4] === "export" && req.method === "GET") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      const format = url.searchParams.get("format") ?? "markdown";
      if (!(EXPORT_FORMATS as readonly string[]).includes(format)) return send(res, 400, JSON.stringify({ error: `format is one of ${EXPORT_FORMATS.join(", ")}` }));
      const out = RENDER[format as ExportFormat];
      const { config, findings } = rt.hub.snap;
      const text = out.render({ project: config.project.name, scope: config.project.scope, findings: findings ?? [], name: (id) => rt.hub.name(id), generatedAt: new Date().toISOString() });
      res.setHeader("Content-Disposition", `${format === "html" ? "inline" : "attachment"}; filename="${config.project.id}-findings.${out.ext}"`);
      // Agent-written text on HQ's own origin: no scripts, no fetches, styles only.
      if (format === "html") res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      return send(res, 200, redactor().redact(text), out.type);
    }
    // A task's history for its sheet: status and stage changes, and gate events, oldest first. Read-only.
    if (parts.length === 6 && parts[3] === "tasks" && parts[5] === "history" && req.method === "GET") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      const pid = rt.hub.snap.config.project.id;
      const taskId = decodeURIComponent(parts[4]);
      const db = hqDb();
      const events = (db.prepare("SELECT at, status, stage_id, owner_id FROM task_events WHERE project_id = ? AND task_id = ? ORDER BY at, rowid").all(pid, taskId) as { at: number; status: string; stage_id: string; owner_id: string | null }[]).map((e) => ({ at: e.at, status: e.status, stageId: e.stage_id, ownerId: e.owner_id }));
      const gates = (db.prepare("SELECT at, gate_id, state, by_id, proof FROM gate_events WHERE project_id = ? AND task_id = ? ORDER BY id").all(pid, taskId) as { at: number; gate_id: string; state: string; by_id: string; proof: string }[]).map((g) => ({ at: g.at, gateId: g.gate_id, state: g.state, by: g.by_id, note: (JSON.parse(g.proof) as { note?: string }).note ?? null }));
      return send(res, 200, redactor().redact(JSON.stringify({ events, gates })));
    }
    // The verifier's evidence files (docs/factory.md section 7): /api/projects/<id>/evidence/<task>/<sha>/<file>. Read-only.
    if (parts.length === 7 && parts[3] === "evidence" && req.method === "GET") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      const file = evidenceFile(rt.slug, decodeURIComponent(parts[4]), decodeURIComponent(parts[5]), decodeURIComponent(parts[6]));
      if (!file) return send(res, 404, JSON.stringify({ error: "no such evidence" }));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=86400, immutable"); // a commit's evidence never changes
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      res.writeHead(200, { "Content-Type": CONTENT_TYPE[file.split(".").pop()!] ?? "application/octet-stream" });
      return void res.end(readFileSync(file));
    }
    // Factory metrics (docs/factory.md section 3): the last `days` against the ones before. Read-only.
    if (parts.length === 4 && parts[3] === "metrics" && req.method === "GET") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get("days")) || 7)));
      const owner = rt.hub.snap.messages.filter((m) => m.fromId === "you").map((m) => Date.parse(m.at));
      return send(res, 200, JSON.stringify(metricsReport(hqDb(), rt.hub.snap.config.project.id, days, owner)));
    }
    // Per-agent tokens and cost over the last `days`, with a 24-slice series for sparklines. Read-only.
    if (parts.length === 4 && parts[3] === "usage" && req.method === "GET") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get("days")) || 1)));
      const now = Date.now();
      return send(res, 200, JSON.stringify({ days, agents: agentUsage(hqDb(), rt.hub.snap.config.project.id, now - days * 86_400_000, now) }));
    }
    // The command center's tile previews: each running agent's last lines, secrets masked. Read-only.
    if (parts.length === 4 && parts[3] === "screens" && req.method === "GET") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      const lines = Math.max(5, Math.min(60, Number(url.searchParams.get("lines")) || 30));
      const screens = await rt.screens(lines);
      return send(res, 200, redactor().redact(JSON.stringify({ screens, at: new Date().toISOString() })));
    }
    if (parts.length === 4 && parts[3] === "archive" && req.method === "POST") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      if (projects.size <= 1) return send(res, 400, JSON.stringify({ error: "That's the only active project. Add or restore another one first." }));
      await unloadProject(rt.slug);
      refreshPush();
      setRegistryArchived(rt.root, new Date().toISOString());
      closeSockets(rt);
      log.info(`archived ${rt.slug}`);
      return send(res, 200, JSON.stringify({ projects: listProjectsOverview() }));
    }
    if (parts.length === 4 && (parts[3] === "restore" || parts[3] === "delete") && req.method === "POST") {
      const id = decodeURIComponent(parts[2]);
      const p = listProjectsOverview().find((x) => x.id === id && x.archived);
      if (!p) return send(res, 404, JSON.stringify({ error: "no archived project with that id" }));
      if (parts[3] === "restore") {
        setRegistryArchived(p.path, null);
        await loadProject(p.path);
        refreshPush();
        return send(res, 200, JSON.stringify({ projects: listProjectsOverview() }));
      }
      if (who?.role !== "owner") return send(res, 403, JSON.stringify({ error: "only the owner can delete a project" }));
      if (remote && !elevated)
        return send(res, 403, JSON.stringify({ error: "From a remote device, confirm with your authenticator code first (any risky action asks for it), then delete again." }));
      const body = JSON.parse((await readBody(req)) || "{}") as { confirm?: string };
      if (body.confirm !== p.id) return send(res, 400, JSON.stringify({ error: `type the project id (${p.id}) to confirm` }));
      // HQ's data for it: agent folders, secrets, logs under ~/.arima/<id>, and the repo's HQ folder when git doesn't track it.
      // The repo's own files and history are never touched.
      const folders = /^[a-z0-9][a-z0-9._-]*$/.test(p.id) ? [BRAND.homeDir, ...BRAND.legacyHomeDirs].map((d) => join(homedir(), d, p.id)) : [];
      for (const d of [BRAND.repoDir, ...BRAND.legacyRepoDirs]) {
        const dir = join(p.path, d);
        if (existsSync(dir) && !(await run("git", ["ls-files", "--error-unmatch", d], { cwd: p.path })).ok) folders.push(dir);
      }
      // Forget project (docs/memory-core.md section 9): graph, tables, backups, folders; then a record for the client.
      const record = await forgetProject({ db: hqDb(), projectId: p.id, projectName: p.name, by: who.userName ?? "the owner", backupsDir: backupsDir(), folders });
      const recordName = saveRecord(record);
      if (existsSync(p.path)) await run("git", ["worktree", "prune"], { cwd: p.path });
      for (const a of p.team) releasePortBlock(p.id, a.id);
      removeFromRegistry(p.path);
      log.info(`deleted project ${p.id} (repo files kept at ${p.path}); deletion record ${recordName}`);
      return send(res, 200, JSON.stringify({ projects: listProjectsOverview(), record: recordName }));
    }
    if (parts.length === 4 && (parts[3] === "pause" || parts[3] === "resume") && req.method === "POST") {
      const rt = projects.get(decodeURIComponent(parts[2]));
      if (!rt) return send(res, 404, JSON.stringify({ error: "project not loaded" }));
      if (parts[3] === "pause") rt.pause();
      else rt.resume();
      setRegistryPaused(rt.root, rt.paused);
      return send(res, 200, JSON.stringify({ projects: listProjectsOverview() }));
    }
    if (parts.length === 4 && parts[3] === "tasks" && req.method === "POST") {
      const projectId = decodeURIComponent(parts[2]);
      const body = JSON.parse((await readBody(req)) || "{}") as {
        title?: string;
        boardId?: string;
        description?: string;
        doneWhen?: string;
        ownerId?: string;
        files?: unknown;
      };
      if (!body.title?.trim()) return send(res, 400, JSON.stringify({ error: "title required" }));
      const task = createCrossProjectTask(
        projectId,
        {
          title: body.title,
          boardId: body.boardId,
          description: body.description,
          doneWhen: body.doneWhen,
          ownerId: body.ownerId,
          files: Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string").slice(0, 50).map((f) => f.slice(0, 300)) : undefined,
        },
      );
      return send(res, 200, JSON.stringify({ task, projects: listProjectsOverview() }));
    }
    if (parts.length === 5 && parts[3] === "tasks" && (req.method === "PATCH" || req.method === "POST")) {
      const projectId = decodeURIComponent(parts[2]);
      const taskId = decodeURIComponent(parts[4]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const task = updateCrossProjectTask(projectId, taskId, body);
      return send(res, 200, JSON.stringify({ task, projects: listProjectsOverview() }));
    }
    return send(res, 404, "not found", "text/plain");
  } catch (err) {
    return send(res, 400, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}
