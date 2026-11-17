// SPDX-License-Identifier: AGPL-3.0-or-later
// Architectural, boundary-validation, and token-scoping invariants:
//   npx tsx scripts/architecture-invariants-test.ts
//
// Enforces:
//   1. 1-to-1 parity between COMMANDS (server/commandPolicy.ts) and makeCommands() (server/commands.ts).
//   2. Boundary schema validation ("Parse, Don't Validate") for complex object payloads in commandPolicy.ts.
//   3. Role- and rule-scoped MCP tool registration across all BUILTIN_TEMPLATES.
//   4. Deduplicated agent instructions in Gemini and Antigravity CLI config writers.
//   5. Module line-count ceilings across server/*.ts (preventing God-Object regression).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { COMMANDS, authorize } from "../server/commandPolicy";
import { makeCommands } from "../server/commands";
import { Planner } from "../server/planner";
import { buildServer } from "../server/mcp";
import { writeAgyFiles, writeGeminiSettings, ROLE_FILE } from "../server/agentFiles";
import { BUILTIN_TEMPLATES } from "../src/data/templates";
import { flowMode, resolveSeat, seatsFor } from "../server/templates";
import type { AgentConfig } from "../src/data/types";

const ok = (label: string, cond: unknown) => {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`✓ ${label}`);
};

const LEAD_ONLY_TOOLS = [
  "create_board",
  "create_task",
  "update_task",
  "write_spec",
  "assign_task",
  "ledger_add",
  "ledger_revise",
  "read_ledger",
  "create_project_task",
  "update_project_task",
];

const CROSS_PROJECT_TOOLS = [
  "list_projects",
  "get_project_status",
  "create_project_task",
  "update_project_task",
];

const FINDINGS_TOOLS = ["report_finding", "list_findings", "update_finding"];

