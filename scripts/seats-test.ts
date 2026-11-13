// Agents as seats of template roles: saved as seats, resolved at load, edited per role,
// and projects made before templates read-only. Run: npx tsx scripts/seats-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-seats-"));
const { hqDb } = await import("../server/lib/db");
const { readDoc, writeDoc } = await import("../server/lib/docs");
const { seedBuiltins } = await import("../server/templates");
const { loadConfig, saveConfig } = await import("../server/store");
const { makeCommands } = await import("../server/commands");
const { repoDirOf } = await import("../server/paths");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

seedBuiltins(hqDb());

const repoOf = (name: string) => ({ root: mkdtempSync(join(tmpdir(), `arima-${name}-`)), name, originUrl: null, github: "me/" + name, hasCodeRabbit: false, hasInsta: false });

/** A project with real config loading and saving, and stubs for everything that runs agents. */
function project(repo: ReturnType<typeof repoOf>) {
  const { config, isNew } = loadConfig(repo, 7420);
  const acts: string[] = [];
  const hub = {
    slug: config.project.id,
    repo,
    snap: { welcome: isNew, config, agents: [] as { agentId: string }[], boards: [], tasks: [] as unknown[], pullRequests: [] },
    cfg: (id: string) => hub.snap.config.team.find((a) => a.id === id),
    configChanged: () => saveConfig(repo.root, hub.snap.config),
    planChanged: () => {},
    emit: () => {},
    activity: (_t: string, _a: string | null, text: string) => acts.push(text),
  };
  const sessions = { recheckSetup: async () => {}, start: () => acts.push("started"), stop: () => acts.push("stopped") };
  const planner = { assign: () => acts.push("assigned") };
  const commands = makeCommands(hub as never, sessions as never, planner as never, {} as never, { refresh: async () => {} } as never, {} as never);
  return { hub, commands, acts };
}

// A new project picks the dev template.
const repo = repoOf("askwell");
{
  const { hub, commands } = project(repo);
  check("a new project starts with no team and no template", hub.snap.welcome && hub.snap.config.team.length === 0 && hub.snap.config.template === null);
  await commands.completeWelcome({ projectName: "Askwell", templateId: "dev", reviewTool: "human", reviewEnabled: true });
  const team = hub.snap.config.team;
  check("welcome makes the template's seats", team.map((a) => a.roleId).join() === "lead,developer,developer,reviewer,second-opinion", team.map((a) => a.roleId).join());
  check("seats run their role's CLI and model", team[1].cli === "claude" && team[1].model === "claude-sonnet-5-5" && team[3].cli === "codex" && team[4].cli === "agy" && team[4].model === "gemini-4-argon-high");
  check("every seat has its own colour", new Set(team.map((a) => a.color)).size === team.length);
  check("the dev flow works in pull requests", hub.snap.config.workflow.mode === "github-pr");

  const saved = readDoc<{ team: Record<string, unknown>[]; template?: unknown }>(join(repoDirOf(repo.root), "config.json"))!;
  check("config.json keeps seats only", saved.team.every((a) => a.roleId && !("cli" in a) && !("roleMd" in a) && !("skills" in a)) && !("template" in saved));

  commands.updateRole("developer", { model: "claude-opus-5-5" });
  check("a role edit reaches every seat of the role", team.filter((a) => a.roleId === "developer").every((a) => a.model === "claude-opus-5-5"));
  check("…and no other role", team[0].model === "claude-opus-5-5" && team[3].model === "gpt-6.1-sol");

  commands.updateAgent(team[1].id, { roleId: "reviewer", name: "Mira" });
  check("a seat can move to another role", hub.snap.config.team[1].roleId === "reviewer" && hub.snap.config.team[1].cli === "codex" && hub.snap.config.team[1].name === "Mira");
  commands.updateAgent(team[0].id, { roleId: "developer" });
  check("the lead's seat stays the lead's", hub.snap.config.team[0].isLead);

  commands.addAgent({ name: "Sol", roleId: "developer", mode: "local" });
  check("an added agent is a seat of the chosen role", hub.snap.config.team.at(-1)?.roleId === "developer" && hub.snap.config.team.at(-1)?.cli === "claude");
  const before = hub.snap.config.team.length;
  commands.addAgent({ name: "Two", roleId: "lead", mode: "local" });
  check("a second lead can't be added", hub.snap.config.team.length === before);
}

