// dothq — start .hq for the git repo you're in.
//
//   dothq [--repo <path>] [--port 7420] [--dev] [--no-open] [--host 0.0.0.0] [--remote] [--origin <url>]
//
// --ntfy <topic>: push to your phone/tablet (ntfy app) when an agent waits on you.
// --remote: tablet/phone access. Prints operator + viewer links for LAN and Tailscale.
//           Prefer `tailscale serve 7420` (HTTPS, tailnet only) over exposing --host 0.0.0.0.
//
// --dev: the UI is served by Vite (pnpm dev:hq); HQ prints/opens the Vite URL.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/data/brand";
import { makeCommands } from "./commands";
import { startHttp } from "./http";
import { Hub } from "./hub";
import { GitHubSync } from "./githubSync";
import { Inbox } from "./inbox";
import { Planner } from "./planner";
import { ActionItems } from "./actionItems";
import { Sbx } from "./sbx";
import { SbxMcp } from "./sbxMcp";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { ensurePtyHelperExecutable } from "./lib/ptyFix";
import { agentToken, browserToken } from "./paths";
import { detectRepo } from "./repo";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan } from "./store";
import { RemoteGuard, startPushNotifier } from "./remote";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const args = (name: string) => process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));

/** Tailscale MagicDNS name of this machine, if Tailscale is up. */
async function tailscaleName(): Promise<string | null> {
  const r = await run("tailscale", ["status", "--json"]);
  if (!r.ok) return null;
  try {
    const name = String((JSON.parse(r.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
    return name || null;
  } catch {
    return null;
  }
}

const lanIps = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n!.address);

async function main() {
  ensurePtyHelperExecutable();
  const dev = flag("dev");
  const port = Number(arg("port") ?? process.env.HQ_PORT ?? 7420);
  const repo = await detectRepo(resolve(arg("repo") ?? process.env.HQ_REPO ?? process.cwd()));
  const { config, isNew } = loadConfig(repo, port);
  config.project.hqPort = port;
  const slug = config.project.id;
  const token = agentToken(slug);
  const uiToken = browserToken(slug, dev);
  const viewerToken = randomBytes(24).toString("hex");
  const remote = flag("remote") || !!arg("host");
  const host = arg("host") ?? process.env.HQ_HOST ?? "127.0.0.1";

  log.info(`repo   ${repo.root}${repo.github ? `  (github.com/${repo.github})` : ""}`);
  log.info("checking setup…");
  const setup = await runSetupChecks(repo, config.team);
  for (const c of setup.checks) log.info(`  ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

  const hub = new Hub(repo, slug, config, loadPlan(repo.root), setup);
  hub.snap.welcome = isNew;
  const sessions = new Sessions(hub, token);
  const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id) });
  sessions.onSessionDown = (id) => inbox.sessionDown(id);
  sessions.onSessionReattached = (id) => inbox.sessionReattached(id);
  sessions.lastHookAt = (id) => inbox.lastHookAt(id);
  const sbx = new Sbx(hub);
  sessions.envFileFor = (id) => (existsSync(sbx.envFile(id)) ? sbx.envFile(id) : null);
  const mcp = new SbxMcp(hub, (id, file, args, onExit) => sessions.runTerminal(id, file, args, onExit));
  sessions.onSandboxReady = (id) => {
    void sbx.syncRules(id);
    void mcp.attachAll(id);
    void sbx.refreshPorts(id);
  };
  sessions.onSessionDown = ((down) => (id: string) => {
    down(id);
    void sbx.refreshPorts(id);
  })(sessions.onSessionDown);
  sessions.onSandboxRemoved = (id) => {
    mcp.forget(id);
    void sbx.refreshPorts(id);
  };
  void sbx.refresh();
  void mcp.refresh();
  const planner = new Planner(hub, inbox);
  planner.actions = new ActionItems(hub, planner);

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, "dist");
  const uiPort = Number(process.env.HQ_UI_PORT ?? 5173);
  const uiOrigin = dev ? `http://localhost:${uiPort}` : `http://127.0.0.1:${port}`;
  if (!dev && !existsSync(join(distDir, "index.html"))) log.warn("No built UI found. Run `pnpm build` first, or use `pnpm dev:hq`.");

  const guard = new RemoteGuard(slug, config.project.name);
  await startHttp({
    hub,
    inbox,
    planner,
    port,
    browserToken: uiToken,
    viewerToken,
    agentToken: token,
    host,
    sameOrigin: remote,
    localOrigins: [uiOrigin, `http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
    guard,
    distDir: dev ? null : distDir,
    allowedOrigins: [uiOrigin, `http://127.0.0.1:${uiPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...args("origin"), ...(process.env.HQ_ORIGINS?.split(",").filter(Boolean) ?? [])],
    commands: makeCommands(hub, sessions, planner, inbox, sbx, mcp),
  });
  const ntfy = arg("ntfy") ?? process.env.HQ_NTFY_TOPIC;
  if (ntfy) startPushNotifier(hub, ntfy, undefined, process.env.HQ_PUBLIC_URL);
  sessions.startPolling();
  sbx.startApprovalPolling();
  const github = new GitHubSync(hub, planner, repo.github);
  github.start();

  const url = `${uiOrigin}/?token=${uiToken}`;
  log.info(`\n\n  ${BRAND.name} (${BRAND.fullName}) is running → ${url}\n`);
  if (remote) {
    const ts = await tailscaleName();
    const lines = [`  Remote (tablet/phone) — keep these links private:`];
    lines.push(`    local viewer → ${uiOrigin}/?token=${viewerToken}&role=viewer`);
    if (ts) lines.push(`    Tailscale  run: tailscale serve --bg ${port}`, `      operator → https://${ts}/?token=${uiToken}`, `      viewer   → https://${ts}/?token=${viewerToken}&role=viewer`);
    if (host !== "127.0.0.1" && host !== "localhost")
      for (const ip of host === "0.0.0.0" ? lanIps() : [host])
        lines.push(`    LAN ${ip}`, `      operator → http://${ip}:${port}/?token=${uiToken}`, `      viewer   → http://${ip}:${port}/?token=${viewerToken}&role=viewer`);
    if (lines.length === 2) lines.push(`    Install Tailscale (recommended) or pass --host 0.0.0.0 for LAN.`);
    lines.push(
      `  Risky commands from remote (terminal, approvals, secrets, settings) need a 6-digit code.`,
      `    Add to Google Authenticator / Aegis / 1Password once:  ${guard.otpauthUrl()}`,
      `    (or type the key manually: ${guard.secretB32})`,
      `  Audit log: ~/.hq/${slug}/audit.log`,
    );
    log.info(lines.join("\n") + "\n");
  }
  if (!flag("no-open")) {
    // Windows: rundll32 hands the URL to the default browser without a shell (the token has no special chars, but `&` would).
    const [opener, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    // Give Vite a moment in dev.
    setTimeout(() => void run(opener, args), dev ? 1500 : 0);
  }

  const quit = () => {
    log.info(sessions.backend.persistent ? "stopping HQ — agent sessions keep running in tmux" : "stopping HQ and its agents — sandboxes and folders are kept");
    sessions.shutdown();
    sbx.stopApprovalPolling();
    github.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log.error(`Port ${arg("port") ?? 7420} is in use — another HQ may be running. Stop it, or pick another port: npx ${BRAND.bin} --port 7421`);
    process.exit(1);
  }
  if ((err as NodeJS.ErrnoException)?.code === "EACCES") {
    const port = arg("port") ?? 7420;
    log.error(
      process.platform === "win32"
        ? `Windows reserved port ${port} (Hyper-V, WSL and Docker reserve port ranges). Pick another: npx ${BRAND.bin} --port 8420\n  See the reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp`
        : `Not allowed to use port ${port}. Pick another: npx ${BRAND.bin} --port 8420`,
    );
    process.exit(1);
  }
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
