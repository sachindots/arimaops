// Container mode: agents in plain Docker containers (for a VM without nested virtualization).
//  - Network: containers sit on `hq-agents` (172.30.0.0/24, bridge br-hq, no container-to-container traffic).
//    They reach HQ at the bridge gateway 172.30.0.1, where HQ also listens.
//  - Internet: only through HQ's allowlist proxy on the gateway (EGRESS_PORT). A host firewall rule makes that
//    mandatory (setup check "egress-lock"); HQ never runs sudo, so it shows the command.
//  - Sign-in: one Docker volume per CLI (hq-auth-<cli>), shared by that CLI's containers; you sign in once.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCli, AgentConfig } from "../src/data/types";
import { BRAND } from "../src/data/brand";
import { requestAccess } from "./access";
import { checkScope } from "./scope";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import type { Runtime } from "./project";

export const IMAGE = "dothq-agent";
export const NETWORK = "hq-agents";
export const BRIDGE = "br-hq";
export const SUBNET = "172.30.0.0/24";
export const GATEWAY = "172.30.0.1";
export const egressPort = (hqPort: number) => Number(process.env.HQ_EGRESS_PORT ?? hqPort + 1000);
const WORKDIR = "/work";

/** Where each CLI keeps its sign-in inside the image (the shared login volume mounts here). */
const AUTH_DIR: Partial<Record<AgentCli, string>> = {
  claude: "/auth/claude",
  codex: "/auth/codex",
  gemini: "/home/agent/.gemini",
  copilot: "/home/agent/.copilot",
  opencode: "/home/agent/.local/share/opencode",
};
export const containerClis = Object.keys(AUTH_DIR) as AgentCli[];
/** Where containers keep a CLI's sign-in: one volume per CLI and account. */
export const authVolume = (cli: AgentCli, account = "default") => (account === "default" ? `hq-auth-${cli}` : `hq-auth-${cli}-${account}`);

/** With a host firewall that drops incoming traffic (ufw's default), containers need this to reach HQ and its proxy. */
export const hostFirewallCmd = (hqPort: number) => `sudo ufw allow in on ${BRIDGE} to ${GATEWAY} port ${hqPort},${egressPort(hqPort)} proto tcp`;

/** The firewall rule that makes the proxy mandatory: drop everything containers send past the host (the host itself is INPUT, not FORWARD). */
export const EGRESS_LOCK_CMD = `sudo iptables -I DOCKER-USER -i ${BRIDGE} -j DROP`;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const buildCommand = () =>
  `docker build -t ${IMAGE} --build-arg UID=$(id -u) --build-arg GID=$(id -g) -f "${join(repoRoot, "docker", "agent.Dockerfile")}" "${join(repoRoot, "docker")}"`;

/** Base allowlist: AI services, sign-in pages, GitHub and package registries (like sbx's "balanced"). Agents ask for anything else. */
export const BASE_ALLOW = [
  "anthropic.com", "*.anthropic.com", "claude.ai", "*.claude.ai", "claude.com", "*.claude.com",
  "openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com",
  "*.googleapis.com", "accounts.google.com", "*.google.com", "*.gstatic.com",
  "api.deepseek.com", "opencode.ai", "*.opencode.ai", "models.dev",
  "github.com", "*.github.com", "*.githubusercontent.com", "*.githubcopilot.com",
  "registry.npmjs.org", "*.npmjs.org", "pypi.org", "files.pythonhosted.org",
];

/** "example.com", "*.example.com" or "host:port" rules; a bare domain allows ports 80/443. */
export function hostAllowed(rules: string[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return rules.some((raw) => {
    const r = raw.toLowerCase();
    const [pat, p] = r.split(":");
    if (p ? Number(p) !== port : port !== 443 && port !== 80) return false;
    return pat.startsWith("*.") ? h.endsWith(pat.slice(1)) : h === pat;
  });
}

/**
 * Each container agent keeps one fixed IP on hq-agents (172.30.0.10–250), so a security engagement's
 * firewall rules can name exactly which agent may reach which target. Saved in ~/.hq/container-ips.json.
 */
export function agentIp(containerName: string): string {
  const file = join(homedir(), BRAND.homeDir, "container-ips.json");
  let map: Record<string, string> = {};
  try {
    if (existsSync(file)) map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    map = {};
  }
  if (map[containerName]) return map[containerName];
  const used = new Set(Object.values(map));
  for (let n = 10; n <= 250; n++) {
    const ip = `172.30.0.${n}`;
    if (used.has(ip)) continue;
    map[containerName] = ip;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, file);
    return ip;
  }
  throw new Error("No free container IPs left on hq-agents (240 agents). Remove old entries from ~/.hq/container-ips.json.");
}

