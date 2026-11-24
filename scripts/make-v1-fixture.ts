// Generates a deterministic golden v1 ~/.arima fixture using v1's own server modules.
// Usage: node --import tsx scripts/make-v1-fixture.ts [outDir]

import crypto from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

export const FIXTURE_MASTER_KEY = "fixture-v1-test-master-key-do-not-use-in-prod";
const DEFAULT_OUT = "server-rs/crates/arima-db/tests/fixtures/v1-home";

function patchDeterminism(stageHome: string) {
  process.env.HOME = stageHome;
  process.env.ARIMA_MASTER_KEY = FIXTURE_MASTER_KEY;

  let randCounter = 0;
  crypto.randomBytes = ((size: number) => {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < size) {
      randCounter += 1;
      chunks.push(crypto.createHash("sha256").update(`arima-v1-fixture:${randCounter}`).digest());
      total += 32;
    }
    return Buffer.concat(chunks).subarray(0, size);
  }) as typeof crypto.randomBytes;

  crypto.randomUUID = (() => {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}` as `${string}-${string}-${string}-${string}-${string}`;
  }) as typeof crypto.randomUUID;

  os.homedir = () => stageHome;
  syncBuiltinESMExports();

  const OrigDate = globalThis.Date;
  const FIXED_NOW_MS = 1730000000000;
  class DeterministicDate extends OrigDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(FIXED_NOW_MS);
      } else {
        super(...(args as [string | number | Date]));
      }
    }
    static now() {
      return FIXED_NOW_MS;
    }
  }
  globalThis.Date = DeterministicDate as DateConstructor;
}

async function main() {
  const outDir = resolve(process.argv[2] ?? DEFAULT_OUT);
  const stageDir = join(os.tmpdir(), "arima-v1-fixture-gen");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });

  patchDeterminism(stageDir);

  try {
    const { hqDb } = await import("../server/lib/db");
    const { openDb, closeDocs } = await import("../server/lib/docs");
    const { seedBuiltins, saveTemplate, copyToProject, updateProjectTemplate, seatsFor, applyTemplate } = await import("../server/templates");
    const { savePlanTables, saveSpec } = await import("../server/planStore");
    const { addGoal, updateGoal } = await import("../server/goals");
    const { SqliteMemory } = await import("../server/memory");
    const { saveFinding } = await import("../server/findings");
    const { recordEvent } = await import("../server/usageEvents");
    const { Users } = await import("../server/users");
    const { registerProjectInRegistry, setRegistryPaused } = await import("../server/projectsRegistry");
    const { saveConfig, savePlan } = await import("../server/store");
    const { saveCompany } = await import("../server/company");
    const { Vault, loadMasterKey } = await import("../server/credentials/vault");
    const { Accounts } = await import("../server/credentials/registry");
    const { BLANK_TEMPLATE } = await import("../src/data/templates");

    const v1Home = join(stageDir, ".arima");
    const db = hqDb(v1Home);

    // 1. Company context
    saveCompany("ArimaOps builds reliable multi-agent command decks.");

    // 2. Templates library + custom user template
    seedBuiltins(db);
    saveTemplate(
      db,
      {
        ...BLANK_TEMPLATE,
        id: "custom-web",
        version: 1,
        name: "Custom Web Squad",
        description: "Minimal custom template saved into v1 library.",
      },
      "Sachin",
    );

    // 3. Project 1: template project ("alpha")
    const alphaRepo = join(stageDir, "repos", "alpha");
    mkdirSync(alphaRepo, { recursive: true });
    let alphaTpl = copyToProject(db, "alpha", "dev");
    alphaTpl = {
      ...alphaTpl,
      name: "Dev Team Custom Alpha",
      roles: alphaTpl.roles.map((r) =>
        r.id === "lead" ? { ...r, roleMd: `${r.roleMd}\n\nCustom alpha lead guidance.` } : r,
      ),
    };
    updateProjectTemplate(db, "alpha", alphaTpl);

    const alphaSeats = seatsFor(alphaTpl).map((s, idx) => ({
      ...s,
      account: idx === 0 ? "work-anthropic" : "",
    }));
    const alphaCfg = {
      project: {
        id: "alpha",
        name: "Alpha Project",
        repo: "acme/alpha",
        path: alphaRepo,
        hqPort: 7420,
        charter: "Ship reliable v2 releases",
        spendCaps: { dailyUsd: 10, monthlyUsd: 100 },
      },
      team: alphaSeats.map((s) => ({
        ...s,
        role: "Lead",
        isLead: s.roleId === "lead",
        cli: "claude" as const,
        model: "",
        skills: [],
        roleMd: "",
      })),
      template: null,
      rules: alphaTpl.rules,
      workflow: {
        mode: "github-pr" as const,
        review: { enabled: true, tool: "human" as const, command: "" },
        merge: { by: "human" as const },
        deploy: { enabled: false, tool: "custom" as const, command: "", perAgentEnvironments: false },
      },
      stack: { frameworks: [{ id: "react", where: "src" }], tools: {} },
    };
    applyTemplate(alphaCfg, alphaTpl);
    saveConfig(alphaRepo, alphaCfg);
    registerProjectInRegistry(alphaRepo, alphaCfg);

    const boards = [
      { id: "B1", title: "Sprint 1", status: "active" as const, order: 0 },
      { id: "B2", title: "Hardening", status: "planned" as const, order: 1 },
    ];
    savePlanTables(db, "alpha", { boards, tasks: [] }, alphaTpl.flow.stages[0].id);
    saveSpec(db, "alpha", "B1", "## Auth spec\n- S1. Enforce PKCE on sign-in.", "cipher");

    const goalId = addGoal(db, "alpha", { title: "Launch v2 beta", metric: "signups", target: "200" });
    updateGoal(db, "alpha", goalId, { current: "45" });

    savePlanTables(
      db,
      "alpha",
      {
        boards,
        tasks: [
          {
            id: "T1",
            boardId: "B1",
            stageId: "build",
            title: "Enforce PKCE verifier",
            ownerId: "cipher",
            status: "done",
            needs: [],
            files: ["src/auth.ts"],
            description: "Validate code_verifier challenge on callback.",
            doneWhen: "PKCE unit and integration tests pass.",
            note: null,
            prNumber: 42,
            deliverablePath: null,
            cli: "claude",
            model: "claude-sonnet-5-5",
            usage: null,
            goalId,
            specItems: ["S1"],
            highStakes: false,
          },
          {
            id: "T2",
            boardId: "B2",
            stageId: "plan",
            title: "Audit bearer token rotation",
            ownerId: null,
            status: "todo",
            needs: ["T1"],
            files: ["server-rs/crates/arima-server/src/mcp.rs"],
            description: "Check token rotation on archive.",
            doneWhen: "Regression test green.",
            note: "high risk area",
            prNumber: null,
            deliverablePath: "deliverables/T2.md",
            cli: null,
            model: null,
            usage: null,
            highStakes: true,
          },
        ],
      },
      alphaTpl.flow.stages[0].id,
    );

    const mem = new SqliteMemory(db);
    const m1 = mem.remember({
      projectId: "alpha",
      type: "Decision",
      text: "Always enforce deterministic rustls TLS for egress.",
      taskId: "T1",
      about: ["server-rs/crates/arima-proxy/src/egress.rs"],
      by: "cipher",
    });
    mem.remember({
      projectId: "alpha",
      type: "Lesson",
      text: "Rotate bearer tokens on project archive.",
      taskId: "T2",
      about: ["server-rs/crates/arima-server/src/mcp.rs"],
      by: "cipher",
    });
    mem.certify("alpha", [m1.id], "Sachin");

    const findingAt = new Date().toISOString();
    saveFinding(db, {
      id: "F-001",
      projectId: "alpha",
      taskId: "T1",
      reporterId: "cipher",
      title: "SSRF in webhook fetcher",
      asset: { kind: "url", value: "https://api.alpha.test/hook" },
      location: { file: "src/webhook.ts", startLine: 18, endLine: 32 },
      cvss: {
        vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N",
        score: 9.3,
      },
      severity: "critical",
      ssvc: null,
      cwe: ["CWE-918"],
      attack: ["T1190"],
      d3fend: [],
      wstg: "WSTG-INPV-05",
      description: "Webhook endpoint followed private metadata redirects.",
      impact: "POST /hook reached 169.254.169.254.",
      remediation: "Validate resolved IPs against blocked CIDR ranges.",
      evidence: [{ kind: "note", content: "Reproduced against staging hook receiver." }],
      verified: true,
      verifiedBy: "Sachin",
      status: "confirmed",
      at: findingAt,
      updatedAt: findingAt,
    });

    recordEvent(db, {
      projectId: "alpha",
      taskId: "T1",
      agentId: "cipher",
      source: "agent",
      account: "work-anthropic",
      provider: "anthropic",
      cli: "claude",
      model: "claude-sonnet-5-5",
      tokens: { input: 1500, cached: 200, output: 500 },
    });

    // 4. Project 2: pre-template legacy project ("legacy-beta", paused)
    const betaRepo = join(stageDir, "repos", "legacy-beta");
    mkdirSync(betaRepo, { recursive: true });
    const betaCfg = {
      project: {
        id: "legacy-beta",
        name: "Legacy Beta",
        repo: "acme/legacy-beta",
        path: betaRepo,
        hqPort: 7420,
      },
      team: [
        {
          id: "cipher",
          name: "Cipher",
          role: "Lead",
          isLead: true,
          cli: "claude" as const,
          model: "claude-opus-5-5",
          mode: "sandbox" as const,
          color: "#f85149",
          skills: [],
          roleMd: "You are the legacy lead.",
          sandbox: { resources: { cpus: null, memoryGb: null }, allow: [], deny: [] },
          workspacePath: null,
          account: "",
          mcp: [],
        },
      ],
      template: null,
      rules: { findings: false, plans: false, scopeRequired: false, labMode: false, outbound: "none" as const, egress: [] },
      workflow: {
        mode: "deliverables" as const,
        review: { enabled: true, tool: "human" as const, command: "" },
        merge: { by: "human" as const },
        deploy: { enabled: false, tool: "custom" as const, command: "", perAgentEnvironments: false },
      },
    };
    saveConfig(betaRepo, betaCfg);
    savePlan(
      betaRepo,
      {
        boards: [{ id: "B1", title: "Legacy Board", status: "active", order: 0 }],
        tasks: [
          {
            id: "T-LEG-1",
            boardId: "B1",
            stageId: "work",
            title: "Migrate legacy docs",
            ownerId: "cipher",
            status: "in-progress",
            needs: [],
            files: ["README.md"],
            note: null,
            prNumber: null,
            deliverablePath: "deliverables/README.md",
            cli: "claude",
            model: null,
            usage: null,
          },
        ],
      },
      betaCfg,
    );
    registerProjectInRegistry(betaRepo, betaCfg);
    setRegistryPaused(betaRepo, true);

    // 5. Users (stored in ~/.arima/arima.db docs table as users.json)
    const users = new Users(join(v1Home, "users.json"));
    users.create({ name: "Sachin", role: "owner", password: "fixture-owner-password-1" });
    users.create({ name: "Priya", role: "operator", password: "fixture-operator-password-2" });

    // 6. Vault & accounts (vault.json + accounts.json)
    const master = loadMasterKey({ env: FIXTURE_MASTER_KEY, keychain: null, dir: v1Home });
    const vault = new Vault(join(v1Home, "vault.json"), master);
    const accts = new Accounts(vault, join(v1Home, "accounts.json"));
    accts.save({
      id: "work-anthropic",
      provider: "anthropic",
      label: "Work Anthropic",
      secret: "sk-ant-fixture-alpha-9876",
    });
    accts.save({
      id: "aws-bedrock",
      provider: "bedrock",
      label: "AWS Bedrock",
      fields: { region: "us-east-1" },
      secret: JSON.stringify({
        accessKeyId: "AKIAFIXTURE1234",
        secretAccessKey: "bedrock-fixture-secret-4321",
      }),
    });
    vault.set("push:fcm", "fcm-fixture-server-key-5555");

    // 7. Evidence artifact
    const evDir = join(v1Home, "evidence", "alpha");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "proof.txt"), "v1-evidence-artifact\n");

    // Flush SQLite WAL into canonical standalone db files for byte-identical determinism.
    for (const dbDir of [v1Home, join(alphaRepo, ".arima"), join(betaRepo, ".arima")]) {
      const conn = openDb(dbDir);
      conn.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;");
    }
    closeDocs();

    // 8. Export clean fixture tree (no -wal/-shm, no .gitignore, no vault.key)
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const f of ["arima.db", "accounts.json", "vault.json"]) {
      cpSync(join(v1Home, f), join(outDir, f));
    }
    if (existsSync(join(v1Home, "evidence"))) {
      cpSync(join(v1Home, "evidence"), join(outDir, "evidence"), { recursive: true });
    }
    for (const repoSlug of ["alpha", "legacy-beta"]) {
      const destDb = join(outDir, "repos", repoSlug, ".arima", "arima.db");
      mkdirSync(dirname(destDb), { recursive: true });
      cpSync(join(stageDir, "repos", repoSlug, ".arima", "arima.db"), destDb);
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

await main();
