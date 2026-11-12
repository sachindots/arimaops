// The task brief: every section, the 4,000-token budget, and the order it cuts in.
// Run: npx tsx scripts/brief-test.ts
import type { BriefInput } from "../src/data/model";
import { BRIEF_BUDGET } from "../src/data/model";
import { buildBrief, estimateTokens } from "../server/brief";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  task: { id: "B1-T03", title: "Add --json", description: "Print findings as JSON.", files: ["report.go"], doneWhen: "go test passes" },
  spec: "The CLI prints JSON when asked.",
  handoffs: [{ taskId: "B1-T01", by: "Ghost", note: "Parser lives in parse.go" }],
  ledger: [{ kind: "fact", text: "CI runs go 1.26" }],
  memory: "",
  facts: ["Build: go build ./...", "Test: go test ./..."],
  skills: ["ponytail", "pstack-deslop"],
  gates: [{ id: "merged", kind: "pr-merged", needs: "Code tasks finish only after their linked PR is merged." }],
  ...over,
});

const small = buildBrief(input());
check("a small brief keeps every section", ["# B1-T03: Add --json", "Files you may edit: report.go", "Done when: go test passes", "## Gates before done", "## Spec", "## Handoffs", "## Lead's ledger", "## Repo facts", "## Skills"].every((x) => small.text.includes(x)), small.text);
check("a small brief cuts nothing", small.trimmed.length === 0 && !small.text.includes("Left out"));
check("empty sections are left out", !small.text.includes("## Memory"));
check("its token count is the estimate of its text", small.tokens === estimateTokens(small.text));

// Over budget: each section big enough to matter, then the cuts in order.
const big = input({
  handoffs: Array.from({ length: 8 }, (_, i) => ({ taskId: `B1-T0${i}`, by: "Ghost", note: words(120, `h${i}-`) })),
  ledger: Array.from({ length: 10 }, (_, i) => ({ kind: "fact" as const, text: words(80, `l${i}-`) })),
  memory: words(800, "m"),
  facts: Array.from({ length: 40 }, (_, i) => words(20, `f${i}-`)),
  spec: words(1500, "s"),
  task: { ...input().task, description: words(1500, "d") },
});
const fit = buildBrief(big);
check("an over-budget brief stays within 4,000 tokens", fit.tokens <= BRIEF_BUDGET, String(fit.tokens));
check("older handoffs go first, the newest stays longest", !fit.text.includes("h0-0") && fit.trimmed.some((t) => t.includes("handoffs")));
check("it says what it left out", fit.text.includes("_Left out to fit the brief:"));
check("the task's title, files and done-when always stay", fit.text.includes("# B1-T03: Add --json") && fit.text.includes("Done when: go test passes"));
check("the gates always stay", fit.text.includes("merged (pr-merged)"));

const order = (over: Partial<BriefInput>, budget: number) => buildBrief(input(over), budget).trimmed;
const handoffsOnly = order({ handoffs: Array.from({ length: 4 }, (_, i) => ({ taskId: `T${i}`, by: null, note: words(200, `h${i}-`) })), ledger: [{ kind: "plan", text: words(100, "l") }] }, 600);
check("handoffs are cut before the ledger", handoffsOnly.some((t) => t.includes("handoffs")) && !handoffsOnly.some((t) => t.includes("ledger")), handoffsOnly.join());
const ledgerBeforeMemory = order({ handoffs: [], ledger: Array.from({ length: 4 }, () => ({ kind: "fact" as const, text: words(200, "l") })), memory: words(150, "m") }, 500);
check("the ledger is cut before memory", ledgerBeforeMemory.some((t) => t.includes("ledger")) && !ledgerBeforeMemory.includes("memory"), ledgerBeforeMemory.join());
const factsBeforeSpec = order({ handoffs: [], ledger: [], facts: Array.from({ length: 20 }, () => words(40, "f")), spec: words(100, "s") }, 600);
check("repo facts are cut before the spec", factsBeforeSpec.some((t) => t.includes("facts")) && !factsBeforeSpec.includes("spec"), factsBeforeSpec.join());
const specBeforeTask = order({ handoffs: [], ledger: [], facts: [], spec: words(800, "s"), task: { ...input().task, description: words(200, "d") } }, 600);
check("the spec is cut before the task description", specBeforeTask.includes("spec") && !specBeforeTask.includes("task description"), specBeforeTask.join());

const giant = buildBrief(input({ task: { ...input().task, title: words(5000, "t"), files: Array.from({ length: 500 }, (_, i) => `src/f${i}.go`) } }));
check("even fixed parts too big for the budget are cut to fit", giant.tokens <= BRIEF_BUDGET, String(giant.tokens));

if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
