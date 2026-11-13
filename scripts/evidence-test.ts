// The evidence gate and the verifier (docs/factory.md section 7): a PR that changes UI files can't pass review without
// screenshots of the running app at its head commit; the verifier is asked once per commit; evidence is copied from its
// workspace only, kept in HQ, shown on the task, and commented on the PR.
// Run: npx tsx scripts/evidence-test.ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gate } from "../src/data/model";
import type { PullRequest, Task } from "../src/data/types";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-evidence-"));
const { assertGates, gateProblem, uiFilesOf, OBSERVED_GATES } = await import("../server/gates");
const { saveEvidence, latestEvidence, evidenceFile, kindOf, prComment } = await import("../server/evidence");
const { DEV_TEMPLATE } = await import("../src/data/templates");
const { templateErrors } = await import("../src/data/model");
const { imageFor, VERIFIER_IMAGE, IMAGE } = await import("../server/containers");
const { Planner } = await import("../server/planner");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const task: Task = { id: "B1-T01", boardId: "B1", stageId: "review", title: "Settings page", ownerId: "dev1", status: "in-review", needs: [], prNumber: 7, doneWhen: "x", note: "y" };
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, title: "[B1-T01] Settings", taskId: "B1-T01", authorId: "dev1", review: "passed", openComments: 0, mergeable: true, merged: false, openedAt: "", files: ["src/Settings.tsx", "src/api.ts"], headSha: SHA1, ...over });
const ctx = (over: object = {}) => ({ task, actor: { kind: "agent" as const, id: "rev" }, roleOf: () => "reviewer", prs: [pr()], scopeSet: false, events: [], ...over });
const gate: Gate = { id: "evidence", kind: "evidence" };

// The gate.
check("the Dev template has the verifier and the evidence gate in Review, and is valid", DEV_TEMPLATE.version === 3 && DEV_TEMPLATE.roles.some((r) => r.id === "verifier" && r.onDemand) && DEV_TEMPLATE.flow.stages.find((s) => s.id === "review")!.gates.some((g) => g.kind === "evidence") && templateErrors(DEV_TEMPLATE).length === 0, templateErrors(DEV_TEMPLATE).join());
check("HQ checks it itself: nobody records it", OBSERVED_GATES.has("evidence"));
check("UI files by extension; the gate's own list replaces the default", uiFilesOf({}, ["a.tsx", "b.css", "c.ts", "d.vue", "e.html"]).join() === "a.tsx,b.css,d.vue,e.html" && uiFilesOf({ uiFiles: [".astro"] }, ["a.tsx", "p.astro"]).join() === "p.astro");
check("a UI PR without evidence fails, naming the files", /changes what people see \(src\/Settings\.tsx\)/.test(gateProblem(gate, ctx()) ?? ""));
check("evidence at the PR's head commit passes", gateProblem(gate, ctx({ evidence: () => ({ sha: SHA1 }) })) === null);
check("a new push resets it: evidence for an older commit fails", /new commits/.test(gateProblem(gate, ctx({ evidence: () => ({ sha: SHA1 }), prs: [pr({ headSha: SHA2 })] })) ?? ""));
check("a PR with no UI files passes without evidence", gateProblem(gate, ctx({ prs: [pr({ files: ["src/api.ts", "README.md"] })] })) === null);
check("it waits for GitHub's files and head commit", /files/.test(gateProblem(gate, ctx({ prs: [pr({ files: undefined })] })) ?? "") && /head commit/.test(gateProblem(gate, ctx({ prs: [pr({ headSha: undefined })] })) ?? ""));
const flow = DEV_TEMPLATE.flow;
const toMerge = (c: object) => () => assertGates(flow, "merge", { ...ctx(c), task: { ...task, highStakes: false }, events: [{ projectId: "p", taskId: task.id, gateId: "reviewed", state: "passed", by: { kind: "agent", id: "rev" }, proof: {}, at: "" }] } as never);
const refused = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e));
  }
};
check("a UI PR can't leave review without evidence, even when reviewed", refused(toMerge({}), /needs screenshots/));
check("…and leaves it once the evidence matches its head", (() => { try { toMerge({ evidence: () => ({ sha: SHA1 }) })(); return true; } catch (e) { console.log(String(e)); return false; } })());

