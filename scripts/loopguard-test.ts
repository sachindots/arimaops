// Stuck-agent detection from tool hooks. Run: npx tsx scripts/loopguard-test.ts
import { LoopGuard, toolEvent, type Verdict } from "../server/loopguard";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const tick = () => new Promise((r) => setTimeout(r, 10));

// Payload shapes
const claudeFail = toolEvent("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "go test ./..." }, error: "FAIL internal/x 0.01s\nmore" });
check("claude failure parsed", claudeFail?.failed === true && claudeFail.command === "go test ./..." && claudeFail.error === "FAIL internal/x 0.01s", JSON.stringify(claudeFail));
const codexFail = toolEvent("PostToolUse", { tool_name: "exec_command", tool_input: { command: ["go", "vet"] }, tool_response: { exit_code: 1, stderr: "vet: bad" } });
check("codex non-zero exit is a failure", codexFail?.failed === true && codexFail.command === "go vet" && codexFail.error === "vet: bad", JSON.stringify(codexFail));
const agyOk = toolEvent("PostToolUse", { toolCall: { name: "read_file", args: { path: "a.go" } }, result: {} });
check("agy success parsed", agyOk?.failed === false && agyOk.tool === "read_file" && agyOk.command === "a.go");
check("no tool name → ignored", toolEvent("PostToolUse", {}) === null);

const ok = { tool: "Read", command: "x.go", failed: false, error: "" };
const fail = (n: number) => ({ tool: "Bash", command: "go test ./...", failed: true, error: `FAIL at line ${n}` });

// Productive agent: many calls, no repeated failure → never judged.
{
  let judged = 0;
  const g = new LoopGuard(async () => (judged++, null), () => {});
  for (let i = 0; i < 40; i++) g.record("a", "T1", "t", ok);
  await tick();
  check("productive agent is never judged", judged === 0);
}

// Same failure repeated after the gate size → judge called once, nudge once.
{
  let judged = 0;
  const nudges: string[] = [];
  const g = new LoopGuard(async (): Promise<Verdict> => (judged++, { stuck: true, confidence: 0.9, reason: "same test failing" }), (_a, _t, n) => nudges.push(n));
  for (let i = 0; i < 16; i++) g.record("a", "T1", "Fix parser", ok);
  g.record("a", "T1", "Fix parser", fail(1));
  g.record("a", "T1", "Fix parser", fail(2)); // line number differs: same signature
  await tick();
  for (let i = 0; i < 15; i++) g.record("a", "T1", "Fix parser", fail(3));
  await tick();
  check("repeated failure opens the gate, judge called once", judged === 1, String(judged));
  check("one nudge per task", nudges.length === 1 && nudges[0].includes("go test ./...") && nudges[0].includes("same test failing"), nudges.join(" | "));
}

// Judge says progress → no nudge; no judge available → strict fallback rule.
{
  const nudges: string[] = [];
  const spare = new LoopGuard(async () => ({ stuck: false, confidence: 0.9, reason: "narrowing" }), (_a, _t, n) => nudges.push(n));
  for (let i = 0; i < 17; i++) spare.record("a", "T1", "t", ok);
  for (let i = 0; i < 3; i++) spare.record("a", "T1", "t", fail(i));
  await tick();
  check("judge's 'not stuck' is respected", nudges.length === 0);

  const offline = new LoopGuard(async () => null, (_a, _t, n) => nudges.push(n));
  for (let i = 0; i < 17; i++) offline.record("a", "T1", "t", ok);
  offline.record("a", "T1", "t", fail(1));
  offline.record("a", "T1", "t", fail(2));
  await tick();
  check("no judge: 2 repeats isn't enough", nudges.length === 0);
  for (let i = 0; i < 10; i++) offline.record("a", "T1", "t", fail(3));
  await tick();
  check("no judge: 3+ repeats nudges", nudges.length === 1);
}

// A new task starts a fresh window.
{
  let judged = 0;
  const g = new LoopGuard(async () => (judged++, null), () => {});
  for (let i = 0; i < 17; i++) g.record("a", "T1", "t", ok);
  g.record("a", "T2", "t", fail(1));
  g.record("a", "T2", "t", fail(2));
  await tick();
  check("calls don't carry over to the next task", judged === 0);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