// Loading again resolves the seats from the project's template copy.
{
  const { hub } = project(repo);
  const team = hub.snap.config.team;
  check("a reload resolves seats from the template copy", team.length === 6 && team[2].model === "claude-opus-5-5" && team[1].name === "Mira");
  check("a reload is not read-only", hub.snap.config.template?.id === "dev");
}

// A project made before templates is read-only.
{
  const old = repoOf("lab");
  writeDoc(join(repoDirOf(old.root), "config.json"), {
    project: { id: "lab", name: "Lab", repo: "me/lab", path: "", hqPort: 7420, type: "security" },
    team: [{ id: "zero", name: "Zero", role: "Red Team Commander", isLead: true, cli: "claude", model: "", mode: "local", color: "#f00", skills: [], roleMd: "x", sandbox: { resources: { cpus: null, memoryGb: null }, allow: [], deny: [] }, workspacePath: null }],
    workflow: { mode: "deliverables", review: { enabled: true, tool: "human", command: "" }, merge: { by: "human" }, deploy: { enabled: false, tool: "custom", command: "", perAgentEnvironments: false } },
  });
  const { hub, commands, acts } = project(old);
  check("an old project has no template", hub.snap.config.template === null && !hub.snap.welcome);
  check("its old type still gives its rules", hub.snap.config.rules.findings && hub.snap.config.rules.scopeRequired);
  commands.startAgent("zero");
  commands.assignTask("T1", "zero");
  commands.updateProject({ name: "Renamed" });
  check("starts, assignments and edits are refused", !acts.includes("started") && !acts.includes("assigned") && hub.snap.config.project.name === "Lab");
  check("the refusal says why", acts.some((a) => a.includes("read-only")));
  commands.stopAgent("zero");
  check("stopping is still allowed", acts.includes("stopped"));
  saveConfig(old.root, hub.snap.config);
  const saved = readDoc<{ project: { type?: string }; team: { roleMd?: string }[] }>(join(repoDirOf(old.root), "config.json"))!;
  check("saving an old project keeps it as it was", saved.project.type === "security" && saved.team[0].roleMd === "x");
}

// The whole team to Container mode (3.8): stopped seats now, running ones at their next start; saved as seats.
{
  const r = repoOf("teammode");
  const { hub, commands } = project(r);
  await commands.completeWelcome({ projectName: "Teammode", templateId: "dev", reviewTool: "human", reviewEnabled: true });
  const team = hub.snap.config.team;
  const running = team[1].id;
  (hub as unknown as { status: (id: string) => unknown }).status = (id: string) => ({ session: { state: id === running ? "running" : "stopped" } });
  const before = team[1].mode;
  await commands.setTeamMode("container");
  check("stopped seats switch now", team.filter((a) => a.id !== running).every((a) => a.mode === "container" && !a.nextMode), JSON.stringify(team.map((a) => [a.id, a.mode, a.nextMode])));
  check("a running seat keeps its mode until its next start", team[1].mode === before && team[1].nextMode === "container");
  const saved = loadConfig(r, 7420).config.team;
  check("the pending switch is saved with the seat", saved[1].nextMode === "container" && saved[1].mode === before && saved[0].mode === "container", JSON.stringify(saved.map((a) => [a.mode, a.nextMode])));
  await commands.updateAgent(running, { mode: before });
  check("choosing its current mode again cancels the pending switch", team[1].mode === before && !team[1].nextMode);
  let err = "";
  try {
    await commands.setTeamMode("cloud");
  } catch (e) {
    err = (e as Error).message;
  }
  check("an unknown mode is refused", /local, sandbox or container/.test(err));
}

// The next start applies a pending switch (before anything else can fail).
{
  const { Sessions } = await import("../server/sessions");
  const agent = { id: "dev1", name: "Dev", mode: "local", nextMode: "container", cli: "claude", isLead: false } as Record<string, unknown>;
  const notes: string[] = [];
  const hub = {
    slug: "switch", snap: { setup: { checks: [] }, config: { team: [agent], project: { id: "switch", hqPort: 7420 } }, agents: [] },
    cfg: () => agent, status: () => ({ session: { state: "stopped" } }), setSession: () => {}, setStatus: () => {},
    activity: (_t: string, _a: string | null, text: string) => notes.push(text), configChanged: () => notes.push("saved"),
  };
  await new Sessions(hub as never, "t").start("dev1");
  check("starting a seat with a pending switch starts it in the new mode", agent.mode === "container" && !agent.nextMode && notes.includes("saved") && notes.some((n) => /switches to container mode/.test(n)), JSON.stringify(notes));
}

if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