// The store.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const ws = mkdtempSync(join(tmpdir(), "verifier-ws-"));
mkdirSync(join(ws, "evidence"));
writeFileSync(join(ws, "evidence/desktop.png"), png);
writeFileSync(join(ws, "evidence/tablet.png"), png);
writeFileSync(join(ws, "evidence/notes.png"), "not really a png");
writeFileSync(join(tmpdir(), "outside.png"), png);
symlinkSync(join(tmpdir(), "outside.png"), join(ws, "evidence/link.png"));
check("only PNG, JPEG, WebP, WebM and MP4, by their first bytes", kindOf(png) === "png" && kindOf(Buffer.from([0xff, 0xd8, 0xff, 0])) === "jpg" && kindOf(Buffer.from("<svg onload=x>")) === null);
const input = (files: { path: string; label: string }[], sha = SHA1) => ({ taskId: task.id, prNumber: 7, sha, by: "ver", steps: ["Opened /settings", "Saved the form"], files });
check("a file outside the workspace is refused, through a link too", refused(() => saveEvidence("proj", ws, input([{ path: "../outside.png", label: "x" }])), /outside your workspace|No file/) && refused(() => saveEvidence("proj", ws, input([{ path: "evidence/link.png", label: "x" }])), /outside your workspace/));
check("a file that isn't an image or video is refused", refused(() => saveEvidence("proj", ws, input([{ path: "evidence/notes.png", label: "x" }])), /isn't a PNG/));
check("a short or made-up commit is refused", refused(() => saveEvidence("proj", ws, input([{ path: "evidence/desktop.png", label: "x" }], "abc123")), /full head commit/));
const ev = saveEvidence("proj", ws, input([{ path: "evidence/desktop.png", label: "Settings, desktop" }, { path: "evidence/tablet.png", label: "Settings, tablet" }]));
check("evidence is copied into HQ with safe names and the verifier's steps", ev.shots.map((s) => s.file).join() === "01-settings-desktop.png,02-settings-tablet.png" && ev.steps.length === 2 && !!evidenceFile("proj", task.id, SHA1, "01-settings-desktop.png"));
check("…and only those files are served", evidenceFile("proj", task.id, SHA1, "../../../etc/passwd") === null && evidenceFile("proj", "../x", SHA1, "01-settings-desktop.png") === null && evidenceFile("proj", task.id, SHA1, "evidence.json") === null);
saveEvidence("proj", ws, input([{ path: "evidence/tablet.png", label: "After the fix" }], SHA2));
check("the newest commit's evidence is the task's", latestEvidence("proj", task.id)?.sha === SHA2);
const comment = prComment(ev, task.id, "Vera", "https://hq.example/?project=proj");
check("the PR comment says what was checked, at which commit, and links to HQ", comment.includes("`aaaaaaa`") && comment.includes("- Opened /settings") && comment.includes("https://hq.example") && !comment.includes(".png"));

// The verifier's image: only that role gets Playwright.
check("only the verifier runs in the Playwright image", imageFor({ roleId: "verifier" }) === VERIFIER_IMAGE && imageFor({ roleId: "developer" }) === IMAGE && existsSync("docker/verifier.Dockerfile"));

// The hand-off: asked once per commit; the owner can't take its own evidence; new evidence reaches the task and the PR.
{
  const team = [
    { id: "lead", name: "Lea", roleId: "lead", isLead: true, cli: "claude", model: "" },
    { id: "dev1", name: "Dev", roleId: "developer", isLead: false, cli: "claude", model: "", workspacePath: ws },
    { id: "ver", name: "Vera", roleId: "verifier", isLead: false, cli: "claude", model: "", workspacePath: ws },
  ];
  const t: Task = { ...task, evidence: undefined };
  const snap = { config: { team, template: DEV_TEMPLATE, workflow: { mode: "pr", review: { enabled: true } }, project: { id: "proj" } }, boards: [], tasks: [t], messages: [], agents: [], pullRequests: [pr()] };
  const pushed: { to: string; text: string }[] = [];
  const emitted: Task[] = [];
  const hub = {
    slug: "proj", repo: { root: ws }, snap,
    cfg: (id: string) => team.find((a) => a.id === id),
    name: (id: string) => team.find((a) => a.id === id)?.name ?? id,
    status: () => ({ session: { state: "running" } }), setStatus: () => {},
    emit: (e: { type: string; task?: Task }) => e.task && emitted.push(e.task), planChanged: () => {}, configChanged: () => {}, activity: () => {},
  };
  const planner = new Planner(hub as never, { push: (to: string, item: { text: string }) => pushed.push({ to, text: item.text }), save: () => {} } as never);
  const commented: string[] = [];
  planner.onEvidence = (task) => commented.push(task.id);
  planner.askVerifier(t);
  planner.askVerifier(t);
  const asks = pushed.filter((p) => p.to === "ver");
  check("the verifier is asked once per commit, with the commit and the files", asks.length === 1 && asks[0].text.includes(SHA1) && asks[0].text.includes("src/Settings.tsx") && asks[0].text.includes("attach_evidence"));
  snap.pullRequests = [pr({ headSha: SHA2 })];
  planner.askVerifier(t);
  check("…and again after a new push", pushed.filter((p) => p.to === "ver").length === 2);
  snap.pullRequests = [pr({ headSha: "c".repeat(40), files: ["src/api.ts"] })];
  planner.askVerifier(t);
  check("a PR with no UI files doesn't ask", pushed.filter((p) => p.to === "ver").length === 2);
  check("the task's owner can't take its evidence", refused(() => planner.attachEvidence("dev1", { taskId: t.id, sha: SHA1, steps: [], files: [{ path: "evidence/desktop.png", label: "x" }] }), /your own task/));
  const got = planner.attachEvidence("ver", { taskId: t.id, sha: SHA2, steps: ["Opened /settings"], files: [{ path: "evidence/desktop.png", label: "Desktop" }] });
  check("the verifier's evidence lands on the task, the lead hears, and the PR gets a comment", t.evidence?.sha === SHA2 && emitted.some((e) => e.evidence?.sha === SHA2) && pushed.some((p) => p.to === "lead" && p.text.includes("attached evidence")) && commented.join() === t.id && got.shots.length === 1);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
