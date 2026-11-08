// Container mode: agents in plain Docker containers (for a VM without nested virtualization).
//  - Network: containers sit on `hq-agents` (172.30.0.0/24, bridge br-hq, no container-to-container traffic).
//    They reach HQ at the bridge gateway 172.30.0.1, where HQ also listens.
//  - Internet: only through HQ's allowlist proxy on the gateway (EGRESS_PORT). A host firewall rule makes that
//    mandatory (setup check "egress-lock"); HQ never runs sudo, so it shows the command.
//  - Sign-in: one Docker volume per CLI (hq-auth-<cli>), shared by that CLI's containers; you sign in once.

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCli, AgentConfig } from "../src/data/types";
import { requestAccess } from "./access";
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
export const authVolume = (cli: AgentCli) => `hq-auth-${cli}`;

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

/** `docker run` arguments for an agent (run in tmux like the other modes; --rm: state lives in the folder and login volume). */
export function runArgs(agent: AgentConfig, name: string, dir: string, cliArgs: string[], envFile: string | null, hqPort: number): string[] {
  const authDir = AUTH_DIR[agent.cli];
  if (!authDir) throw new Error(`${agent.cli} can't run in Container mode yet. Use Sandbox or Local mode for this agent.`);
  const proxy = `http://${GATEWAY}:${egressPort(hqPort)}`;
  const { cpus, memoryGb } = agent.sandbox.resources;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return [
    "run", "-it", "--rm", "--init", "--name", name, "--hostname", agent.id,
    "--network", NETWORK,
    "--user", `${uid}:${gid}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "1024",
    ...(cpus ? ["--cpus", String(cpus)] : []),
    ...(memoryGb ? ["--memory", `${Math.round(memoryGb * 1024)}m`] : []),
    "-v", `${dir}:${WORKDIR}`,
    "-v", `${authVolume(agent.cli)}:${authDir}`,
    "-w", WORKDIR,
    ...(envFile ? ["--env-file", envFile] : []),
    ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].flatMap((k) => ["-e", `${k}=${proxy}`]),
    "-e", `NO_PROXY=${GATEWAY}`, "-e", `no_proxy=${GATEWAY}`,
    IMAGE,
    agent.cli,
    ...cliArgs,
  ];
}

/** One-time sign-in for a CLI: its normal login flow in a throwaway container that saves into the shared volume. */
export function loginCommand(cli: AgentCli, hqPort: number): string {
  const authDir = AUTH_DIR[cli];
  if (!authDir) return "";
  const proxy = `http://${GATEWAY}:${egressPort(hqPort)}`;
  const env = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map((k) => `-e ${k}=${proxy}`).join(" ");
  const login: Record<string, string> = { claude: "claude", codex: "codex login --device-auth", gemini: "gemini", copilot: "copilot", opencode: "opencode auth login" };
  return `docker run -it --rm --network ${NETWORK} --user $(id -u):$(id -g) ${env} -v ${authVolume(cli)}:${authDir} ${IMAGE} ${login[cli]}`;
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

/** Container IP → (project, agent), from `docker inspect`; containers are named hq-<slug>-<agent>. */
async function whoIsIp(projects: Map<string, Runtime>, ip: string): Promise<{ rt: Runtime; agent: AgentConfig } | null> {
  const r = await run("docker", ["network", "inspect", NETWORK, "--format", "{{range $id, $c := .Containers}}{{$c.Name}} {{$c.IPv4Address}}\n{{end}}"], { timeoutMs: 5000 });
  if (!r.ok) return null;
  for (const line of r.stdout.split("\n")) {
    const [name, cidr] = line.trim().split(" ");
    if (!name || cidr?.split("/")[0] !== ip) continue;
    for (const rt of projects.values()) {
      const prefix = `hq-${rt.slug}-`;
      if (!name.startsWith(prefix)) continue;
      const agent = rt.hub.cfg(name.slice(prefix.length));
      if (agent?.mode === "container") return { rt, agent };
    }
  }
  return null;
}

/**
 * HTTP proxy on the bridge gateway: CONNECT (https) and plain http, allowed per agent by BASE_ALLOW + the
 * agent's allow list, minus its deny list. A blocked domain becomes an access request (Allow/Deny in HQ).
 */
export function startEgressProxy(projects: Map<string, Runtime>, hqPort: number): Server {
  const cache = new Map<string, { at: number; who: { rt: Runtime; agent: AgentConfig } | null }>();
  const asked = new Set<string>(); // one access request per agent+domain per HQ run
  const identify = async (ip: string) => {
    const hit = cache.get(ip);
    if (hit && Date.now() - hit.at < 30_000) return hit.who;
    const who = await whoIsIp(projects, ip);
    cache.set(ip, { at: Date.now(), who });
    return who;
  };
  const decide = async (req: IncomingMessage, host: string, port: number) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const who = await identify(ip);
    if (!who) return { ok: false, why: "unknown container" };
    const agent = who.rt.hub.cfg(who.agent.id) ?? who.agent; // live config: allow/deny change at runtime
    if (hostAllowed(agent.sandbox.deny, host, port)) return { ok: false, why: "denied" };
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
  });

  server.on("error", (err) => log.warn(`egress proxy: ${err.message}`));
  server.listen(egressPort(hqPort), GATEWAY, () => log.info(`container proxy on ${GATEWAY}:${egressPort(hqPort)}`));
  return server;
}
