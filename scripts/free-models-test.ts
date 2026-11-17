// Free models: models.dev parsing, the closest replacement, auto-swap of seats whose model left the list, and the
// free fallback offered when a role has none. Run: npx tsx scripts/free-models-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-free-"));
const { parseFreeModels, closestFree, bestFree, freeSourceOf } = await import("../src/data/freeModels");
const { swapGoneModels, refreshFreeModels, freeModelsState } = await import("../server/freeModels");
const { Overflow } = await import("../server/overflow");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const m = (o: object) => ({ tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 200_000 }, cost: { input: 0, output: 0 }, release_date: "2026-08-01", ...o });
const catalog = {
  opencode: {
    models: {
      "glm-5.3-flash-free": m({ name: "GLM-5.3-Flash Free", family: "glm-flash", reasoning: true, release_date: "2026-08-26" }),
      "big-pickle": m({ name: "Big Pickle" }),
      "paid-model": m({ cost: { input: 1, output: 2 } }),
      "no-tools-free": m({ tool_call: false }),
      "tiny-free": m({ limit: { context: 8000 } }),
      "old-free": m({ status: "deprecated" }),
      "image-free": m({ modalities: { input: ["text"], output: ["image"] } }),
    },
  },
  openrouter: { models: { free: m({}), "cohere/north-mini-code:free": m({}) } },
  nvidia: { models: { "deepseek-ai/deepseek-v4.1-flash": m({ reasoning: true }) } },
  amd: { models: { "GLM-5.3-Flash": m({}) } },
  anthropic: { models: { "claude-x": m({}) } },
};
const list = parseFreeModels(catalog);
const ids = list.map((x) => x.id);
check("keeps free, tool-calling text models with enough context", ids.includes("opencode/glm-5.3-flash-free") && ids.includes("opencode/big-pickle") && ids.includes("nvidia/deepseek-ai/deepseek-v4.1-flash"), ids.join(", "));
check("drops paid, no-tools, tiny, deprecated, image-only, routers and other providers", !ids.some((i) => /paid|no-tools|tiny|old-free|image|openrouter\/free$|claude/.test(i)), ids.join(", "));
check("Zen first, best ranked first (reasoning, newer)", ids[0] === "opencode/glm-5.3-flash-free", ids[0]);
check("source from the id", freeSourceOf("nvidia/x/y") === "nvidia" && freeSourceOf("anthropic/x") === null);
check("garbage body gives an empty list", parseFreeModels(null).length === 0 && parseFreeModels("x").length === 0);

const zenOnly = (s: string) => s === "opencode";
check("closest: same source and shared name parts", closestFree("opencode/glm-5.2-flash-free", list)?.id === "opencode/glm-5.3-flash-free");
check("closest: other source when the owner has a key", closestFree("amd/GLM-5.2", list)?.id === "amd/GLM-5.3-Flash");
check("closest: skips sources without a key", closestFree("amd/GLM-5.2", list, zenOnly)?.source === "opencode");
check("best: first usable", bestFree(list, (s) => s === "nvidia")?.id === "nvidia/deepseek-ai/deepseek-v4.1-flash" && bestFree(list, () => false) === null);

// Auto-swap: roles on OpenCode whose free model (or free fallback) left the list; seats only without a template.
const patches: { roleId: string; patch: Record<string, unknown> }[] = [];
const roles = [
  { id: "qa", title: "QA", cli: "opencode", model: "opencode/glm-5.2-flash-free", fallback: null },
  { id: "dev", title: "Developer", cli: "claude", model: "claude-sonnet-5-5", fallback: { cli: "opencode", model: "opencode/gone-free" } },
  { id: "doc", title: "Docs", cli: "opencode", model: "opencode/big-pickle", fallback: null },
  { id: "rev", title: "Reviewer", cli: "opencode", model: "anthropic/claude-sonnet-4-6", fallback: null },
];
const hub = { snap: { config: { template: { roles }, team: [] } }, configChanged: () => {}, activity: () => {} };
const moved = swapGoneModels(hub as never, list, (roleId, patch) => void patches.push({ roleId, patch: patch as never }), () => true);
check("swaps a role's gone free model", patches.some((p) => p.roleId === "qa" && p.patch.model === "opencode/glm-5.3-flash-free"), JSON.stringify(patches));
check("swaps a gone free fallback", patches.some((p) => p.roleId === "dev" && (p.patch.fallback as { model: string })?.model?.startsWith("opencode/")), JSON.stringify(patches));
check("leaves listed and paid models alone", !patches.some((p) => p.roleId === "doc" || p.roleId === "rev") && moved.length === 2);
const team = [{ id: "a", name: "Ana", cli: "opencode", model: "opencode/glm-5.2-flash-free" }, { id: "d", name: "Di", cli: "claude", model: "opencode/gone-free" }];
let changed = 0;
const bare = { snap: { config: { template: null, team } }, configChanged: () => void changed++, activity: () => {} };
swapGoneModels(bare as never, list, () => {}, () => true);
check("no template: swaps the seat, saves once, leaves other CLIs", team[0].model === "opencode/glm-5.3-flash-free" && team[1].model === "opencode/gone-free" && changed === 1);
check("an empty list never swaps", swapGoneModels(hub as never, [], () => {}, () => true).length === 0);

