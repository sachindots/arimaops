// Security findings and ops plan approval. Run: npx tsx scripts/findings-test.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDoc, writeDoc } from "../server/lib/docs";

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

const events: { type: string; finding?: { id: string } }[] = [];
const acts: string[] = [];
const hub = {
  slug: "acme",
  repo: { root: repo },
  snap: {
    config: {
      template: { id: "sec" },
      rules: { findings: true },
      project: { id: "acme", name: "Acme", scope: { inScope: ["*.acme.test", "10.20.0.0/24"], outOfScope: ["vpn.acme.test"], rules: "No DoS." } },
      team: [],
    },
    findings: undefined as unknown,
    actionItems: [] as unknown[],
  },
  name: (id: string) => ({ ghost: "Ghost", you: "You" })[id] ?? id,
  emit: (e: { type: string }) => events.push(e),
  activity: (type: string) => acts.push(type),
};
const { scoreCvss4, severityOf } = await import("../server/cvss");
const { hqDb } = await import("../server/lib/db");
const { loadFindings } = await import("../server/findings");
const R = await import("../server/reports");

// CVSS 4.0: scores checked by hand against FIRST's calculator (first.org/cvss/calculator/4.0) on 2026-11-12.
const FIRST: [string, number][] = [
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", 9.3],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H", 10],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N", 0],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:L/VA:N/SC:N/SI:N/SA:N", 7.1],
  ["CVSS:4.0/AV:L/AC:H/AT:P/PR:L/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N", 1],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:U", 8.1],
  ["CVSS:4.0/AV:A/AC:L/AT:P/PR:N/UI:P/VC:H/VI:H/VA:L/SC:L/SI:L/SA:N", 7.5],
];
for (const [v, want] of FIRST) check(`CVSS ${want} for ${v.slice(9, 40)}…`, scoreCvss4(v).score === want, String(scoreCvss4(v).score));
check("a CVSS 3.1 vector is refused", throws(() => scoreCvss4("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), /CVSS 4\.0/));
check("an incomplete vector is refused", throws(() => scoreCvss4("CVSS:4.0/AV:N/AC:L"), /every base metric/));
check("a bad metric value is refused", throws(() => scoreCvss4("CVSS:4.0/AV:Q/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), /Not a valid/));
check("FIRST's severity bands", [0, 0.1, 3.9, 4, 6.9, 7, 8.9, 9].map(severityOf).join() === "info,low,low,medium,medium,high,high,critical");

const findings = new Findings(hub as never);
const good = {
  title: "SQL injection in login",
  asset: { kind: "url", value: "https://app.acme.test/login" },
  cvss: FIRST[0][0],
  severity: "low",
  cwe: ["cwe-89"],
  attack: ["T1190"],
  wstg: "WSTG-INPV-05",
  description: "id param",
  impact: "Read every user's data",
  evidence: [{ kind: "request", content: "POST /login id=' OR 1=1 --" }],
  remediation: "Use prepared statements",
};

const f1 = findings.report("ghost", "B1-T01", good);
check("in-scope finding is recorded with an id", f1.id === "F-001" && f1.status === "open" && !f1.verified);
check("HQ scores it and the claimed severity is ignored", f1.cvss?.score === 9.3 && f1.severity === "critical");
check("ids are normalised", f1.cwe[0] === "CWE-89");
check("out-of-scope target refused", throws(() => findings.report("ghost", null, { ...good, asset: { kind: "host", value: "vpn.acme.test" } }), /out of scope/));
check("refusal shows in the activity feed", acts.includes("scope.refused"));
check("unlisted target refused", throws(() => findings.report("ghost", null, { ...good, asset: { kind: "url", value: "https://google.com" } }), /isn't in scope/));
check("a malformed CWE is refused", throws(() => findings.report("ghost", null, { ...good, cwe: ["SQLi"] }), /CWE-89/));
check("a malformed WSTG id is refused", throws(() => findings.report("ghost", null, { ...good, wstg: "INPV5" }), /WSTG-INPV-05/));
check("an asset is required", throws(() => findings.report("ghost", null, { ...good, asset: undefined }), /Name the asset/));
const f2 = findings.report("ghost", null, { ...good, title: "Open Redis", cvss: undefined, severity: "high", asset: { kind: "ip", value: "10.20.0.9" }, evidence: "redis-cli PING" });
check("an unscored finding keeps its severity; string evidence becomes a note", f2.id === "F-002" && f2.severity === "high" && f2.evidence[0].kind === "note");
const f3 = findings.report("ghost", null, { ...good, title: "Hard-coded key", cvss: undefined, severity: "medium", asset: { kind: "repo", value: "acme/api" }, location: { file: "src/db.ts", startLine: 12 } });
check("code findings skip the network scope and keep their location", f3.location?.file === "src/db.ts" && f3.location.startLine === 12);
check("unknown severity becomes info", findings.report("ghost", null, { ...good, title: "Banner", cvss: undefined, severity: "spicy", asset: { kind: "host", value: "x.acme.test" } }).severity === "info");

const saved = loadFindings(hqDb(), "acme");
check("saved in the HQ database", saved.length === 4 && saved[0].cvss?.vector === FIRST[0][0] && saved[0].evidence[0].kind === "request");
let report = readFileSync(join(repo, "deliverables", "security-report.md"), "utf8");
check("report lists scope and summary", report.includes("In scope: *.acme.test, 10.20.0.0/24") && report.includes("| critical | 1 |") && report.includes("| high | 1 |"));
check("report orders most severe first", report.indexOf("F-001") < report.indexOf("F-002") && report.indexOf("F-002") < report.indexOf("F-003"));
check("UI gets finding.updated", events.filter((e) => e.type === "finding.updated").length === 4);

check("a scored finding's severity can't be set by hand", throws(() => findings.update("F-001", { severity: "low" }), /follows the score/));
findings.update("F-001", { verified: true }, "cipher");
check("verifying records who", loadFindings(hqDb(), "acme")[0].verifiedBy === "cipher");
findings.update("F-002", { cvss: FIRST[3][0] });
check("adding a vector rescores", loadFindings(hqDb(), "acme")[1].severity === "high" && loadFindings(hqDb(), "acme")[1].cvss?.score === 7.1);
findings.update("F-004", { status: "false-positive" });
report = readFileSync(join(repo, "deliverables", "security-report.md"), "utf8");
check("false positives move to their own section", report.includes("## Ruled out") && !report.includes("### F-004"));
check("unknown id refused", throws(() => findings.update("F-999", { status: "fixed" }), /No finding/));

// Every export reads the same findings.
const input = { project: "Acme", scope: hub.snap.config.project.scope, findings: hub.snap.findings as never, name: hub.name, generatedAt: "2026-11-12T00:00:00Z" };
const sarif = JSON.parse(R.renderSarif(input));
const run = sarif.runs[0];
check("SARIF: version 2.1.0, a tool and rules", sarif.version === "2.1.0" && sarif.$schema.includes("sarif-2.1.0") && run.tool.driver.name && run.tool.driver.rules.length === 3);
check("SARIF: every result points at its rule", run.results.every((r: { ruleId: string; ruleIndex: number }) => run.tool.driver.rules[r.ruleIndex].id === r.ruleId));
check("SARIF: levels and messages", run.results.every((r: { level: string; message: { text: string } }) => ["error", "warning", "note"].includes(r.level) && r.message.text));
check("SARIF: a code finding has a file and line", run.results.some((r: { locations: { physicalLocation?: { artifactLocation: { uri: string }; region?: { startLine: number } } }[] }) => r.locations[0].physicalLocation?.artifactLocation.uri === "src/db.ts" && r.locations[0].physicalLocation.region?.startLine === 12));
{
  // The official OASIS schema (scripts/fixtures). It is draft-04; its only draft-04-only keys are the top-level
  // $schema and id (every $ref is local), so ajv's default draft compiles it once those are dropped.
  const { default: Ajv } = await import("ajv");
  const { $schema: _draft, id: _id, ...schema } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "sarif-schema-2.1.0.json"), "utf8"));
  const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
  const valid = validate(sarif);
  check("SARIF: valid against the official 2.1.0 schema", valid, JSON.stringify(validate.errors?.slice(0, 3)));
  check("SARIF: the schema check catches a broken export", !validate({ ...sarif, runs: [{ results: [] }] }));
}
check("SARIF: a scored rule carries security-severity", run.tool.driver.rules[0].properties["security-severity"] === "9.3");
const j = JSON.parse(R.renderJson(input));
check("JSON: findings without false positives", j.findings.length === 3 && j.findings[0].cvss.score === 9.3);
const h1 = R.renderHackerOne(input);
check("HackerOne: its fields, and unverified ones flagged", h1.includes("**Weakness:** CWE-89") && h1.includes("### Steps to reproduce") && h1.includes("Not verified yet") && !h1.includes("F-004"));
const bc = R.renderBugcrowd(input);
check("Bugcrowd: its fields", bc.includes("**Vulnerability type (VRT):**") && bc.includes("### Proof of concept"));
const evil = { ...(hub.snap.findings as { title: string }[])[0], title: "<script>alert(1)</script>" };
const html = R.renderHtml({ ...input, findings: [evil] as never });
check("HTML: escapes agent text and prints", !html.includes("<script>alert") && html.includes("&lt;script&gt;") && html.includes("@media print"));
const fence = R.renderMarkdown({ ...input, findings: [{ ...(hub.snap.findings as object[])[0], evidence: [{ kind: "output", content: "a ``` b" }] }] as never });
check("Markdown: evidence with backticks can't break out of its fence", fence.includes("````\na ``` b\n````"));

// A project made before templates shows its findings, read-only.
{
  const old = mkdtempSync(join(tmpdir(), "hq-find-old-"));
  writeDoc(join(old, ".arima", "findings.json"), [{ id: "F-001", title: "Old", severity: "high", target: "a.acme.test", description: "d", evidence: "e", remediation: "r", status: "open", reporterId: "ghost", taskId: null, at: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]);
  const oldHub = { ...hub, repo: { root: old }, snap: { ...hub.snap, findings: undefined, config: { ...hub.snap.config, template: null, project: { ...hub.snap.config.project, id: "old" } } } };
  const oldFindings = new Findings(oldHub as never);
  const shown = oldHub.snap.findings as { asset: { value: string }; evidence: { content: string }[] }[];
  check("old findings show in today's shape", shown.length === 1 && shown[0].asset.value === "a.acme.test" && shown[0].evidence[0].content === "e");
  check("old findings are read-only", throws(() => oldFindings.update("F-001", { status: "fixed" }), /read-only/) && throws(() => oldFindings.report("ghost", null, good), /read-only/));
}

hub.snap.config.rules.findings = false;
check("non-security projects don't track findings", throws(() => findings.report("ghost", null, good), /isn't security work/));

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
check("action items file written", readDoc(join(process.env.HOME, ".arima", "acme", "action-items.json")) !== null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