/** `docker run` arguments for an agent (run in tmux like the other modes; --rm: state lives in the folder and login volume). */
export function runArgs(
  agent: AgentConfig, name: string, dir: string, cliArgs: string[], envFile: string | null, hqPort: number, env: Record<string, string> = {},
  secrets: { envFile: string; mounts: [string, string][] } | null = null,
): string[] {
  const authDir = AUTH_DIR[agent.cli];
  if (!authDir) throw new Error(`${agent.cli} can't run in Container mode yet. Use Sandbox or Local mode for this agent.`);
  const proxy = `http://${GATEWAY}:${egressPort(hqPort)}`;
  const { cpus, memoryGb } = agent.sandbox.resources;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return [
    "run", "-it", "--rm", "--init", "--name", name, "--hostname", agent.id,
    "--network", NETWORK, "--ip", agentIp(name),
    "--user", `${uid}:${gid}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "1024",
    ...(cpus ? ["--cpus", String(cpus)] : []),
    ...(memoryGb ? ["--memory", `${Math.round(memoryGb * 1024)}m`] : []),
    "-v", `${dir}:${WORKDIR}`,
    "-v", `${authVolume(agent.cli, agent.account || "default")}:${authDir}`,
    "-w", WORKDIR,
    ...(envFile ? ["--env-file", envFile] : []),
    // Account secrets: read by docker at start (the file is deleted right after), files mounted read-only.
    ...(secrets ? ["--env-file", secrets.envFile, ...secrets.mounts.flatMap(([host, inside]) => ["-v", `${host}:${inside}:ro`])] : []),
    ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].flatMap((k) => ["-e", `${k}=${proxy}`]),
    "-e", `NO_PROXY=${GATEWAY}`, "-e", `no_proxy=${GATEWAY}`, "-e", "TE_DISABLE=1",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    IMAGE,
    agent.cli,
    ...cliArgs,
  ];
}

/** One-time sign-in for a CLI: its normal login flow in a throwaway container that saves into the shared volume. */
const LOGIN_PREFIX = "hq-login-";

export function loginCommand(cli: AgentCli, hqPort: number, account = "default"): string {
  const authDir = AUTH_DIR[cli];
  if (!authDir) return "";
  const proxy = `http://${GATEWAY}:${egressPort(hqPort)}`;
  const env = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map((k) => `-e ${k}=${proxy}`).join(" ");
  const login: Record<string, string> = { claude: "claude", codex: "codex login --device-auth", gemini: "gemini", copilot: "copilot", opencode: "opencode auth login" };
  const tag = account === "default" ? cli : `${cli}-${account}`;
  return `docker run -it --rm --name ${LOGIN_PREFIX}${tag} --network ${NETWORK} --user $(id -u):$(id -g) ${env} -v ${authVolume(cli, account)}:${authDir} ${IMAGE} ${login[cli]}`;
}

export async function ensureNetwork(): Promise<boolean> {
  if ((await run("docker", ["network", "inspect", NETWORK], { timeoutMs: 8000 })).ok) return true;
  const r = await run("docker", [
    "network", "create", "--driver", "bridge", "--subnet", SUBNET, "--gateway", GATEWAY,
    "-o", `com.docker.network.bridge.name=${BRIDGE}`, "-o", "com.docker.network.bridge.enable_icc=false", NETWORK,
  ], { timeoutMs: 15_000 });
  if (!r.ok) log.warn(`couldn't create the ${NETWORK} Docker network: ${r.stderr.trim()}`);
  return r.ok;
}

// ---------------------------------------------------------------- egress proxy

/** Container IP → name on hq-agents, from `docker network inspect`; containers are named hq-<slug>-<agent>. */
async function ipNames(): Promise<Map<string, string>> {
  const r = await run("docker", ["network", "inspect", NETWORK, "--format", "{{range $id, $c := .Containers}}{{$c.Name}} {{$c.IPv4Address}}\n{{end}}"], { timeoutMs: 5000 });
  const map = new Map<string, string>();
  if (!r.ok) return map;
  for (const line of r.stdout.split("\n")) {
    const [name, cidr] = line.trim().split(" ");
    if (name && cidr) map.set(cidr.split("/")[0], name);
  }
  return map;
}

function agentForName(projects: Map<string, Runtime>, name: string): { rt: Runtime; agent: AgentConfig } | null {
  for (const rt of projects.values()) {
    const prefix = `hq-${rt.slug}-`;
    if (!name.startsWith(prefix)) continue;
    const agent = rt.hub.cfg(name.slice(prefix.length));
    if (agent?.mode === "container") return { rt, agent };
  }
  return null;
}

/**
 * HTTP proxy on the bridge gateway: CONNECT (https) and plain http, allowed per agent by BASE_ALLOW + the
 * agent's allow list, minus its deny list. A blocked domain becomes an access request (Allow/Deny in HQ).
 */
export function startEgressProxy(projects: Map<string, Runtime>, hqPort: number): Server {
  const asked = new Set<string>(); // one access request per agent+domain per HQ run
  // IPs are reused as soon as a container is removed, so the map is at most 1 s old (one lookup shared by
  // concurrent connections): a new container must never inherit the previous one's allow list.
  let snapshot: { at: number; map: Promise<Map<string, string>> } | null = null;
  const identify = async (ip: string) => {
    if (!snapshot || Date.now() - snapshot.at > 1000) snapshot = { at: Date.now(), map: ipNames() };
    return (await snapshot.map).get(ip) ?? null;
  };
  const decide = async (req: IncomingMessage, host: string, port: number) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const name = await identify(ip);
    // A sign-in container (loginCommand) only needs the CLIs' own sites.
    if (name?.startsWith(LOGIN_PREFIX)) return hostAllowed(BASE_ALLOW, host, port) ? { ok: true, why: "" } : { ok: false, why: "sign-in container" };
    const who = name ? agentForName(projects, name) : null;
    if (!who) return { ok: false, why: "unknown container" };
    const agent = who.rt.hub.cfg(who.agent.id) ?? who.agent; // live config: allow/deny change at runtime
    if (hostAllowed(agent.sandbox.deny, host, port)) return { ok: false, why: "denied" };
    // Security engagement: in scope is allowed on any port; explicitly out of scope is never allowed.
    const project = who.rt.hub.snap.config.project;
    if (project.type === "security" && project.scope) {
      const s = checkScope(project.scope, `${host}:${port}`);
      if (s.ok) return { ok: true, why: "" };
      if (s.why.includes("explicitly")) return { ok: false, why: s.why };
    }
    if (hostAllowed([...BASE_ALLOW, ...agent.sandbox.allow], host, port)) return { ok: true, why: "" };
    const key = `${who.rt.slug}/${agent.id}/${host}`;
    if (!asked.has(key)) {
      asked.add(key);
      try {
        requestAccess(who.rt.hub, agent.id, host, "Blocked by the container proxy (the agent tried to reach it).");
      } catch {
        /* not a domain (e.g. an IP): just blocked */
      }
    }
    return { ok: false, why: `Approval required for ${host}` };
  };

  const server = createServer(async (req, res) => {
    req.on("error", () => res.destroy());
    // Plain http through the proxy: the request line has the absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("proxy: absolute URL required");
      return;
    }
    const port = Number(url.port || 80);
    const d = await decide(req, url.hostname, port);
    if (!d.ok) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end(`.hq proxy: ${d.why}. Ask with request_access.`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const up = httpRequest({ host: url.hostname, port, path: `${url.pathname}${url.search}`, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.headersSent ? res.end() : res.writeHead(502).end("proxy: upstream error"));
    req.pipe(up);
  });

  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    // Before any await: a socket reset with no listener would crash HQ.
    client.on("error", () => client.destroy());
    const [host, p] = (req.url ?? "").split(":");
    const port = Number(p || 443);
    const d = host ? await decide(req, host, port) : { ok: false, why: "bad request" };
    if (!d.ok) {
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n.hq proxy: ${d.why}. Ask with request_access.\n`);
      return;
    }
    const upstream = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => (upstream.destroy(), client.destroy());
    upstream.on("error", close);
    client.on("error", close);
    client.on("close", () => upstream.destroy());
  });

  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("error", (err) => log.warn(`egress proxy: ${err.message}`));
  server.listen(egressPort(hqPort), GATEWAY, () => log.info(`container proxy on ${GATEWAY}:${egressPort(hqPort)}`));
  return server;
}

/** Your git name and email, so commits made in a container are yours (the container has no git config). */
export async function gitIdentityEnv(cwd: string): Promise<Record<string, string>> {
  const get = async (key: string) => (await run("git", ["config", "--get", key], { cwd, timeoutMs: 5000 })).stdout.trim();
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  const env: Record<string, string> = {};
  if (name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name;
  if (email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email;
  return env;
}
