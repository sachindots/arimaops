import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { attachErrorCollector, drawCanvasStroke, gotoWorkspace, openSettings } from "./helpers";

const FORBIDDEN_PORTS = new Set([7420, 7421, 5173, 5179]);
// Candidate ports scanned by arima-proxy's DEFAULT_LOCAL_PROBE_PORTS, deliberately skipping 5173.
const MOCK_TARGET_CANDIDATE_PORTS = [4173, 5174, 3001, 3000, 8080, 8000];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function allocateFreePort(exclude: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (!addr || typeof addr === "string") {
          srv.close(() => reject(new Error("Could not determine allocated port")));
          return;
        }
        const chosen = addr.port;
        srv.close((err) => (err ? reject(err) : resolve(chosen)));
      });
    });
    if (!FORBIDDEN_PORTS.has(port) && !exclude.has(port)) {
      return port;
    }
  }
  throw new Error("Unable to allocate a free ephemeral test port");
}

async function startMockPreviewTarget(): Promise<{ server: http.Server; port: number }> {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>E2E Preview Target</title></head>' +
    '<body style="margin:0;padding:24px;background:#0c1322;color:#f1f5f9;font-family:sans-serif">' +
    '<h1 id="e2e-preview-title">Isolated Preview App</h1>' +
    '<button id="e2e-preview-cta" type="button">Ship E2E Feature</button>' +
    "</body></html>";

  for (const candidate of MOCK_TARGET_CANDIDATE_PORTS) {
    if (FORBIDDEN_PORTS.has(candidate)) continue;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "SAMEORIGIN",
        "Cache-Control": "no-store",
      });
      res.end(html);
    });
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (bound) {
      return { server, port: candidate };
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  throw new Error(
    `None of the preview discovery candidate ports (${MOCK_TARGET_CANDIDATE_PORTS.join(", ")}) were available`,
  );
}

function newestMtimeMs(dir: string): number {
  let latest = 0;
  if (!fs.existsSync(dir)) return latest;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (entry.name === "target" || entry.name === "node_modules") continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && (entry.name.endsWith(".rs") || entry.name === "Cargo.toml")) {
        const mt = fs.statSync(full).mtimeMs;
        if (mt > latest) latest = mt;
      }
    }
  }
  return latest;
}

