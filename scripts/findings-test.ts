// Security findings and ops plan approval. Run: npx tsx scripts/findings-test.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-find-"));
const repo = mkdtempSync(join(tmpdir(), "hq-find-repo-"));
const { Findings } = await import("../server/findings");
const { ActionItems } = await import("../server/actionItems");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const throws = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String((e as Error).message));
  }
};

const events: { type: string }[] = [];
const acts: string[] = [];
const hub = {
  slug: "acme",
  repo: { root: repo },
  snap: {
    config: { project: { name: "Acme", type: "security", scope: { inScope: ["*.acme.test", "10.20.0.0/24"], outOfScope: ["vpn.acme.test"], rules: "No DoS." } }, team: [] },
    findings: undefined as unknown,
    actionItems: [] as unknown[],
  },
  name: (id: string) => ({ ghost: "Ghost", you: "You" })[id] ?? id,
  emit: (e: { type: string }) => events.push(e),
  activity: (type: string) => acts.push(type),
};
const findings = new Findings(hub as never);
const good = { title: "SQL injection in login", severity: "high", target: "https://app.acme.test/login", description: "id param", evidence: "' OR 1=1 --", remediation: "Use prepared statements" };

const f1 = findings.report("ghost", "B1-T01", good);
check("in-scope finding is recorded with an id", f1.id === "F-001" && f1.status === "open" && f1.severity === "high");
check("out-of-scope target refused", throws(() => findings.report("ghost", null, { ...good, target: "vpn.acme.test" }), /out of scope/));
check("refusal shows in the activity feed", acts.includes("scope.refused"));
check("unlisted target refused", throws(() => findings.report("ghost", null, { ...good, target: "google.com" }), /isn't in scope/));
check("IP in range accepted", findings.report("ghost", null, { ...good, title: "Open Redis", severity: "critical", target: "10.20.0.9:6379" }).id === "F-002");
check("unknown severity becomes info", findings.report("ghost", null, { ...good, title: "Banner", severity: "spicy", target: "x.acme.test" }).severity === "info");

const json = JSON.parse(readFileSync(join(repo, ".hq", "findings.json"), "utf8")) as { id: string }[];
check("saved to .hq/findings.json", json.length === 3);
let report = readFileSync(join(repo, "deliverables", "security-report.md"), "utf8");
check("report lists scope and summary", report.includes("In scope: *.acme.test, 10.20.0.0/24") && report.includes("| high | 1 |") && report.includes("| critical | 1 |"));
check("report orders most severe first", report.indexOf("F-002") < report.indexOf("F-001") && report.indexOf("F-001") < report.indexOf("F-003"));
check("UI gets finding.updated", events.filter((e) => e.type === "finding.updated").length === 3);

findings.update("F-003", { status: "false-positive" });
report = readFileSync(join(repo, "deliverables", "security-report.md"), "utf8");
check("false positives move to their own section", report.includes("## Ruled out") && !report.includes("### F-003"));
check("unknown id refused", throws(() => findings.update("F-999", { status: "fixed" }), /No finding/));

hub.snap.config.project.type = "software";
check("non-security projects don't track findings", throws(() => findings.report("ghost", null, good), /isn't a security engagement/));

// Ops: a submitted plan is Approve/Reject and tells the agent which.
const told: string[] = [];
const planner = { currentTask: () => undefined, notify: (_id: string, text: string) => told.push(text) };
const actions = new ActionItems(hub as never, planner as never);
const plan = actions.add("ghost", "Rotate TLS certs", "certbot renew on web-1; rollback: restore /etc/ssl backup", true, "plan");
check("plan item is kind plan and waiting", plan.kind === "plan" && plan.waiting);
actions.resolve(plan.id, "done");
check("approving tells the agent to execute", /APPROVED/.test(told[0] ?? ""));
const plan2 = actions.add("ghost", "Drop old DB", "DROP DATABASE legacy", true, "plan");
actions.resolve(plan2.id, "dismissed", "Back it up first");
check("rejecting tells the agent not to, with your note", /REJECTED/.test(told[1] ?? "") && told[1].includes("Back it up first"));
check("action items file written", existsSync(join(process.env.HOME, ".hq", "acme", "action-items.json")));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
