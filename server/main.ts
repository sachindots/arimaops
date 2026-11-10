// arimaops: one server for all your projects: every registered project plus the repo you're in.
//
//   arimaops [--repo <path>] [--port 7420] [--dev] [--no-open] [--host 0.0.0.0] [--remote] [--origin <url>]
//
// --ntfy <topic>: push to your phone/tablet (ntfy app) when an agent waits on you.
// --remote: tablet/phone access. Prints operator + viewer links for LAN and Tailscale.
//           Prefer `tailscale serve 7420` (HTTPS, tailnet only) over exposing --host 0.0.0.0.
//
// --dev: the UI is served by Vite (pnpm dev:hq); HQ prints/opens the Vite URL.

import { scrubbedVars } from "./lib/scrubEnv"; // must stay the first import
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/data/brand";
import { ensureNetwork, GATEWAY, startEgressProxy } from "./containers";
import { startHttp } from "./http";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { ensurePtyHelperExecutable } from "./lib/ptyFix";
import { browserToken } from "./paths";
import { migrateHome, startProject, type Runtime } from "./project";
import { dropLiveProject, readRegistry } from "./projectsRegistry";
import { detectRepo } from "./repo";
import { slugOf } from "./store";
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

// Skip Docker/libvirt bridges and VPN-less virtual links: a tablet on the LAN can't reach those.
const lanIps = () =>
  Object.entries(networkInterfaces())
    .filter(([name]) => !/^(docker|br-|virbr|veth|lo)/.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((n) => n.family === "IPv4" && !n.internal)
    .map((n) => n.address);

async function main() {
  // scrubEnv (first import) already removed a parent agent session's variables, before anything copied process.env.
  const scrubbed = scrubbedVars;
  if (scrubbed.length) log.info(`started inside an agent session: not passing ${scrubbed.length} of its variables (${scrubbed.slice(0, 3).join(", ")}…) to HQ's agents`);
  ensurePtyHelperExecutable();
  // ~/.arima → ~/.arima, before anything reads it.
  migrateHome();
  const dev = flag("dev");
  const port = Number(arg("port") ?? process.env.HQ_PORT ?? 7420);
  const remote = flag("remote") || !!arg("host");
  const host = arg("host") ?? process.env.HQ_HOST ?? "127.0.0.1";
  const ntfy = arg("ntfy") ?? process.env.HQ_NTFY_TOPIC;

  // Which folders to load: every registered project, plus --repo (or the current folder, as before).
  // The current folder only counts when it's already a repo, or nothing is registered yet (first run with npx).
  const registered = readRegistry().filter((e) => existsSync(e.path) && !e.archived);
  const explicit = arg("repo") ?? process.env.HQ_REPO;
  const cwdIsRepo = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })).ok;
  const launch = explicit ? resolve(explicit) : cwdIsRepo || !registered.length ? process.cwd() : null;
  const paths = [...(launch ? [launch] : []), ...registered.map((e) => e.path)];
  const pausedPaths = new Set(registered.filter((e) => e.paused).map((e) => resolve(e.path)));

  const projects = new Map<string, Runtime>();
  const seenRoots = new Set<string>();
  let launchSlug: string | null = null;
  const loadProject = async (path: string, isLaunch = false) => {
    try {
      const repo = await detectRepo(path);
      const slug = slugOf(repo);
      if (seenRoots.has(repo.root)) return;
      if (projects.has(slug)) return log.warn(`skipping ${repo.root}: project id "${slug}" is already used by ${projects.get(slug)!.root}`);
      seenRoots.add(repo.root);
      const rt = await startProject(repo.root, port, pausedPaths.has(resolve(repo.root)));
      projects.set(rt.slug, rt);
      if (isLaunch) launchSlug = rt.slug;
      if (ntfy) startPushNotifier(rt.hub, ntfy, undefined, process.env.HQ_PUBLIC_URL);
    } catch (err) {
      log.warn(`couldn't load ${path}: ${err instanceof Error ? err.message : err}`);
    }
  };
  /** Stops a project's agents and takes it out of this server (archive). Its files stay. */
  const unloadProject = async (slug: string) => {
    const rt = projects.get(slug);
    if (!rt) return;
    for (const a of rt.hub.snap.config.team) await Promise.resolve(rt.commands.stopAgent(a.id)).catch(() => {});
    rt.shutdown();
    projects.delete(slug);
    seenRoots.delete(rt.root);
    dropLiveProject(rt.root);
  };
  log.info("checking setup…");
  // One at a time: setup checks and sbx calls are shared tools, and the order keeps --repo first.
  for (const [i, p] of paths.entries()) await loadProject(p, !!launch && i === 0);
  if (!projects.size) throw new Error("No project to load. Run inside a git repo, or pass --repo <path>.");
  const defaultProject = () => (launchSlug && projects.has(launchSlug) ? launchSlug : [...projects.keys()][0]);

  const first = projects.get(defaultProject())!;
  const uiToken = browserToken(first.slug, dev);
  const viewerToken = randomBytes(24).toString("hex");

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, "dist");
  const uiPort = Number(process.env.HQ_UI_PORT ?? 5173);
  const uiOrigin = dev ? `http://localhost:${uiPort}` : `http://127.0.0.1:${port}`;
  if (!dev && !existsSync(join(distDir, "index.html"))) log.warn("No built UI found. Run `pnpm build` first, or use `pnpm dev:hq`.");

  const guard = new RemoteGuard(undefined, first.slug);
  // Container mode: the agents' network, HQ on its gateway, and the allowlist proxy. Skipped without Docker.
  const containers = (await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000 })).ok && (await ensureNetwork());
  if (containers) startEgressProxy(projects, port);
  await startHttp({
    projects,
    defaultProject,
    loadProject: (path) => loadProject(path),
    unloadProject,
    port,
    browserToken: uiToken,
    viewerToken,
    host,
    extraHosts: containers ? [GATEWAY] : [],
    sameOrigin: remote,
    localOrigins: [uiOrigin, `http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
    guard,
    distDir: dev ? null : distDir,
    allowedOrigins: [uiOrigin, `http://127.0.0.1:${uiPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...args("origin"), ...(process.env.HQ_ORIGINS?.split(",").filter(Boolean) ?? [])],
  });

  // Container checks that need HQ listening (containers reaching it) ran before it was up: run them again.
  for (const rt of projects.values()) if (rt.hub.snap.config.team.some((a) => a.mode === "container")) void rt.recheckSetup();

  const url = `${uiOrigin}/?token=${uiToken}`;
  log.info(`\n\n  ${BRAND.name} (${BRAND.fullName}) is running → ${url}\n  projects: ${[...projects.values()].map((p) => `${p.slug}${p.paused ? " (paused)" : ""}`).join(", ")}\n`);
  if (remote) {
    const ts = await tailscaleName();
    const lines = [`  Remote (tablet/phone) — keep these links private. Opening one signs that device in for 30 days:`];
    lines.push(`    local viewer → ${uiOrigin}/?token=${viewerToken}&role=viewer`);
    if (ts) lines.push(`    Tailscale  run: tailscale serve --bg ${port}`, `      operator → https://${ts}/?token=${uiToken}`, `      viewer   → https://${ts}/?token=${viewerToken}&role=viewer`);
    if (host !== "127.0.0.1" && host !== "localhost")
      for (const ip of host === "0.0.0.0" ? lanIps() : [host])
        lines.push(`    LAN ${ip}`, `      operator → http://${ip}:${port}/?token=${uiToken}`, `      viewer   → http://${ip}:${port}/?token=${viewerToken}&role=viewer`);
    if (lines.length === 2) lines.push(`    Install Tailscale (recommended) or pass --host 0.0.0.0 for LAN.`);
    lines.push(
      `  Risky commands from remote (terminal, approvals, secrets, settings) need a 6-digit code once a day per device.`,
      `    Add to Google Authenticator / Aegis / 1Password once:  ${guard.otpauthUrl()}`,
      `    (or type the key manually: ${guard.secretB32})`,
      `  Audit log: ~/.arima/audit.log`,
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
    log.info("stopping HQ — agent sessions in tmux keep running; pty agents stop. Sandboxes and folders are kept.");
    for (const rt of projects.values()) rt.shutdown();
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
