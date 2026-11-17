// Working as a team: company context and charter in the role file, each teammate's strengths and track record,
// asking the whole team through the lead, an agent's reply pushed to your phone, and structured handoffs.
//
//   npx tsx scripts/team-test.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-team-"));
const { saveCompany, companyText, COMPANY_MAX } = await import("../server/company");
const { roleMd } = await import("../server/agentFiles");
const { seatRecords } = await import("../server/metrics");
const { hqDb } = await import("../server/lib/db");
const { Planner } = await import("../server/planner");
const { Inbox } = await import("../server/inbox");
const { pushAlert } = await import("../server/push");
const { withHandoff } = await import("../server/mcp");
const { DEV_TEMPLATE } = await import("../src/data/templates");
const { resolveSeat, seatsFor } = await import("../server/templates");
const { escalateDisagreement, checkQuestions } = await import("../server/conversations");
const { standupNote } = await import("../server/standup");
const { CHATTER_PER_HOUR } = await import("../server/planner");
const { mentioned } = await import("../src/data/mentions");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

// ---------------------------------------------------------------- company context and charter
check("the company text is saved, trimmed and capped", saveCompany(`  We sell Askwell.\r\n${"x".repeat(5000)}`).length === COMPANY_MAX && companyText().startsWith("We sell Askwell.\n"));
saveCompany("We sell Askwell, a support inbox for small shops. Voice: plain, no hype.");
const seats = seatsFor(DEV_TEMPLATE).map((s) => resolveSeat(DEV_TEMPLATE, s));
const lead = seats.find((a) => a.isLead)!;
const worker = seats.find((a) => !a.isLead)!;
const withSkills = seats.map((a) => (a.id === worker.id ? { ...a, skills: ["react", "playwright"] } : a));
const cfg = { project: { id: "p", name: "P", repo: "", path: "/x", hqPort: 7420, charter: "Ghost owns server/. Disagree once with evidence; the lead decides." }, team: withSkills, template: DEV_TEMPLATE, workflow: { mode: "github-pr", review: { enabled: true }, merge: { by: "human" }, deploy: { enabled: false } }, rules: DEV_TEMPLATE.rules } as never;
const md = roleMd(lead, cfg);
check("every role file has the company", md.includes("## The company") && md.includes("support inbox for small shops"));
check("and the project's team charter", md.includes("## Team charter") && md.includes("the lead decides"));
check("teammates are listed with their strengths", md.includes(`${worker.name} (${worker.role}): react, playwright`), md.split("## Working with teammates")[1]?.slice(0, 400));
saveCompany("");
check("no company text, no section", !roleMd(lead, cfg).includes("## The company"));

// ---------------------------------------------------------------- track record
{
  const db = hqDb(mkdtempSync(join(tmpdir(), "arima-team-db-")));
  db.prepare("INSERT INTO boards (project_id, id, title, status, ord) VALUES ('p', 'B1', 'b', 'active', 0)").run();
  db.prepare("INSERT INTO tasks (project_id, id, board_id, stage_id, title, status, updated_at) VALUES ('p', 'T2', 'B1', 'build', 't', 'done', 0)").run();
  db.prepare("INSERT INTO gate_events (project_id, task_id, gate_id, state, by_kind, by_id, at) VALUES ('p', 'T2', 'review', 'failed', 'agent', 'nyx', 0)").run();
  const r = seatRecords(db, "p", [
    { id: "T1", ownerId: "ghost", status: "done", files: ["server/hooks.ts", "server/inbox.ts"] },
    { id: "T2", ownerId: "ghost", status: "done", files: ["server/lib/db.ts"] },
    { id: "T3", ownerId: "ghost", status: "in-progress", files: ["src/a.ts"] },
    { id: "T4", ownerId: "vortex", status: "done", files: ["src/ui/x.tsx", "src/ui/y.tsx", "README.md"] },
  ]);
  check("done and first-pass counts per seat (a failed gate counts against it)", r.get("ghost")?.done === 2 && r.get("ghost")?.firstPass === 1, JSON.stringify(r.get("ghost")));
  check("areas are the folders it touched most", r.get("ghost")?.areas[0] === "server" && r.get("vortex")?.areas.join() === "src/ui,(root)", JSON.stringify([...r]));
  check("unfinished work doesn't count", !r.get("ghost")?.areas.includes("src"));
}

