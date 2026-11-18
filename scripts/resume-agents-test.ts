// Agents running before an HQ restart are started again; ones the owner stopped are not. Run: npx tsx scripts/resume-agents-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-resume-"));
const { Hub } = await import("../server/hub");
const { resumeAgents } = await import("../server/resumeAgents");
const { projectHome } = await import("../server/paths");
const { readDoc, writeDoc } = await import("../server/lib/docs");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const team = ["ana", "ben", "cy"].map((id) => ({ id, name: id, role: "Developer", cli: "claude" }));
const makeHub = () => new Hub({ root: process.env.HOME } as never, "resumetest", { project: { id: "resumetest", name: "r" }, team } as never, { boards: [], tasks: [] } as never, {} as never);
const file = join(projectHome("resumetest"), "running-agents.json");

// Before the restart: ana and ben ran; "gone" was removed from the team since.
writeDoc(file, { running: ["ana", "ben", "gone"] });
const hub = makeHub();
hub.setSession("ben", { state: "running" }); // ben's session survived (host tmux) and was reattached
const started: string[] = [];
resumeAgents(hub, async (id) => {
  started.push(id);
  hub.setSession(id, { state: "running" });
}, 10);
await wait(60);
check("an agent that was running and lost its session is started again", started.includes("ana"), JSON.stringify(started));
check("a reattached agent isn't started twice", !started.includes("ben"));
check("an agent no longer on the team isn't started", !started.includes("gone"));
check("an agent that wasn't running stays down", !started.includes("cy"));

// The owner stops ana: after the next restart she stays down.
hub.setSession("ana", { state: "stopped" });
check("the saved list drops an agent the owner stopped", JSON.stringify(readDoc<{ running: string[] }>(file)?.running) === JSON.stringify(["ben"]), JSON.stringify(readDoc(file)));
const hub2 = makeHub();
const started2: string[] = [];
resumeAgents(hub2, async (id) => {
  started2.push(id);
  hub2.setSession(id, { state: "starting" });
}, 10);
await wait(60);
check("after a second restart only ben comes back", JSON.stringify(started2) === JSON.stringify(["ben"]), JSON.stringify(started2));
check("HQ's own starting state doesn't wipe the list before resuming", JSON.stringify(readDoc<{ running: string[] }>(file)?.running) !== "[]");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
