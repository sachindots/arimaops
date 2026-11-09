// Personas: right persona per role, peers and escalation in every role file, no caveman voice. Run: npx tsx scripts/persona-test.ts
import { personaFor } from "../src/data/personas";
import { ROLE_TEMPLATES } from "../src/data/roles";
import { roleMd } from "../server/agentFiles";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const cases: [string, boolean, string][] = [
  ["Tech Lead", true, "lead"], ["Go Developer", false, "developer"], ["Docs Writer", false, "writer"], ["QA", false, "reviewer"],
  ["Red Teamer", false, "security"], ["Researcher", false, "researcher"], ["UI/UX Designer", false, "designer"], ["DevOps", false, "ops"],
  ["Senior Dev", false, "developer"], ["Something Custom", false, "developer"],
];
for (const [role, lead, kind] of cases) check(`${role} → ${kind}`, personaFor(role, lead).kind === kind, personaFor(role, lead).kind);
check("no template asks for caveman style", ROLE_TEMPLATES.every((t) => !/caveman/i.test(t.roleMd("X") + t.summary) && !t.defaultSkills.includes("caveman")));

const agent = (id: string, name: string, role: string, isLead = false) => ({ id, name, role, isLead, cli: "claude", model: "", mode: "local", skills: [], roleMd: "Role.", department: "eng" });
const team = [agent("c", "Cipher", "Tech Lead", true), agent("l", "Lyra", "Docs Writer"), agent("g", "Ghost", "Go Developer")];
const cfg = { project: { name: "P", repo: "p", type: "software", hqPort: 7420 }, team, workflow: { mode: "github-pr", merge: { by: "lead" }, review: { enabled: false } } };
const md = roleMd(team[1] as never, cfg as never);
check("role file has persona, voice, peers and escalation", ["## How you work (writer)", "## How you talk", "## Working with teammates", "## When things go wrong"].every((h) => md.includes(h)));
check("peers name teammates, not yourself", md.includes("- Ghost (Go Developer): ask about how the code works") && md.includes("- Cipher (Tech Lead, lead)") && !md.includes("- Lyra (Docs Writer)"));
check("background-job habit present", /Never wait on a background job/.test(md));
check("hands off the user's services", /Never stop, restart, remove or reconfigure services/.test(md));
check("no caveman in the role file", !/caveman/i.test(md));
const leadMd = roleMd(team[0] as never, cfg as never);
check("lead is told it's in charge and when to ask the user", /in charge of this team day to day/.test(leadMd) && /hasn't answered after 30 minutes/.test(leadMd));
check("workers take scope questions to the lead", /go to the lead \(send_message\), not the user/.test(md) && !/in charge of this team/.test(md));

// Claude agents' commits and PRs carry no Claude attribution.
{
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeClaudeFiles } = await import("../server/agentFiles");
  const dir = mkdtempSync(join(tmpdir(), "hq-attr-"));
  writeClaudeFiles(dir, team[2] as never, cfg as never, "tok");
  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
  check("claude agents: attribution hidden in commits and PRs", settings.attribution?.commit === "" && settings.attribution?.pr === "", JSON.stringify(settings.attribution));
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