async function toolsOf(hub: never, planner: Planner, callerId: string): Promise<string[]> {
  const srv = buildServer(hub, planner, callerId);
  const client = new Client({ name: "invariant-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([srv.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();
  await srv.close();
  return tools.map((t) => t.name);
}

async function main() {
  // 1. Command policy / handler parity
  const dummyCommands = makeCommands({} as never);
  const policyKeys = Object.keys(COMMANDS).sort();
  const handlerKeys = Object.keys(dummyCommands).sort();
  assert.deepEqual(handlerKeys, policyKeys);
  ok(`commandPolicy COMMANDS and makeCommands() have exact 1-to-1 parity (${policyKeys.length} commands)`, true);

  // 2. Boundary schema validation ("Parse, Don't Validate")
  const who = { role: "owner" as const, remote: false, elevated: true };
  const ctx = { agentMode: () => "sandbox" as const };
  const check = (name: string, args: unknown[]) => authorize(name, args, who, ctx);
  ok("updateAgent accepts valid typed patch", check("updateAgent", ["lead", { name: "Arima", mode: "sandbox", engine: "stream" }]).ok);
  ok("updateAgent rejects invalid engine enum at boundary", !check("updateAgent", ["lead", { engine: "not-an-engine" }]).ok);
  ok("updateAgent rejects invalid mode enum at boundary", !check("updateAgent", ["lead", { mode: "bare-metal" }]).ok);
  ok("updateRole rejects invalid CLI enum at boundary", !check("updateRole", ["developer", { cli: "not-a-cli" }]).ok);
  ok("updateRole rejects non-string skills array at boundary", !check("updateRole", ["developer", { skills: [123] }]).ok);
  ok("updateWorkflow rejects invalid merge.by enum at boundary", !check("updateWorkflow", [{ merge: { by: "anyone" } }]).ok);
  ok("updateBoard rejects invalid board status at boundary", !check("updateBoard", ["B1", { status: "deleted" }]).ok);
  ok("addMcp rejects invalid URL or command shape at boundary", !check("addMcp", [{ name: "x", command: 42 }]).ok);
  ok("setMemoryExtraction rejects non-boolean enabled at boundary", !check("setMemoryExtraction", [{ enabled: "yes" }]).ok);
  ok("updateProject rejects non-boolean crossProject at boundary", !check("updateProject", [{ crossProject: "yes" }]).ok);

  // 3. Role- and rule-scoped MCP tool registration across all BUILTIN_TEMPLATES
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hq-invariants-"));
  try {
    for (const tpl of BUILTIN_TEMPLATES) {
      const dir = path.join(tmp, tpl.id);
      fs.mkdirSync(dir, { recursive: true });
      const team = seatsFor(tpl).map((s) => resolveSeat(tpl, s));
      const snap = {
        config: {
          template: tpl,
          rules: tpl.rules,
          project: { id: tpl.id, name: tpl.name },
          team,
          workflow: { mode: flowMode(tpl), review: { enabled: true } },
        },
        boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }],
        tasks: [],
        agents: [],
        messages: [],
        pullRequests: [],
        actionItems: [],
      };
      const hub = {
        snap,
        repo: { root: dir },
        cfg: (id: string) => team.find((a) => a.id === id),
        name: (id: string) => id,
        emit: () => {},
        planChanged: () => {},
        activity: () => {},
        status: () => null,
        setStatus: () => {},
      };
      const inbox = { push: () => {} };
      const planner = new Planner(hub as never, inbox as never);
      planner.actions = { addAsk: () => {}, addPlan: () => {}, addSpec: () => {} } as never;
      planner.findings = { report: () => {}, list: () => [], update: () => {} } as never;

      const lead = team.find((a) => a.isLead);
      assert.ok(lead, `template ${tpl.id} must have a lead`);
      let worker = team.find((a) => !a.isLead);
      if (!worker) {
        worker = { ...lead, id: "worker-seat", name: "Worker", isLead: false };
        team.push(worker);
      }

      const leadTools = await toolsOf(hub as never, planner, lead.id);
      const workerTools = await toolsOf(hub as never, planner, worker.id);

      // The lead really is the lead here (else the next check would pass on two identical lists)
      assert.ok(leadTools.includes("create_task"), `template ${tpl.id}: the lead seat didn't get create_task`);

      // Workers never see lead-only tools
      const leakedLeadTools = LEAD_ONLY_TOOLS.filter((t) => workerTools.includes(t));
      assert.deepEqual(leakedLeadTools, [], `template ${tpl.id} leaked lead tools to worker: ${leakedLeadTools.join(", ")}`);

      // Cross-project tools are hidden when project.crossProject is false
      const leakedCross = CROSS_PROJECT_TOOLS.filter((t) => leadTools.includes(t) || workerTools.includes(t));
      assert.deepEqual(leakedCross, [], `template ${tpl.id} exposed cross-project tools without crossProject enabled`);

      // Findings tools match tpl.rules.findings
      for (const ft of FINDINGS_TOOLS) {
        assert.equal(leadTools.includes(ft), tpl.rules.findings, `template ${tpl.id} tool ${ft} mismatch with rules.findings=${tpl.rules.findings}`);
        assert.equal(workerTools.includes(ft), tpl.rules.findings, `template ${tpl.id} worker tool ${ft} mismatch with rules.findings=${tpl.rules.findings}`);
      }

      // Plan submission tool matches tpl.rules.plans
      assert.equal(leadTools.includes("submit_plan"), tpl.rules.plans, `template ${tpl.id} submit_plan mismatch with rules.plans=${tpl.rules.plans}`);
      assert.equal(workerTools.includes("submit_plan"), tpl.rules.plans, `template ${tpl.id} worker submit_plan mismatch with rules.plans=${tpl.rules.plans}`);

      // Evidence attachment tool matches whether template flow has an evidence gate
      const hasEvidenceGate = tpl.flow.stages.some((st) => st.gates.some((g) => g.kind === "evidence"));
      assert.equal(workerTools.includes("attach_evidence"), hasEvidenceGate, `template ${tpl.id} attach_evidence mismatch with evidence gate`);
    }
    ok(`MCP tool registration strictly honours role and template rules across all ${BUILTIN_TEMPLATES.length} built-in templates`, true);

    // 4. Agent instruction deduplication for Gemini and Antigravity CLIs
    const work = path.join(tmp, "agent-files");
    fs.mkdirSync(work, { recursive: true });
    const dummyAgent: AgentConfig = {
      id: "dev",
      name: "Dev",
      role: "Developer",
      cli: "gemini",
      mode: "local",
      skills: [],
    };
    writeGeminiSettings(work, "http://127.0.0.1:7420/mcp", "http://127.0.0.1:7420/api/hooks", "tok", dummyAgent, []);
    const geminiSettings = JSON.parse(fs.readFileSync(path.join(work, ".gemini", "settings.json"), "utf8"));
    assert.ok(Array.isArray(geminiSettings.contextFileName) && geminiSettings.contextFileName.includes(ROLE_FILE));
    const sessionStartCmds = (geminiSettings.hooks?.SessionStart ?? []).flatMap((h: { hooks?: { command?: string }[] }) =>
      (h.hooks ?? []).map((x) => x.command ?? ""),
    );
    assert.ok(!sessionStartCmds.some((c: string) => c.includes("cat ")), "Gemini SessionStart must not cat ROLE_FILE when contextFileName is set");
    ok("writeGeminiSettings does not duplicate ROLE.md via SessionStart cat hook", true);

    const dummyCfg = {
      project: { id: "test", name: "Test", repo: work, hqPort: 7420, officeName: "Test" },
      team: [dummyAgent],
      workflow: { mode: "github-pr" as const, review: { enabled: true }, merge: { by: "human" as const }, deploy: { enabled: false, command: "" }, lean: { clearBetweenTasks: true } },
    };
    writeAgyFiles(work, dummyAgent, dummyCfg, "tok");
    assert.ok(fs.existsSync(path.join(work, ".agents", "rules", "hq-role.md")), ".agents/rules/hq-role.md must exist");
    assert.ok(fs.existsSync(path.join(work, ROLE_FILE)), ".arima-role.md must exist");
    assert.ok(!fs.existsSync(path.join(work, ".agent", "rules", "hq-role.md")), "duplicate .agent/rules/hq-role.md must not be created");
    assert.ok(!fs.existsSync(path.join(work, ".agents", "plugins", "hq", "rules", "AGENTS.md")), "duplicate plugin rules/AGENTS.md must not be created");
    ok("writeAgyFiles writes single rule file without triplicate rule copies", true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 5. Server module line-count ceilings
  const serverDir = path.resolve(import.meta.dirname, "../server");
  const serverFiles = fs.readdirSync(serverDir).filter((f) => f.endsWith(".ts"));
  for (const file of serverFiles) {
    const lines = fs.readFileSync(path.join(serverDir, file), "utf8").split("\n").length;
    assert.ok(lines <= 850, `server/${file} is ${lines} lines (ceiling is 850 lines)`);
    if (file === "http.ts") assert.ok(lines <= 650, `server/http.ts is ${lines} lines (ceiling is 650 lines)`);
    if (file === "planner.ts") assert.ok(lines <= 760, `server/planner.ts is ${lines} lines (ceiling is 760 lines)`);
  }
  ok(`all ${serverFiles.length} server/*.ts modules respect line-count ceilings (http.ts & planner.ts decomposed)`, true);

  console.log("\nall passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