// ---------------------------------------------------------------- ask the team
{
  const team = [{ id: "cipher", name: "Cipher", isLead: true }, { id: "ghost", name: "Ghost", isLead: false }];
  const status = new Map(team.map((a) => [a.id, { agentId: a.id, state: "idle", currentTaskId: null, session: { state: "running" } }]));
  const snap = { config: { team, project: { id: "p" } }, boards: [], tasks: [], messages: [] as { team?: boolean; toId: string; fromId: string }[], agents: [...status.values()] };
  const hub = { slug: "t", repo: { root: "/x" }, snap, cfg: (id: string) => team.find((a) => a.id === id), name: (id: string) => team.find((a) => a.id === id)?.name ?? "You",
    status: (id: string) => status.get(id), setStatus: () => {}, emit: () => {}, planChanged: () => {}, activity: () => {} };
  const typed: string[] = [];
  const inbox = new Inbox(hub as never, { type: async (_id, text) => (typed.push(text), true), enter: async () => true });
  const planner = new Planner(hub as never, inbox);
  planner.askTeam("Is the export ready for Friday?");
  check("a team question goes to the lead, marked as one", snap.messages[0]?.toId === "cipher" && snap.messages[0]?.team === true && snap.messages[0]?.fromId === "you");
  inbox.sessionReattached("cipher");
  await inbox.tryType("cipher");
  check("the lead is told to ask who knows and answer once", /Question for the whole team/.test(typed[0] ?? "") && /answer the human once/.test(typed[0] ?? ""), typed[0]);
  inbox.stop();
  const lone = new Planner({ ...hub, snap: { ...snap, config: { ...snap.config, team: [team[1]] } } } as never, inbox);
  check("no lead: a clear refusal", (() => { try { lone.askTeam("hi"); return false; } catch (e) { return /no lead/.test((e as Error).message); } })());
}

// ---------------------------------------------------------------- your phone
{
  const hub = { slug: "p", snap: { config: { project: { name: "P" }, team: [{ id: "ghost", name: "Ghost" }] } } };
  const reply = pushAlert(hub as never, { type: "message", message: { id: "m1", at: "", fromId: "ghost", toId: "you", text: "Export is done, one risk in my handoff." } });
  check("an agent's message to you is pushed with its text", !!reply && /Ghost wrote/.test(reply.title) && reply.body.includes("Export is done") && reply.path.includes("agent%3Aghost"), JSON.stringify(reply));
  check("your own messages and agent-to-agent ones aren't", !pushAlert(hub as never, { type: "message", message: { id: "m2", at: "", fromId: "you", toId: "ghost", text: "x" } }) &&
    !pushAlert(hub as never, { type: "message", message: { id: "m3", at: "", fromId: "ghost", toId: "cipher", text: "x" } }));
}

// ---------------------------------------------------------------- handoffs
const h = withHandoff("Export endpoint added.", { changed: ["server/export.ts", "src/ui/Export.tsx"], verified: "pnpm test export: 12 passed", risks: "large shops not tried" });
check("a handoff is the note plus changed, verified and risks", h === "Export endpoint added.\nChanged: server/export.ts, src/ui/Export.tsx\nVerified: pnpm test export: 12 passed\nRisks: large shops not tried", h);
check("no handoff leaves the note as it was", withHandoff("just a note", undefined) === "just a note" && withHandoff(undefined, { notify: ["Ghost"] }) === undefined);

// ---------------------------------------------------------------- questions and disagreements
{
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const team = [{ id: "cipher", isLead: true }, { id: "ghost", isLead: false }, { id: "nyx", isLead: false }];
  const sent: string[] = [];
  const ctx = (messages: unknown[]) => ({ snap: { messages, config: { team } } as never, name: (id: string) => id, escalated: new Set<string>(),
    notify: (id: string, t: string) => sent.push(`${id}:${t}`), toOwner: (t: string) => sent.push(`you:${t}`) });
  const d = (id: string, from: string, to: string, at = ago(1)) => ({ id, at, fromId: from, toId: to, text: `${from} says no`, kind: "disagree", taskId: "T1" });
  const one = ctx([d("m1", "ghost", "nyx")]);
  escalateDisagreement(one, "ghost", "nyx", "T1");
  check("one disagreement stays between the two", sent.length === 0);
  const two = ctx([d("m2", "nyx", "ghost"), d("m1", "ghost", "nyx")]);
  escalateDisagreement(two, "nyx", "ghost", "T1");
  escalateDisagreement(two, "nyx", "ghost", "T1");
  check("a second one goes to the lead to decide, once", sent.length === 1 && sent[0].startsWith("cipher:") && /Decide/.test(sent[0]), sent.join("|"));
  sent.length = 0;
  escalateDisagreement(ctx([d("m2", "cipher", "ghost"), d("m1", "ghost", "cipher")]), "cipher", "ghost", "T1");
  check("when the lead is one of them, the owner decides", sent.length === 1 && sent[0].startsWith("you:"), sent.join("|"));
  sent.length = 0;
  escalateDisagreement(ctx([d("m2", "nyx", "ghost"), d("m1", "ghost", "nyx", ago(90))]), "nyx", "ghost", "T1");
  check("disagreements more than an hour apart don't add up", sent.length === 0);

  const q = (id: string, at: string) => ({ id, at, fromId: "ghost", toId: "nyx", text: "which schema?", kind: "question" });
  sent.length = 0;
  const qs = ctx([q("q1", ago(20)), q("q2", ago(5))]);
  checkQuestions(qs, Date.now());
  checkQuestions(qs, Date.now());
  check("a question unanswered for 15 min goes to the lead once; a fresh one waits", sent.length === 1 && /which schema/.test(sent[0]) && sent[0].startsWith("cipher:"), sent.join("|"));
  sent.length = 0;
  checkQuestions(ctx([{ id: "a1", at: ago(10), fromId: "nyx", toId: "ghost", text: "v2" }, q("q1", ago(20))]), Date.now());
  check("an answered question isn't escalated", sent.length === 0);
}

