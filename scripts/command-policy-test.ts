// The browser command table (server/commandPolicy.ts): who may run what, and what gets refused before
// any handler runs. A change that widens a role has to change this test too.
//
//   npx tsx scripts/command-policy-test.ts

import { authorize, COMMANDS, needsStepUp, type Role } from "../server/commandPolicy";

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  ${detail}`}`);
  if (!ok) failed = true;
};
const ctx = { agentMode: (id: string) => (id === "box" ? ("sandbox" as const) : id === "here" ? ("local" as const) : undefined) };
const who = (role: Role, remote = false, elevated = false) => ({ role, remote, elevated });
const byRole = (role: Role) => Object.entries(COMMANDS).filter(([, e]) => e.role === role).map(([n]) => n).sort();

check(
  "viewers can only chat and refresh",
  JSON.stringify(byRole("viewer")) === JSON.stringify(["askTeam", "recheckSetup", "refreshMcp", "refreshSbx", "sendMessage"]),
  JSON.stringify(byRole("viewer")),
);
const OWNER = [
  "addMcp", "addToSuite", "finishGithubApp", "importTemplate", "openHostShell", "openShell", "promoteLessons",
  "removeAccount", "removeLesson", "runSetupFix", "saveAccount", "setCompany", "setLabMode", "setLessonPromotion",
  "setMemoryExtraction", "setProxy", "setSpendCaps",
  // Tool connections: HQ holds the owner's keys and sends on the owner's click.
  "saveConnection", "removeConnection", "checkConnection", "sendProposal",
].sort();
check("owner-only commands are exactly these", JSON.stringify(byRole("owner")) === JSON.stringify(OWNER), JSON.stringify(byRole("owner")));
check("every owner-only command needs the step-up from a remote device", OWNER.every(needsStepUp));

const ok = (v: ReturnType<typeof authorize>) => v.ok;
const why = (v: ReturnType<typeof authorize>) => (v.ok ? "ok" : v.why);

check("an unknown command is refused", why(authorize("rm", [], who("owner"), ctx)) === "unknown");
check("object keys aren't commands", why(authorize("constructor", [], who("owner"), ctx)) === "unknown" && why(authorize("__proto__", [], who("owner"), ctx)) === "unknown");
check("wrong argument types are refused", why(authorize("startAgent", [42], who("owner"), ctx)) === "bad-args");
check("missing arguments are refused", why(authorize("startAgent", [], who("owner"), ctx)) === "bad-args");
check("extra arguments are refused", why(authorize("startAgent", ["a", "b"], who("owner"), ctx)) === "bad-args");
check("an oversized argument is refused", why(authorize("sendMessage", ["lead", "x".repeat(200_000)], who("owner"), ctx)) === "bad-args");
check("a missing trailing argument arrives as null and is fine", ok(authorize("resolveActionItem", ["A1", "done", null], who("operator"), ctx)));

check("a viewer can chat", ok(authorize("sendMessage", ["lead", "hi"], who("viewer"), ctx)));
check("a viewer can't start an agent", why(authorize("startAgent", ["a"], who("viewer"), ctx)) === "role");
check("an operator can start an agent", ok(authorize("startAgent", ["a"], who("operator"), ctx)));
check("an operator can't change accounts", why(authorize("saveAccount", [{}], who("operator"), ctx)) === "role");

check("an operator types into a sandboxed agent", ok(authorize("sendTerminalInput", ["box", "ls\r"], who("operator"), ctx)));
check("an operator can't type into a Local agent", why(authorize("sendTerminalInput", ["here", "ls\r"], who("operator"), ctx)) === "role");
check("an operator can't type into a host shell", why(authorize("sendTerminalInput", ["shell:host", "ls\r"], who("operator"), ctx)) === "role");
check("the owner can type into a host shell", ok(authorize("sendTerminalInput", ["shell:host", "ls\r"], who("owner"), ctx)));
check("an operator can rename an agent", ok(authorize("updateAgent", ["a", { name: "x" }], who("operator"), ctx)));
check("an operator can't move an agent to Local", why(authorize("updateAgent", ["a", { mode: "local" }], who("operator"), ctx)) === "role");
check("an operator can't give an agent a folder", why(authorize("updateAgent", ["a", { workspacePath: "/" }], who("operator"), ctx)) === "role");
check("an operator can't move the team to Local", why(authorize("setTeamMode", ["local"], who("operator"), ctx)) === "role");
check("an operator can't add a Local agent", why(authorize("addAgent", [{ mode: "local" }], who("operator"), ctx)) === "role");
check("an operator can make a role drafts only", ok(authorize("updateRole", ["marketer", { outbound: "drafts-only" }], who("operator"), ctx)));
check("…but can't lift it, or clear it", why(authorize("updateRole", ["marketer", { outbound: "none" }], who("operator"), ctx)) === "role" && why(authorize("updateRole", ["marketer", { outbound: null }], who("operator"), ctx)) === "role");
check("an operator sets a role's budget", ok(authorize("updateRole", ["marketer", { capUsd: 2 }], who("operator"), ctx)));
check("an operator can't turn on cross-project tools", why(authorize("updateProject", [{ crossProject: true }], who("operator"), ctx)) === "role");

check("a remote device needs a fresh code for a risky command", why(authorize("updateWorkflow", [{}], who("operator", true), ctx)) === "step-up");
check("…and runs it once elevated", ok(authorize("updateWorkflow", [{}], who("operator", true, true), ctx)));
check("this machine's own browser doesn't", ok(authorize("updateWorkflow", [{}], who("operator", false), ctx)));
check("a code never lifts the role", why(authorize("saveAccount", [{}], who("operator", true, true), ctx)) === "role");

process.exit(failed ? 1 : 0);