// A failed catalog read keeps the last good list.
const good = await refreshFreeModels((async () => new Response(JSON.stringify(catalog))) as typeof fetch);
const bad = await refreshFreeModels((async () => new Response("nope", { status: 503 })) as typeof fetch);
check("refresh stores the list", good.models.length === list.length && !good.error);
check("an outage keeps the last list and reports why", bad.models.length === list.length && /503/.test(bad.error ?? "") && freeModelsState().models.length === list.length);

// Overflow: a role without a fallback is offered the free model.
const added: { title: string; move: { cli: string; model: string } }[] = [];
const seat = { id: "w", name: "Wren", roleId: "writer", isLead: false, cli: "claude", model: "claude-sonnet-5-5" };
const ovHub = { snap: { config: { template: { roles: [{ id: "writer", fallback: null }] }, team: [seat] } }, cfg: () => seat };
const planner = {
  currentTask: () => ({ id: "T1", title: "Docs", status: "in-progress" }),
  actions: { addOverflow: (move: { cli: string; model: string }, title: string) => (added.push({ title, move }), true) },
};
const ov = new Overflow(ovHub as never, planner as never, { start: async () => {}, stop: async () => {} }, () => ({ cli: "opencode", model: "opencode/glm-5.3-flash-free" }));
ov.offer("w", new Date());
check("no role fallback: offers the free model (still asks first)", added[0]?.move.cli === "opencode" && added[0].move.model === "opencode/glm-5.3-flash-free" && /OpenCode/.test(added[0].title), JSON.stringify(added));

// One-shot setup proposal.
const { proposeSetup } = await import("../src/data/teamSetup");
const role = (id: string, title: string, isLead = false) => ({ id, title, isLead, cli: "claude", model: "", fallback: null }) as never;
const roster = [role("lead", "Lead", true), role("developer", "Developer"), role("reviewer", "Reviewer"), role("docs", "Docs writer")];
const p1 = proposeSetup(roster, { ramGb: 22, cpus: 16, clis: ["claude", "agy"], keys: [], free: list });
const by = (id: string) => p1.roles.find((r) => r.roleId === id)!;
check("lead: strongest paid, no fallback", by("lead").model === "claude-opus-5-5" && by("lead").fallback === null);
check("builder: paid with a free fallback", by("developer").model === "claude-sonnet-5-5" && by("developer").fallback?.cli === "opencode");
check("light roles: free (Zen, no key), agy as their fallback", by("reviewer").free && by("reviewer").model.startsWith("opencode/") && by("docs").fallback?.cli === "agy");
check("installs opencode when missing; lists keys to add", p1.install.length === 1 && p1.keysToAdd.map((k) => k.source).join() === "openrouter,nvidia,amd");
check("sandbox 2 GB, 2 CPUs; agents that fit in 22 GB", p1.sandbox.memoryGb === 2 && p1.sandbox.cpus === 2 && p1.maxAgents === 9);
const p2 = proposeSetup(roster, { ramGb: 8, cpus: 4, clis: ["opencode"], keys: ["nvidia"], free: list.filter((x) => x.source === "nvidia") });
check("no paid CLI and only a NIM key: everyone on NIM free", p2.roles.every((r) => r.cli === "opencode" && r.model.startsWith("nvidia/")) && !p2.install.length);
const p3 = proposeSetup(roster, { ramGb: 8, cpus: 4, clis: [], keys: [], free: [] });
check("nothing usable: roles kept as they are", p3.roles.every((r) => r.cli === "claude" && /kept/.test(r.why)));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