// ---------------------------------------------------------------- chatter cap
{
  const team = [{ id: "cipher", name: "Cipher", isLead: true }, { id: "ghost", name: "Ghost", isLead: false }];
  const recent = Array.from({ length: CHATTER_PER_HOUR }, (_, i) => ({ id: `x${i}`, at: new Date().toISOString(), fromId: "ghost", toId: "cipher", text: `note ${i}` }));
  const activity: string[] = [];
  const snap = { config: { team, project: { id: "p" } }, boards: [], tasks: [], messages: [...recent], agents: [] };
  const hub = { slug: "t", repo: { root: "/x" }, snap, cfg: (id: string) => team.find((a) => a.id === id), name: (id: string) => team.find((a) => a.id === id)?.name ?? "You",
    status: () => undefined, setStatus: () => {}, emit: () => {}, planChanged: () => {}, activity: (_k: string, _a: string, t: string) => activity.push(t) };
  const inbox = new Inbox(hub as never, { type: async () => true, enter: async () => true });
  const planner = new Planner(hub as never, inbox);
  snap.messages = [...recent]; // the inbox loads saved history on start
  const capped = (() => { try { planner.message("ghost", "cipher", "one more"); return false; } catch (e) { return /Not sent/.test((e as Error).message); } })();
  check("an agent over the hourly cap is refused, and the drop is shown", capped && activity.some((t) => /was not sent/.test(t)), activity.join("|"));
  check("it can still write to the owner", planner.message("ghost", "you", "I'm stuck on the schema") === "you");
  inbox.stop();
}

// ---------------------------------------------------------------- routing
{
  const team = [{ id: "a1", name: "A1", roleId: "dev" }, { id: "a2", name: "A2", roleId: "dev" }];
  const tasks = [{ id: "D1", ownerId: "a2", status: "done", files: ["server/billing/plan.ts"], needs: [] }];
  const snap = { config: { team, project: { id: "p" }, template: { roles: [{ id: "dev", title: "Dev" }] } }, tasks, messages: [], agents: [] };
  const hub = { snap, cfg: (id: string) => team.find((a) => a.id === id), status: () => ({ session: { state: "stopped" } }) };
  const planner = new Planner(hub as never, { push() {}, save() {} } as never);
  const seat = (files: string[]) => planner.seatOf("dev", { id: "N", files, needs: [] } as never);
  check("equally free seats: the one that worked in the task's folder gets it", seat(["server/billing/invoice.ts"]) === "a2" && seat(["src/ui/x.tsx"]) === "a1");
  tasks.push({ id: "W", ownerId: "a2", status: "in-progress", files: [], needs: [] });
  check("load still wins over familiarity", seat(["server/billing/invoice.ts"]) === "a1");
}

// ---------------------------------------------------------------- @mentions in the team thread
{
  const team = [{ id: "ghost", name: "Ghost" }, { id: "nyx", name: "Nyx" }, { id: "ops-1", name: "Mary Ann" }];
  check("@Name and @id pick agents; email-like text and partial names don't",
    mentioned(team, "@ghost and @Mary Ann, check this").join() === "ghost,ops-1" && mentioned(team, "@ops-1 ok").join() === "ops-1" &&
    mentioned(team, "mail a@nyx.dev or @Ghostly").length === 0 && mentioned(team, "is the export ready?").length === 0);
}

// ---------------------------------------------------------------- standup
{
  const db = hqDb(mkdtempSync(join(tmpdir(), "arima-team-standup-")));
  const since = Date.now() - 3_600_000;
  db.prepare("INSERT INTO task_events (project_id, task_id, at, status, stage_id, owner_id) VALUES ('p', 'T1', ?, 'done', 'merge', 'ghost')").run(Date.now());
  const snap = (tasks: unknown[]) => ({ config: { project: { id: "p" }, team: [{ id: "ghost", name: "Ghost" }] }, tasks, agents: [], actionItems: [] }) as never;
  const note = standupNote(db, snap([{ id: "T1", title: "Export", status: "done" }, { id: "T2", title: "Billing", status: "in-progress", ownerId: "ghost" }, { id: "T3", title: "Login", status: "blocked", note: "needs the API key" }]), "evening", since);
  check("the standup lists done, moving and blocked work", !!note && /Done \(1\): T1 Export/.test(note) && /T2 Billing \(Ghost\)/.test(note) && /T3 Login: needs the API key/.test(note), note ?? "null");
  check("nothing happened: no standup", standupNote(db, snap([]), "evening", Date.now() + 1000) === null);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