function ensureArimaServerBinary(): string {
  const repoRoot = process.cwd();
  const binPath = path.join(repoRoot, "server-rs", "target", "debug", "arima-server");
  const distIndex = path.join(repoRoot, "dist", "index.html");
  const cratesDir = path.join(repoRoot, "server-rs", "crates");

  const needsBuild = (() => {
    if (!fs.existsSync(binPath)) return true;
    const binMtime = fs.statSync(binPath).mtimeMs;
    if (fs.existsSync(distIndex) && fs.statSync(distIndex).mtimeMs > binMtime) {
      return true;
    }
    if (newestMtimeMs(cratesDir) > binMtime) {
      return true;
    }
    return false;
  })();

  if (needsBuild) {
    execFileSync(
      "cargo",
      ["build", "--manifest-path", path.join(repoRoot, "server-rs", "Cargo.toml"), "--bin", "arima-server"],
      { stdio: "inherit", env: process.env },
    );
  }
  if (!fs.existsSync(binPath)) {
    throw new Error(`Expected arima-server binary at ${binPath}`);
  }
  return binPath;
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

test.describe("Live Isolated Rust HQ + Preview Proxy E2E", () => {
  test.describe.configure({ mode: "serial" });

  let tempHome = "";
  let tempWorkspace = "";
  let hqPort = 0;
  let previewPort = 0;
  let bootstrapToken = "";
  let serverProc: ChildProcess | null = null;
  let serverLogs = "";
  let mockTarget: { server: http.Server; port: number } | null = null;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const binPath = ensureArimaServerBinary();

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "arima-e2e-home-"));
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "arima-e2e-ws-"));

    mockTarget = await startMockPreviewTarget();
    const used = new Set<number>([mockTarget.port]);
    hqPort = await allocateFreePort(used);
    used.add(hqPort);
    previewPort = await allocateFreePort(used);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ARIMA_HOME: tempHome,
      HQ_PORT: String(hqPort),
      HQ_PREVIEW_PORT: String(previewPort),
      HQ_HOST: "127.0.0.1",
      RUST_LOG: "warn",
    };
    delete childEnv.HQ_PUBLIC_ORIGIN;
    delete childEnv.HQ_PREVIEW_DOMAIN;
    delete childEnv.HQ_TRUST_PROXY;

    serverProc = spawn(binPath, [], {
      cwd: tempWorkspace,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stdout?.on("data", (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });
    serverProc.stderr?.on("data", (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });

    try {
      await waitForHealth(`http://127.0.0.1:${hqPort}/api/health`);
    } catch (err) {
      throw new Error(`arima-server failed to become healthy: ${String(err)}\nLogs:\n${serverLogs}`);
    }

    const tokenPath = path.join(tempHome, "dev-browser-token");
    bootstrapToken = fs.readFileSync(tokenPath, "utf8").trim();
    expect(bootstrapToken.length).toBeGreaterThanOrEqual(32);
  });

  test.afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) {
      serverProc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            serverProc?.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 3000);
        serverProc?.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (mockTarget) {
      await new Promise<void>((resolve) => mockTarget!.server.close(() => resolve()));
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    if (tempWorkspace && fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("SignIn origin gating: localhost shows Passkey + token toggle without mock flash; 127.0.0.1 hides Passkey", async ({
    browser,
  }) => {
    // 1. http://localhost:<port>/
    const localhostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const localhostPage = await localhostCtx.newPage();
    const localhostErrors = attachErrorCollector(localhostPage, { allowAuthCheck401: true });

    let sawDemoFlash = false;
    localhostPage.on("domcontentloaded", () => {
      void localhostPage
        .evaluate(() => document.body.textContent?.includes("Askwell") ?? false)
        .then((hit) => {
          if (hit) sawDemoFlash = true;
        })
        .catch(() => undefined);
    });

    await localhostPage.goto(`http://localhost:${hqPort}/`, { waitUntil: "networkidle" });
    await expect(localhostPage.getByRole("form", { name: "Sign in" })).toBeVisible();
    await expect(localhostPage.getByText("HQ access")).toBeVisible();
    expect(sawDemoFlash, "Live HQ must never flash mock Demo data before SignIn").toBe(false);
    await expect(localhostPage.getByText("Demo", { exact: true })).toHaveCount(0);

    // Passkey button visible on localhost
    await expect(localhostPage.getByRole("button", { name: /Sign in with Passkey/i })).toBeVisible();

    // Token toggle expands and collapses cleanly
    const tokenToggle = localhostPage.getByRole("button", { name: /Use a start-up token/i });
    await expect(tokenToggle).toHaveAttribute("aria-expanded", "false");
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute("aria-expanded", "true");
    await expect(localhostPage.getByPlaceholder("Paste HQ start-up token")).toBeVisible();
    await tokenToggle.click();
    await expect(localhostPage.getByPlaceholder("Paste HQ start-up token")).toHaveCount(0);

    localhostErrors.assertClean("live-signin-localhost");
    await localhostCtx.close();

    // 2. http://127.0.0.1:<port>/
    const loopbackCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const loopbackPage = await loopbackCtx.newPage();
    const loopbackErrors = attachErrorCollector(loopbackPage, { allowAuthCheck401: true });

    await loopbackPage.goto(`http://127.0.0.1:${hqPort}/`, { waitUntil: "networkidle" });
    await expect(loopbackPage.getByRole("form", { name: "Sign in" })).toBeVisible();
    await expect(loopbackPage.getByRole("button", { name: /Sign in with Passkey/i })).toHaveCount(0);

    loopbackErrors.assertClean("live-signin-127");
    await loopbackCtx.close();
  });

  test("Token login, WelcomeModal -> Pick team, OwnerPrompt QR + key gate, Settings -> People, Preview Proxy isolation & workspace feedback sync", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = attachErrorCollector(page);

    // 1. Sign in via ?token= and verify token is stripped from the browser URL
    await page.goto(`http://localhost:${hqPort}/?token=${encodeURIComponent(bootstrapToken)}`, {
      waitUntil: "domcontentloaded",
    });

    await expect
      .poll(() => new URL(page.url()).searchParams.has("token"), {
        message: "Expected ?token= to be stripped from URL after bootstrap sign-in",
      })
      .toBe(false);

    // 2. Dismiss WelcomeModal -> verify "Pick team" pill appears in header
    const welcomeDialog = page.getByRole("dialog", { name: /Welcome to ArimaOps/i });
    await expect(welcomeDialog).toBeVisible();
    await welcomeDialog.getByRole("button", { name: "Skip for now" }).click();
    await expect(welcomeDialog).toBeHidden();

    await expect(page.locator("header").getByRole("button", { name: /Pick team/i })).toBeVisible();

    // 3. Create owner in <OwnerPrompt /> -> verify 152x152 SVG QR <img> & key confirmation gate
    const ownerDialog = page.getByRole("dialog", { name: "Make this HQ yours" });
    await expect(ownerDialog).toBeVisible();

    await ownerDialog.getByPlaceholder("Your name").fill("QaOwner");
    await ownerDialog.getByPlaceholder("Password (10+ characters)").fill("ArimaOwnerPass123!");
    await ownerDialog.getByPlaceholder("Confirm password").fill("ArimaOwnerPass123!");
    await ownerDialog.getByRole("button", { name: "Create owner" }).click();

    await expect(ownerDialog.getByText("You're the owner, QaOwner")).toBeVisible();

    const qrImg = ownerDialog.locator('img[alt="Authenticator QR code for QaOwner"]');
    await expect(qrImg).toBeVisible();
    const qrMeta = await qrImg.evaluate((el) => {
      const img = el as HTMLImageElement;
      const rect = img.getBoundingClientRect();
      return {
        src: img.getAttribute("src") ?? "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        complete: img.complete,
        naturalWidth: img.naturalWidth,
      };
    });
    expect(qrMeta.src.startsWith("data:image/svg+xml")).toBe(true);
    expect(qrMeta.width).toBe(152);
    expect(qrMeta.height).toBe(152);
    expect(qrMeta.complete).toBe(true);
    expect(qrMeta.naturalWidth).toBeGreaterThan(0);

    const doneBtn = ownerDialog.getByRole("button", { name: "Done" });
    await expect(doneBtn).toBeDisabled();
    await ownerDialog.getByLabel("I saved my authenticator key").check();
    await expect(doneBtn).toBeEnabled();
    await doneBtn.click();
    await expect(ownerDialog).toBeHidden();

    // 4. Verify Settings -> People lists the newly created owner
    await openSettings(page);
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "People" }).click();
    await expect(page.getByText(/Signed in (as|with the start-up link)/i)).toBeVisible();
    await expect(page.locator('button[role="combobox"][aria-label="QaOwner\'s role"]')).toContainText("owner");
    await page.getByRole("button", { name: "Done" }).click();

    // 4b. First-run team creation completes on the Rust HQ (completeWelcome) and survives a reload
    await page.locator("header").getByRole("button", { name: /Pick team/i }).click();
    const teamDialog = page.getByRole("dialog", { name: /Welcome to ArimaOps/i });
    await teamDialog.getByRole("button", { name: "Create team" }).click();
    await expect(teamDialog).toBeHidden();
    // First-run continues in the setup wizard: sign-in choice, readiness, first Start.
    const wizard = page.getByRole("dialog", { name: /Set up ArimaOps/i });
    await expect(wizard.getByRole("heading", { name: "How do your agents sign in?" })).toBeVisible();
    await wizard.getByRole("button", { name: "Finish later" }).click();
    await expect(wizard).toBeHidden();
    await expect(page.locator("header").getByRole("button", { name: /Guided setup/i })).toBeVisible();
    await expect(page.locator("header").getByRole("button", { name: /Pick team/i })).toBeHidden();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("dialog", { name: /Welcome to ArimaOps/i })).toBeHidden();
    await expect(page.locator("header").getByRole("button", { name: /Pick team/i })).toBeHidden();
    await page.getByRole("button", { name: "Team" }).first().click();
    await expect(page.getByText("Cipher").first()).toBeVisible();

    // 5. Preview Proxy security checks:
    //    (a) Rejects hq_sid-only requests with HTTP 401
    //    (b) Exchanges signed token cleanly & injects ArimaBridge
    const cookies = await context.cookies(`http://localhost:${hqPort}`);
    const hqSid = cookies.find((c) => c.name === "hq_sid");
    expect(hqSid, "Expected hq_sid cookie to be present after sign-in").toBeTruthy();

    const hqSidOnlyRes = await fetch(`http://localhost:${previewPort}/`, {
      headers: { Cookie: `hq_sid=${hqSid!.value}` },
      redirect: "manual",
    });
    expect(
      hqSidOnlyRes.status,
      "Preview proxy must reject hq_sid-only requests with HTTP 401",
    ).toBe(401);

    // Fetch default project id from HQ
    const projRes = await fetch(`http://localhost:${hqPort}/api/projects`, {
      headers: { Cookie: `hq_sid=${hqSid!.value}` },
    });
    expect(projRes.status).toBe(200);
    const projJson = (await projRes.json()) as { projects: Array<{ id: string; slug: string }> };
    expect(projJson.projects.length).toBeGreaterThan(0);
    const projectId = projJson.projects[0].id;

    // Discover targets and pick our isolated mock target port
    const targetsRes = await fetch(
      `http://localhost:${hqPort}/api/projects/${encodeURIComponent(projectId)}/preview/targets`,
      {
        headers: {
          Origin: `http://localhost:${hqPort}`,
          Cookie: `hq_sid=${hqSid!.value}`,
        },
      },
    );
    expect(targetsRes.status).toBe(200);
    const targetsJson = (await targetsRes.json()) as {
      targets: Array<{ id: string; port: number; label: string; status: string }>;
    };
    const ourTarget = targetsJson.targets.find((t) => t.port === mockTarget!.port);
    expect(
      ourTarget,
      `Expected mock preview target on :${mockTarget!.port} in targets: ${JSON.stringify(targetsJson.targets)}`,
    ).toBeTruthy();

    // Issue preview token & verify clean exchange + ArimaBridge injection + X-Frame-Options strip
    const tokRes = await fetch(
      `http://localhost:${hqPort}/api/projects/${encodeURIComponent(projectId)}/preview/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${hqPort}`,
          Cookie: `hq_sid=${hqSid!.value}`,
        },
        body: JSON.stringify({ targetId: ourTarget!.id }),
      },
    );
    expect(tokRes.status).toBe(200);
    const tokJson = (await tokRes.json()) as { previewUrl: string; token: string };
    expect(tokJson.previewUrl).toContain(`http://localhost:${previewPort}/__arima_preview/exchange`);

    const exchangeRes = await fetch(tokJson.previewUrl, { redirect: "manual" });
    expect(exchangeRes.status).toBe(302);
    const previewSetCookie = exchangeRes.headers.get("set-cookie") ?? "";
    expect(previewSetCookie).toContain("arima_preview_sid=");
    const previewCookiePair = previewSetCookie.split(";")[0];

    const proxiedHtmlRes = await fetch(`http://localhost:${previewPort}/`, {
      headers: { Cookie: previewCookiePair },
    });
    expect(proxiedHtmlRes.status).toBe(200);
    expect(proxiedHtmlRes.headers.get("x-frame-options")).toBeNull();
    const proxiedHtml = await proxiedHtmlRes.text();
    expect(proxiedHtml).toContain('data-arima-bridge="1"');
    expect(proxiedHtml).toContain("Isolated Preview App");

    // 6. Real Browser Preview Workspace -> Freeze & Draw -> Submit Feedback -> Verify disk sync
    await gotoWorkspace(page, "Preview");
    await expect(page.getByRole("heading", { name: "Live preview" })).toBeVisible();

    // Select our mock target explicitly in case another local dev port (like :5173) was also discovered
    const targetCombobox = page.locator('button[role="combobox"][aria-label="Preview target"]');
    await expect(targetCombobox).toBeVisible();
    await expect
      .poll(async () => (await targetCombobox.textContent()) ?? "", { timeout: 10_000 })
      .not.toContain("No running preview targets detected");

    await targetCombobox.click();
    const targetListbox = page.locator('[role="listbox"][aria-label="Preview target"]');
    await expect(targetListbox).toBeVisible();
    await targetListbox
      .getByRole("option", { name: new RegExp(`:${mockTarget!.port}\\b`) })
      .click();

    // Verify iframe loads our proxied mock app cleanly through the isolated preview proxy
    const iframe = page.locator("iframe").first();
    await expect(iframe).toBeVisible();
    await expect(iframe.contentFrame().locator("#e2e-preview-title")).toHaveText(
      "Isolated Preview App",
      { timeout: 15_000 },
    );

    // Switch to Freeze & Draw, draw a stroke, submit feedback
    await page.getByRole("group", { name: "Preview interaction mode" }).getByRole("button", { name: "Freeze and draw" }).click();
    const canvas = page.locator('canvas[aria-label="Annotation drawing canvas"]');
    await drawCanvasStroke(page, canvas);
    await expect(page.getByText(/Annotations · 1 stroke\b/i)).toBeVisible();

    const feedbackNote = "Live Rust HQ E2E visual feedback check";
    await page.getByRole("button", { name: /Send Feedback/i }).click();
    const modal = page.getByRole("dialog", { name: "Send visual feedback" });
    await expect(modal).toBeVisible();
    await modal.locator("textarea").fill(feedbackNote);
    await modal.getByRole("button", { name: /Create Task with Screenshot/i }).click();
    await expect(modal).toBeHidden();

    // Confirm feedback appears in UI AND files exist in <tempWorkspace>/.arima/feedback/<id>/
    await expect(page.getByText(feedbackNote)).toBeVisible();

    const feedbackRoot = path.join(tempWorkspace, ".arima", "feedback");
    expect(fs.existsSync(feedbackRoot), `Expected ${feedbackRoot} to exist`).toBe(true);
    const feedbackDirs = fs
      .readdirSync(feedbackRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(feedbackDirs.length).toBeGreaterThanOrEqual(1);

    const fbDir = path.join(feedbackRoot, feedbackDirs[0]);
    const annotatedPngPath = path.join(fbDir, "annotated.png");
    const contextJsonPath = path.join(fbDir, "context.json");

    expect(fs.existsSync(annotatedPngPath), `Missing ${annotatedPngPath}`).toBe(true);
    expect(fs.existsSync(contextJsonPath), `Missing ${contextJsonPath}`).toBe(true);

    const pngBytes = fs.readFileSync(annotatedPngPath);
    expect(pngBytes.subarray(0, 8).equals(PNG_MAGIC), "annotated.png must start with valid PNG header").toBe(true);

    const ctxJson = JSON.parse(fs.readFileSync(contextJsonPath, "utf8")) as {
      id: string;
      note: string;
      workspaceRelDir: string;
    };
    expect(ctxJson.id).toBe(feedbackDirs[0]);
    expect(ctxJson.note).toBe(feedbackNote);
    expect(ctxJson.workspaceRelDir).toBe(`.arima/feedback/${feedbackDirs[0]}`);

    // 7. M4 (v2.0-beta) live Rust HQ round-trips: Findings CVSS 4.0 + SARIF/HTML export, FTS5 Memory, Voice Status, and Encrypted Backup/Verify/Restore UI
    const hqOrigin = `http://localhost:${hqPort}`;
    const authedHeaders = {
      "Content-Type": "application/json",
      Origin: hqOrigin,
      Cookie: `hq_sid=${hqSid!.value}`,
    };

    // 7a. Scope + CVSS 4.0 Finding + SARIF 2.1.0 & XSS-safe HTML export
    const scopePut = await fetch(`${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/scope`, {
      method: "PUT",
      headers: authedHeaders,
      body: JSON.stringify({
        inScope: ["app.example.test"],
        outOfScope: ["169.254.169.254"],
        notes: "E2E scope validation",
      }),
    });
    expect(scopePut.status).toBe(200);

    const findingRes = await fetch(`${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/findings`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({
        title: "SSRF in webhook fetcher <script>alert(1)</script>",
        target: "https://app.example.test/api/webhook",
        cwe: "CWE-918",
        cvssVector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:H/SI:N/SA:N",
        descriptionMarkdown: "Server fetches unvalidated URLs.",
        reproductionMarkdown: "POST /api/webhook with metadata URL.",
        remediationMarkdown: "Validate resolved IPs before connect.",
      }),
    });
    expect(findingRes.status).toBe(200);
    const findingJson = (await findingRes.json()) as {
      finding: { id: string; cvssScore: number; severity: string };
    };
    expect(findingJson.finding.cvssScore).toBeGreaterThanOrEqual(8.0);
    expect(["critical", "high"]).toContain(findingJson.finding.severity);

    const sarifRes = await fetch(
      `${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/findings/export?format=sarif`,
      { headers: { Cookie: `hq_sid=${hqSid!.value}` } },
    );
    expect(sarifRes.status).toBe(200);
    expect(sarifRes.headers.get("content-type") ?? "").toContain("sarif");
    const sarif = (await sarifRes.json()) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.results.length).toBeGreaterThanOrEqual(1);

    const htmlExportRes = await fetch(
      `${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/findings/export?format=html`,
      { headers: { Cookie: `hq_sid=${hqSid!.value}` } },
    );
    expect(htmlExportRes.status).toBe(200);
    const htmlExport = await htmlExportRes.text();
    expect(htmlExport).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(htmlExport).not.toContain("<script>alert(1)</script>");

    // 7b. FTS5 Memory extraction/search & Voice status
    const extractRes = await fetch(`${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/memory/extract`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({
        taskId: "E2E-T1",
        summary: "Decision: Enforce edge sliding-window rate limits in middleware.ts before Postgres auth lookup.",
      }),
    });
    expect(extractRes.status).toBe(200);

    const memSearchRes = await fetch(
      `${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/memory?q=middleware`,
      { headers: { Cookie: `hq_sid=${hqSid!.value}` } },
    );
    expect(memSearchRes.status).toBe(200);
    const memSearchJson = (await memSearchRes.json()) as { memories: Array<{ id: string }> };
    expect(Array.isArray(memSearchJson.memories)).toBe(true);

    const voiceRes = await fetch(`${hqOrigin}/api/voice/status`, {
      headers: { Cookie: `hq_sid=${hqSid!.value}` },
    });
    expect(voiceRes.status).toBe(200);
    const voiceJson = (await voiceRes.json()) as { providers: { browserWebSpeech: boolean } };
    expect(voiceJson.providers.browserWebSpeech).toBe(true);

    // 7c. Encrypted Backup -> Verify -> Restore live UI + API guard round-trip
    await openSettings(page);
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Memory" }).click();
    const backupSection = page.getByRole("region", { name: "Encrypted backups and restore" });
    await expect(backupSection).toBeVisible();

    await backupSection.getByRole("button", { name: /Create encrypted backup/i }).click();
    const archiveList = backupSection.getByRole("list", { name: "Encrypted backup archives" });
    await expect(archiveList.locator("li").first()).toBeVisible();
    await expect(archiveList.locator("li").first()).toContainText(/\.arimabak/i);

    await archiveList.locator("li").first().getByRole("button", { name: /Verify archive/i }).click();
    const manifest = backupSection.getByRole("status", { name: "Verified backup manifest" });
    await expect(manifest).toBeVisible();
    await expect(manifest).toContainText(/Integrity OK/i);
    await expect(manifest).toContainText(/1 project/i);

    // Confirm API rejects restore without exact confirm="RESTORE"
    const listBkRes = await fetch(`${hqOrigin}/api/backups`, {
      headers: { Cookie: `hq_sid=${hqSid!.value}` },
    });
    expect(listBkRes.status).toBe(200);
    const listBkJson = (await listBkRes.json()) as { backups: Array<{ id: string }> };
    expect(listBkJson.backups.length).toBeGreaterThanOrEqual(1);

    const badRestoreRes = await fetch(`${hqOrigin}/api/backups/restore`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({ id: listBkJson.backups[0].id, confirm: "nope" }),
    });
    expect(badRestoreRes.status).toBe(400);

    // Complete restore via real browser modal with exact "RESTORE" confirmation
    await archiveList.locator("li").first().getByRole("button", { name: /Restore backup/i }).click();
    const restoreDialog = page.getByRole("dialog", { name: "Confirm encrypted backup restore" });
    await expect(restoreDialog).toBeVisible();
    await restoreDialog.locator('input[aria-label="Type RESTORE to confirm"]').fill("RESTORE");
    await restoreDialog.getByRole("button", { name: "Confirm Restore" }).click();
    await expect(restoreDialog).toBeHidden();
    await expect(backupSection.getByText(/Restored encrypted backup/i)).toBeVisible();

    // 8. M5 (v2.0-GA) live Rust HQ round-trips: Ed25519 License, Factory Score & Replay Benchmark, Vaulted Connections (no secret echo)
    const licRes = await fetch(`${hqOrigin}/api/license`, {
      headers: { Cookie: `hq_sid=${hqSid!.value}` },
    });
    expect(licRes.status).toBe(200);
    const licJson = (await licRes.json()) as {
      tier: string;
      status: string;
      maxSeats: number;
      activeSeats: number;
    };
    expect(licJson.tier).toBe("community");
    expect(licJson.status).toBe("community");
    expect(licJson.maxSeats).toBeGreaterThanOrEqual(1);
    expect(licJson.activeSeats).toBeGreaterThanOrEqual(1);

    const scoreRes = await fetch(`${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/factory/score`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({ taskId: "E2E-T1", rubric: "Clean tests and zero regressions", useLlm: false }),
    });
    expect(scoreRes.status).toBe(200);
    const scoreJson = (await scoreRes.json()) as {
      score: { id: string; taskId: string; score: number; passed: boolean };
    };
    expect(scoreJson.score.taskId).toBe("E2E-T1");
    expect(scoreJson.score.score).toBeGreaterThanOrEqual(0);

    const bmRes = await fetch(`${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/factory/benchmark`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({
        name: "Live E2E Replay Suite",
        cases: [
          {
            id: "e2e-case-1",
            prompt: "Verify viewer RBAC audit logging blocks mutations with 403.",
            expectedKeywords: ["viewer", "audit", "403"],
          },
        ],
      }),
    });
    expect(bmRes.status).toBe(200);
    const bmJson = (await bmRes.json()) as {
      benchmark: { id: string; name: string; passRate: number; avgScore: number; cases: unknown[] };
    };
    expect(bmJson.benchmark.name).toBe("Live E2E Replay Suite");
    expect(bmJson.benchmark.cases.length).toBe(1);

    const rawSecret = "xoxb-e2e-top-secret-never-echo-424242";
    const connCreateRes = await fetch(`${hqOrigin}/api/connections`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({
        id: "e2e-slack",
        kind: "slack",
        label: "E2E Slack Alerts",
        endpoint: "https://slack.com/api/chat.postMessage",
        secret: rawSecret,
      }),
    });
    expect(connCreateRes.status).toBe(200);
    const connCreateText = await connCreateRes.text();
    expect(connCreateText, "POST /api/connections must NEVER echo raw secret").not.toContain(rawSecret);

    const connListRes = await fetch(`${hqOrigin}/api/connections`, {
      headers: { Cookie: `hq_sid=${hqSid!.value}` },
    });
    expect(connListRes.status).toBe(200);
    const connListText = await connListRes.text();
    expect(connListText, "GET /api/connections must NEVER echo raw secret").not.toContain(rawSecret);
    const connListJson = JSON.parse(connListText) as {
      connections: Array<{ id: string; hasSecret: boolean }>;
    };
    const e2eConn = connListJson.connections.find((c) => c.id === "e2e-slack");
    expect(e2eConn).toBeTruthy();
    expect(e2eConn!.hasSecret).toBe(true);

    // 9. Agent forms over the real MCP + WebSocket stack: ask_user(ui) -> Inbox -> browser answer -> outbox + read-only history
    const agentId = "cipher";
    const mcpToken = `mcp_e2e_form_${crypto.randomBytes(12).toString("hex")}`;
    const tokenHash = crypto.createHash("sha256").update(mcpToken).digest("hex");
    const dbPath = path.join(tempHome, "arima.db");
    {
      const db = new DatabaseSync(dbPath);
      db.prepare(
        "INSERT INTO mcp_tokens (project_id, agent_id, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, agent_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at",
      ).run(projectId, agentId, tokenHash, Date.now());
      db.close();
    }

    const askRes = await fetch(`${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: hqOrigin,
        Authorization: `Bearer ${mcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ask_user",
          arguments: {
            title: "Configure release pipeline",
            details: "Choose the release channel and tag prefix before tagging.",
            ui: {
              components: [
                { id: "root", component: "Column", children: ["intro", "prefix", "channel", "checks", "go"] },
                { id: "intro", component: "Text", text: { "@path": "/intro" } },
                { id: "prefix", component: "TextField", label: "Tag prefix", value: { "@path": "/prefix" }, placeholder: "v" },
                {
                  id: "channel",
                  component: "Select",
                  label: "Release channel",
                  options: [
                    { value: "stable", label: "Stable" },
                    { value: "beta", label: "Beta" },
                  ],
                  value: { "@path": "/channel" },
                },
                {
                  id: "checks",
                  component: "CheckList",
                  label: "Pre-release checks",
                  multi: true,
                  options: [
                    { value: "sign", label: "Sign artifacts" },
                    { value: "notes", label: "Draft release notes" },
                  ],
                  values: { "@path": "/checks" },
                },
                {
                  id: "go",
                  component: "ButtonRow",
                  buttons: [
                    {
                      label: "Confirm release",
                      variant: "primary",
                      action: { event: { name: "confirm", context: { prefix: { "@path": "/prefix" } } } },
                    },
                    { label: "Cancel", action: { event: { name: "cancel" } } },
                  ],
                },
              ],
              data: { intro: "Release settings for this project.", prefix: "", channel: "stable", checks: [] },
            },
          },
        },
      }),
    });
    expect(askRes.status).toBe(200);
    const askJson = (await askRes.json()) as {
      result?: { structuredContent?: { decisionId: string; status: string } };
      error?: { message: string };
    };
    expect(askJson.error, `MCP ask_user failed: ${JSON.stringify(askJson.error)}`).toBeUndefined();
    const formDecisionId = askJson.result?.structuredContent?.decisionId ?? "";
    expect(formDecisionId).toBeTruthy();

    // Close Settings modal if still open from step 7c, then open Inbox and answer the live form card
    const doneSettingsBtn = page.getByRole("button", { name: "Done" });
    if (await doneSettingsBtn.isVisible().catch(() => false)) {
      await doneSettingsBtn.click();
    }
    await gotoWorkspace(page, "Inbox");
    const waitingList = page.getByRole("listbox", { name: "Waiting on you" });
    const formOption = waitingList.getByRole("option", { name: /Configure release pipeline/i });
    await expect(formOption).toBeVisible({ timeout: 10_000 });
    await formOption.locator("button").first().click();

    const formCard = page.getByRole("article", { name: "Configure release pipeline" });
    await expect(formCard.getByText("Release settings for this project.")).toBeVisible();
    await formCard.getByLabel("Tag prefix").fill("rel-");
    await formCard.getByRole("combobox", { name: "Release channel" }).click();
    await page.getByRole("listbox", { name: "Release channel" }).getByRole("option", { name: "Beta" }).click();
    await formCard.getByRole("button", { name: /Sign artifacts/i }).click();
    await formCard.getByRole("button", { name: "Confirm release" }).click();

    // Form leaves the open Inbox list once answered
    await expect(waitingList.getByRole("option", { name: /Configure release pipeline/i })).toHaveCount(0, {
      timeout: 10_000,
    });

    // Verify resolved decision via HQ REST API
    const decsRes = await fetch(`${hqOrigin}/api/projects/${encodeURIComponent(projectId)}/decisions`, {
      headers: { Cookie: `hq_sid=${hqSid!.value}` },
    });
    expect(decsRes.status).toBe(200);
    const decsJson = (await decsRes.json()) as {
      decisions: Array<{
        id: string;
        status: string;
        payload: {
          kind: string;
          answer?: {
            action: string;
            componentId: string;
            context: Record<string, unknown>;
            data: { prefix: string; channel: string; checks: string[] };
          };
        };
      }>;
    };
    const resolvedDec = decsJson.decisions.find((d) => d.id === formDecisionId);
    expect(resolvedDec).toBeTruthy();
    expect(resolvedDec!.status).toBe("resolved");
    expect(resolvedDec!.payload.kind).toBe("form");
    expect(resolvedDec!.payload.answer?.action).toBe("confirm");
    expect(resolvedDec!.payload.answer?.context).toEqual({ prefix: "rel-" });
    expect(resolvedDec!.payload.answer?.data).toMatchObject({
      prefix: "rel-",
      channel: "beta",
      checks: ["sign"],
    });

    // Verify the answer reached Cipher's durable SQLite outbox
    {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare("SELECT kind, payload_json FROM agent_outbox WHERE project_id = ? AND agent_id = ? ORDER BY epoch DESC, seq DESC")
        .all(projectId, agentId) as Array<{ kind: string; payload_json: string }>;
      db.close();
      const hit = rows
        .filter((r) => r.kind === "decision-answer")
        .map((r) => JSON.parse(r.payload_json) as { decisionId: string; status: string; payload: { kind: string; answer?: { action: string; data: { prefix: string; channel: string; checks: string[] } } } })
        .find((p) => p.decisionId === formDecisionId);
      expect(hit, `Expected decision-answer outbox entry for ${formDecisionId}, saw: ${JSON.stringify(rows)}`).toBeTruthy();
      expect(hit!.status).toBe("resolved");
      expect(hit!.payload.kind).toBe("form");
      expect(hit!.payload.answer?.action).toBe("confirm");
      expect(hit!.payload.answer?.data).toMatchObject({
        prefix: "rel-",
        channel: "beta",
        checks: ["sign"],
      });
    }

    // Verify answered form is visible read-only with its submitted answer in Inbox Closed and Cipher's Chat thread
    await page.getByRole("button", { name: /^Closed \(/i }).click();
    await page.getByRole("button", { name: /Configure release pipeline/i }).click();
    const closedCard = page.getByRole("article", { name: "Configure release pipeline" });
    await expect(closedCard.getByLabel("Tag prefix")).toHaveValue("rel-");
    await expect(closedCard.getByLabel("Tag prefix")).toBeDisabled();
    await expect(closedCard.getByRole("combobox", { name: "Release channel" })).toBeDisabled();
    await expect(closedCard.getByRole("status")).toContainText("Answered: Confirm release");

    await gotoWorkspace(page, "Team");
    await page.getByRole("navigation", { name: "Team sections" }).getByRole("button", { name: /^Chat/i }).click();
    await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: /Cipher/i }).click();
    const chatCard = page.getByRole("article", { name: "Configure release pipeline" });
    await expect(chatCard).toBeVisible();
    await expect(chatCard.getByLabel("Tag prefix")).toHaveValue("rel-");
    await expect(chatCard.getByLabel("Tag prefix")).toBeDisabled();
    await expect(chatCard.getByRole("status")).toContainText("Answered: Confirm release");

    errors.assertClean("live-rust-hq-e2e");
    await context.close();
  });
});
