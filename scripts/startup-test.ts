// The Startup template: a valid template, drafts only per role (marketing, sales and support can't reach mail,
// social or CRM hosts or attach such MCP servers; the designer and analyst can), owner approval only for
// high-stakes tasks, and its rituals on schedule (once a day, inside their window, skipped when the team was idle).
//
//   npx tsx scripts/startup-test.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-startup-"));
const { STARTUP_TEMPLATE } = await import("../src/data/commsTemplates");
const { templateErrors } = await import("../src/data/model");
const { draftsOnly, isOutboundHost, outboundMcpProblem } = await import("../src/data/outbound");
const { gateProblem } = await import("../server/gates");
const { dueRituals, ritualWhen, tickRituals } = await import("../server/rituals");
const { hqDb } = await import("../server/lib/db");
const { flowMode } = await import("../server/templates");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const t = STARTUP_TEMPLATE;
check("the template is valid", templateErrors(t).length === 0, templateErrors(t).join(" | "));
check("it works in deliverables (no pull requests)", flowMode(t) === "deliverables");

// ---------------------------------------------------------------- drafts only, per role
const team = t.roles.map((r) => ({ id: `${r.id}1`, roleId: r.id }));
const cfg = { team, template: t, rules: t.rules };
const seat = (roleId: string) => draftsOnly(cfg, `${roleId}1`);
check("marketing, sales and support seats are drafts only", seat("marketer") && seat("sales") && seat("support"));
check("the lead, designer and analyst aren't", !seat("lead") && !seat("designer") && !seat("analyst"));
check("no agent: the project's rule", draftsOnly(cfg) === false && draftsOnly({ ...cfg, rules: { outbound: "drafts-only" } }) === true);
check("a role can lift a drafts-only project for its seats", !draftsOnly({ team, template: { roles: [{ id: "designer", outbound: "none" }] }, rules: { outbound: "drafts-only" } }, "designer1"));
// What sbxMcp.allowedNames and the proxy decide for a seat: refused when the seat is drafts only and the server or host sends.
const attachable = (roleId: string, name: string) => !(seat(roleId) && outboundMcpProblem(name));
check("a drafts-only seat never gets a CRM or mail MCP server", !attachable("sales", "hubspot") && !attachable("marketer", "gmail") && !attachable("support", "intercom"));
check("…the analyst can attach it (read-only rules come separately)", attachable("analyst", "hubspot"));
const reachable = (roleId: string, host: string) => !(seat(roleId) && isOutboundHost(host));
check("the proxy blocks a sales seat from the CRM, not the designer", !reachable("sales", "api.hubapi.com") && reachable("designer", "api.hubapi.com"));

// ---------------------------------------------------------------- owner approval only when high-stakes
const gate = t.flow.stages.at(-1)!.gates[0];
const ctx = (task: object) => ({ task: { id: "T1", files: [], ...task }, actor: { kind: "agent", id: "lead1" }, roleOf: () => "lead", prs: [], scopeSet: true, events: [] }) as never;
check("a routine task doesn't wait for the owner", gateProblem(gate, ctx({})) === null);
check("a high-stakes one does", /owner's approval/.test(gateProblem(gate, ctx({ highStakes: true })) ?? ""));
check("templates without `when` keep approving everything", /owner's approval/.test(gateProblem({ id: "send-ok", kind: "owner-approval", reason: "outbound" }, ctx({})) ?? ""));
check("a bad `when` is refused", templateErrors({ ...t, flow: { stages: [...t.flow.stages.slice(0, -1), { ...t.flow.stages.at(-1)!, gates: [{ ...gate, when: "sometimes" } as never] }] } }).some((e) => /"when"/.test(e)));

// ---------------------------------------------------------------- rituals
const rituals = t.rituals!;
const mon9 = new Date(2026, 10, 2, 9, 5); // Monday 2 Nov 2026, the first Monday
check("Monday 09:05: the plan is due", dueRituals(rituals, mon9, {}).map((r) => r.id).join() === "monday-plan");
check("…not again the same day", dueRituals(rituals, mon9, { "monday-plan": "2026-11-02" }).length === 0);
check("…and not hours late after a restart", dueRituals(rituals, new Date(2026, 10, 2, 13, 0), {}).length === 0);
check("first Monday 11:00: the numbers review", dueRituals(rituals, new Date(2026, 10, 2, 11, 0), {}).some((r) => r.id === "numbers-review"));
check("…not on the second Monday", !dueRituals(rituals, new Date(2026, 10, 9, 11, 0), {}).some((r) => r.id === "numbers-review"));
check("Friday 16:30: the retro", dueRituals(rituals, new Date(2026, 10, 6, 16, 30), {}).map((r) => r.id).join() === "friday-retro");
check("schedules read plainly", ritualWhen(rituals[0]) === "Mondays at 09:00" && ritualWhen(rituals[2]) === "The first Monday of the month at 11:00" && ritualWhen({ hour: 18 }) === "Every day at 18:00");
const bad = templateErrors({ ...t, rituals: [{ id: "x", title: "X", hour: 25, day: 9, prompt: "" }, { id: "y", title: "Y", hour: 9, monthly: true, prompt: "go" }] });
check("bad rituals are refused", bad.filter((e) => /Ritual/.test(e)).length === 4, bad.join(" | "));

{
  const db = hqDb();
  const ran: string[] = [];
  const skipped: string[] = [];
  let messages: { at: string }[] = [];
  const host = { projectId: "co", rituals: () => rituals, enabled: () => true, messages: () => messages, run: (r: { id: string }, p: string) => ran.push(`${r.id}:${p.split("\n")[0]}`), skipped: (r: { id: string }) => skipped.push(r.id) };
  tickRituals(db, host, mon9);
  tickRituals(db, host, new Date(2026, 10, 2, 9, 30));
  check("the first run goes to the lead once", ran.length === 1 && ran[0] === "monday-plan:Scheduled ritual: Monday plan (Mondays at 09:00).", ran.join("|"));
  tickRituals(db, host, new Date(2026, 10, 9, 9, 1));
  check("a week with nothing moving: skipped", ran.length === 1 && skipped.join() === "monday-plan");
  messages = [{ at: new Date(2026, 10, 12).toISOString() }];
  tickRituals(db, host, new Date(2026, 10, 16, 9, 1));
  check("a week with activity: it runs", ran.length === 2);
  const off = { ...host, enabled: () => false };
  tickRituals(db, off, new Date(2026, 10, 23, 9, 1));
  check("turned off or paused: nothing", ran.length === 2 && skipped.length === 1);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
