// The setup checklist: what this machine has, and how to fix what's missing.

import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { lookup } from "node:dns/promises";
import type { AgentConfig, ProjectConfig, SetupCheck, SetupFix, SetupState } from "../src/data/types";
import { firewallCommands, scopeDomains, scopeNetworks } from "./scope";
import { usesTmux } from "./backends";
import { parseCliJson, sandboxList } from "./lib/json";
import { has, run } from "./lib/exec";
import type { RepoInfo } from "./repo";
import { agentIp, authVolume, BRIDGE, buildCommand, EGRESS_LOCK_CMD, ensureNetwork, GATEWAY, hostFirewallCmd, IMAGE, loginCommand, NETWORK } from "./containers";

const SBX_DOCS = "https://docs.docker.com/ai/sandboxes/install/";
const os = platform();

type Check = Omit<SetupCheck, "fix"> & { fix: SetupFix | null };

const fix = (command: string, runnable: boolean, docs: string | null): SetupFix => ({ command, runnable, docs });

async function checkOs(): Promise<Check> {
  const base = { id: "os" as const, label: "Machine supports sandboxes", neededFor: "sandbox" as const, fix: fix("", false, SBX_DOCS) };
  if (os === "darwin") {
    const v = (await run("sw_vers", ["-productVersion"])).stdout.trim();
    const major = Number(v.split(".")[0]);
    if (arch() !== "arm64") return { ...base, status: "unsupported", detail: `macOS ${v} on Intel. Sandboxes need Apple silicon — use Local mode.` };
    if (major < 14) return { ...base, status: "unsupported", detail: `macOS ${v}. Sandboxes need macOS 14 (Sonoma) or later.` };
    return { ...base, status: "ok", detail: `macOS ${v} · Apple silicon`, fix: null };
  }
  if (os === "win32") {
    const build = Number(release().split(".")[2] ?? 0);
    return build >= 22000
      ? { ...base, status: "ok", detail: "Windows 11 (needs Windows Hypervisor Platform enabled)", fix: null }
      : { ...base, status: "unsupported", detail: "Windows 10. Sandboxes need Windows 11 — use Local mode." };
  }
  const osRelease = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
  const id = osRelease.match(/^ID=(.*)$/m)?.[1]?.replace(/"/g, "");
  const ver = Number(osRelease.match(/^VERSION_ID="?([\d.]+)/m)?.[1] ?? 0);
  if (id === "ubuntu" && ver >= 24.04) return { ...base, status: "ok", detail: `Ubuntu ${ver} (needs KVM)`, fix: null };
  return { ...base, status: "warning", detail: `${id ?? "Linux"} ${ver || ""} — Docker documents Ubuntu 24.04+ with KVM.` };
}

async function checkSbx(brew: boolean): Promise<Check> {
  const base = { id: "sbx" as const, label: "Docker Sandboxes (sbx)", neededFor: "sandbox" as const };
  const v = await run("sbx", ["version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim().split(/\s+/)[2] ?? v.stdout.trim(), fix: null };
  const cmd =
    os === "darwin" ? "brew trust docker/tap && brew install docker/tap/sbx"
    : os === "win32" ? "winget install -h Docker.sbx"
    : "curl -fsSL https://get.docker.com | sudo SBX=1 sh";
  const runnable = os === "darwin" ? brew : os === "win32";
  return { ...base, status: "missing", detail: "Not installed.", fix: fix(cmd, runnable, SBX_DOCS) };
}

/** sbx's error when its base network policy was never chosen (fresh install). */
export const POLICY_NOT_INITIALIZED = /not been initialized|sbx policy init/i;

/**
 * `sbx policy check network <host>`: "allowed", "denied", or null when sbx gave no verdict.
 * Newer sbx (0.50+) may print the verdict on stderr and add terminal escape codes, so both
 * streams are read with the codes removed.
 */
export async function policyVerdict(host: string): Promise<{ verdict: "allowed" | "denied" | null; out: string }> {
  const r = await run("sbx", ["policy", "check", "network", host], { timeoutMs: 10_000 });
  // eslint-disable-next-line no-control-regex
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b(\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-_])/g, "");
  const m = out.match(/\b(Allowed|Denied):/);
  return { verdict: m ? (m[1] === "Allowed" ? "allowed" : "denied") : null, out };
}

/**
 * A fresh sbx needs a base network policy (`sbx policy init`) before any rule
 * can be added or a sandbox started. HQ suggests one but never picks it.
 */
async function checkSbxPolicy(loginOk: boolean): Promise<Check> {
  const base = { id: "sbx-policy" as const, label: "Sandbox network policy", neededFor: "sandbox" as const };
  if (!loginOk) return { ...base, status: "missing", detail: "Waiting for Docker sign-in.", fix: null };
  const { verdict, out } = await policyVerdict("registry.npmjs.org");
  if (POLICY_NOT_INITIALIZED.test(out))
    return {
      ...base,
      status: "missing",
      detail:
        "Not set yet. Choose what sandboxes can reach once: balanced (recommended: AI services, package registries, GitHub), allow-all, or deny-all. Change it later with sbx policy reset.",
      fix: fix("sbx policy init balanced", true, SBX_DOCS),
    };
  if (!verdict) return { ...base, status: "warning", detail: out.trim().split("\n")[0] || "sbx did not respond.", fix: fix("sbx diagnose", true, SBX_DOCS) };
  const open = (await policyVerdict("hq-probe.invalid")).verdict === "allowed";
  const name = open ? "Allow all" : verdict === "allowed" ? "Balanced" : "Deny all";
  return { ...base, status: "ok", detail: `${name}. HQ adds only the rule that lets sandboxes reach it.`, fix: null };
}

async function checkSbxLogin(sbxOk: boolean): Promise<Check> {
  const base = { id: "sbx-login" as const, label: "Signed in to Docker", neededFor: "sandbox" as const };
  if (!sbxOk) return { ...base, status: "missing", detail: "Waiting for sbx.", fix: null };
  const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
  const list = r.ok ? sandboxList<unknown>(r.stdout) : null;
  // The command worked, so you're signed in; an unreadable list only loses the count (never block Start on it).
  if (r.ok) {
    const n = list?.length;
    return { ...base, status: "ok", detail: n === undefined ? "Signed in" : `Signed in · ${n} sandbox${n === 1 ? "" : "es"} on this machine`, fix: null };
  }
  const msg = (r.stderr || r.stdout).trim();
  const loggedOut = /log ?in|sign ?in|unauthori[sz]ed|not authenticated/i.test(msg);
  return {
    ...base,
    status: loggedOut ? "missing" : "warning",
    detail: loggedOut ? "Not signed in. Sign-in opens your browser." : msg.split("\n")[0] || "sbx did not respond.",
    fix: fix(loggedOut ? "sbx login" : "sbx diagnose", true, SBX_DOCS),
  };
}

async function checkTmux(brew: boolean): Promise<Check> {
  const base = { id: "tmux" as const, label: "tmux (keeps agents running if HQ closes)", neededFor: "all" as const };
  if (!usesTmux())
    return { ...base, label: "Agent sessions", status: "ok", detail: "HQ runs agents itself on Windows (no tmux needed). They stop when HQ stops; sandboxes and folders are kept.", fix: null };
  const v = await run("tmux", ["-V"], { timeoutMs: 5000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  if (os === "win32") return { ...base, status: "unsupported", detail: "tmux needs WSL on Windows. Run HQ inside WSL.", fix: fix("wsl --install", false, "https://learn.microsoft.com/windows/wsl/install") };
  return {
    ...base,
    status: "missing",
    detail: "Not installed.",
    fix: os === "darwin" ? fix("brew install tmux", brew, "https://github.com/tmux/tmux/wiki/Installing") : fix("sudo apt install tmux", false, "https://github.com/tmux/tmux/wiki/Installing"),
  };
}

async function checkClaude(): Promise<Check> {
  const base = { id: "claude" as const, label: "Claude Code (for Local mode)", neededFor: "local" as const };
  const v = await run("claude", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not installed. Only needed for Claude Code agents in Local mode.",
    fix: fix(os === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash", false, "https://docs.claude.com/en/docs/claude-code/setup"),
  };
}

async function checkAgy(): Promise<Check> {
  const base = { id: "agy" as const, label: "Antigravity CLI (agy)", neededFor: "local" as const };
  const v = await run("agy", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim().split("\n")[0] || "Installed", fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not found on PATH. Install the Antigravity CLI, then sign in once in its runtime.",
    fix: fix("curl -fsSL https://antigravity.google/cli/install.sh | bash", false, "https://antigravity.google/docs/getting-started/"),
  };
}

async function checkOpenCode(): Promise<Check> {
  const base = { id: "opencode" as const, label: "OpenCode CLI (opencode)", neededFor: "local" as const };
  const v = await run("opencode", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim().split("\n")[0] || "Installed", fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not installed. Needed for OpenCode agents in Local mode.",
    fix: fix("npm install -g opencode-ai", true, "https://opencode.ai/docs"),
  };
}

async function checkGemini(): Promise<Check> {
  const base = { id: "gemini" as const, label: "Gemini CLI (gemini)", neededFor: "local" as const };
  const v = await run("gemini", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim().split("\n")[0] || "Installed", fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not installed. Needed for Gemini CLI agents in Local mode.",
    fix: fix("npm install -g @google/gemini-cli", true, "https://github.com/google-gemini/gemini-cli"),
  };
}

async function checkCopilot(): Promise<Check> {
  const base = { id: "copilot" as const, label: "GitHub Copilot CLI (copilot)", neededFor: "local" as const };
  const v = await run("copilot", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim().split("\n")[0] || "Installed", fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not installed. Needed for Copilot CLI agents in Local mode.",
    fix: fix("npm install -g @github/copilot", true, "https://docs.github.com/en/copilot"),
  };
}

async function checkGh(brew: boolean): Promise<Check> {
  const base = { id: "gh" as const, label: "GitHub CLI (reads PRs and reviews)", neededFor: "github" as const };
  if (!(await has("gh")))
    return {
      ...base,
      status: "missing",
      detail: "Not installed.",
      fix: fix(os === "darwin" ? "brew install gh" : os === "win32" ? "winget install --id GitHub.cli" : "sudo apt install gh", os === "darwin" ? brew : os === "win32", "https://cli.github.com"),
    };
  const r = await run("gh", ["auth", "status"], { timeoutMs: 10_000 });
  const out = r.stdout + r.stderr;
  if (r.ok) return { ...base, status: "ok", detail: `Signed in as ${out.match(/account (\S+)/)?.[1] ?? "you"}`, fix: null };
  return { ...base, status: "missing", detail: "Not signed in.", fix: fix("gh auth login", true, "https://cli.github.com/manual/gh_auth_login") };
}

function checkRemote(repo: RepoInfo): Check {
  const base = { id: "gh-remote" as const, label: "GitHub remote", neededFor: "github" as const };
  if (repo.github) return { ...base, status: "ok", detail: repo.github, fix: null };
  return {
    ...base,
    status: "warning",
    detail: repo.originUrl ? `origin is ${repo.originUrl} (not GitHub)` : "No origin remote. Switch Workflow to Deliverables mode for non-GitHub projects, or add a remote.",
    fix: fix("gh repo create --source . --private --push", false, "https://cli.github.com/manual/gh_repo_create"),
  };
}

async function checkGithubSecret(sbxOk: boolean): Promise<Check> {
  const base = { id: "github-secret" as const, label: "GitHub access inside sandboxes", neededFor: "sandbox" as const };
  if (!sbxOk) return { ...base, status: "missing", detail: "Waiting for sbx.", fix: null };
  const r = await run("sbx", ["secret", "ls"], { timeoutMs: 10_000 });
  if (r.ok && /\bgithub\b/.test(r.stdout)) return { ...base, status: "ok", detail: "Stored in Docker's secret store; injected by the proxy.", fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Agents can't push or open PRs until this is set.",
    fix: fix("sbx secret set github --command 'gh auth token'", true, "https://docs.docker.com/ai/sandboxes/get-started/"),
  };
}

async function checkCodex(): Promise<Check> {
  const base = { id: "codex" as const, label: "Codex (for Codex agents in Local mode)", neededFor: "local" as const };
  const v = await run("codex", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  return { ...base, status: "missing", detail: "Not installed. Only needed for Codex agents in Local mode (sandboxes have it).", fix: fix("npm install -g @openai/codex", false, "https://developers.openai.com/codex/cli") };
}

async function checkOpenAiSecret(sbxOk: boolean): Promise<Check> {
  const base = { id: "openai-secret" as const, label: "OpenAI sign-in for Codex agents", neededFor: "sandbox" as const };
  if (!sbxOk) return { ...base, status: "missing", detail: "Waiting for sbx.", fix: null };
  const r = await run("sbx", ["secret", "ls", "--json"], { timeoutMs: 10_000 });
  let has = false;
  try {
    has = (parseCliJson<{ secrets?: { name: string; scope: string }[] }>(r.stdout)?.secrets ?? []).some((s) => s.name === "openai" && s.scope === "global");
  } catch {
    /* sbx down */
  }
  if (has) return { ...base, status: "ok", detail: "Stored in Docker's secret store.", fix: null };
  return { ...base, status: "missing", detail: "Codex agents can't sign in until this is set. Opens your browser to sign in with ChatGPT.", fix: fix("sbx secret set openai --oauth", true, "https://docs.docker.com/ai/sandboxes/") };
}

// ---------------------------------------------------------------- Container mode

async function checkDocker(): Promise<Check> {
  const base = { id: "docker" as const, label: "Docker (for Container mode)", neededFor: "container" as const };
  const r = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000 });
  if (r.ok) return { ...base, status: "ok", detail: `Docker ${r.stdout.trim()}`, fix: null };
  return { ...base, status: "missing", detail: "Docker isn't installed, isn't running, or your user isn't in the docker group.", fix: fix("curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER", false, "https://docs.docker.com/engine/install/") };
}

async function checkAgentImage(dockerOk: boolean): Promise<Check> {
  const base = { id: "agent-image" as const, label: `Agent image (${IMAGE})`, neededFor: "container" as const };
  if (!dockerOk) return { ...base, status: "missing", detail: "Waiting for Docker.", fix: null };
  const r = await run("docker", ["image", "inspect", IMAGE, "--format", "{{.Created}}"], { timeoutMs: 8000 });
  if (r.ok) return { ...base, status: "ok", detail: `Built ${r.stdout.trim().slice(0, 10)}. Rebuild to update the CLIs.`, fix: fix(buildCommand(), true, null) };
  return { ...base, status: "missing", detail: "Not built yet. Takes a few minutes the first time (Node, git, gh and the agent CLIs).", fix: fix(buildCommand(), true, null) };
}

/** A container on hq-agents tries to reach the internet without the proxy; it must fail. */
async function checkEgressLock(imageOk: boolean): Promise<Check> {
  const base = { id: "egress-lock" as const, label: "Containers can only go through HQ's proxy", neededFor: "container" as const };
  if (!imageOk || !(await ensureNetwork())) return { ...base, status: "missing", detail: "Waiting for Docker and the agent image.", fix: null };
  const r = await run("docker", ["run", "--rm", "--network", NETWORK, IMAGE, "curl", "-s", "-o", "/dev/null", "-m", "4", "https://1.1.1.1"], { timeoutMs: 20_000 });
  if (!r.ok) return { ...base, status: "ok", detail: "Direct internet access is blocked; sites go through the allowlist.", fix: null };
  return {
    ...base,
    status: "warning",
    detail: "Containers can skip the proxy and reach any site. Add this firewall rule once (and make it persist, e.g. with iptables-persistent).",
    fix: fix(EGRESS_LOCK_CMD, false, null),
  };
}

/** A container reaches HQ on the gateway (hooks, Team MCP, proxy). Before HQ listens (first check at startup) it can't pass; HQ re-checks once it's up. */
async function checkHqReach(imageOk: boolean, hqPort: number): Promise<Check> {
  const base = { id: "hq-reach" as const, label: "Containers can reach HQ", neededFor: "container" as const };
  if (!imageOk) return { ...base, status: "missing", detail: "Waiting for the agent image.", fix: null };
  const r = await run("docker", ["run", "--rm", "--network", NETWORK, IMAGE, "curl", "-sf", "-m", "4", `http://${GATEWAY}:${hqPort}/api/health`], { timeoutMs: 20_000 });
  if (r.ok) return { ...base, status: "ok", detail: `HQ answers at ${GATEWAY}:${hqPort}.`, fix: null };
  return {
    ...base,
    status: "missing",
    detail: "A container can't reach HQ: usually the host firewall (ufw drops incoming traffic by default). Allow the container network to reach HQ and its proxy:",
    fix: fix(hostFirewallCmd(hqPort), false, null),
  };
}

/**
 * Security engagement in Container mode: raw tools (nmap, nuclei…) don't go through the proxy, so the host
 * firewall must let each agent's fixed IP reach the in-scope networks. HQ can't read iptables without root,
 * so this stays a reminder with the exact commands (re-run them after changing the scope or the team).
 */
async function checkScopeFirewall(project: ProjectConfig, team: AgentConfig[]): Promise<Check | null> {
  if (project.type !== "security") return null;
  const agents = team.filter((a) => a.mode === "container");
  if (!agents.length) return null;
  const base = { id: "scope-firewall" as const, label: "Engagement targets reachable by raw tools", neededFor: "container" as const };
  const resolved = await Promise.all(
    scopeDomains(project.scope)
      .filter((d) => !d.startsWith("*."))
      .map((d) => lookup(d, { all: true, family: 4 }).then((r) => r.map((x) => x.address)).catch(() => [] as string[])),
  );
  const targets = [...new Set([...scopeNetworks(project.scope), ...resolved.flat()])];
  if (!targets.length)
    return { ...base, status: "warning", detail: "No in-scope IPs yet (wildcard domains can't be resolved ahead). Web traffic to in-scope domains goes through the proxy; add IPs or ranges for scanners.", fix: null };
  const ips = agents.map((a) => agentIp(`hq-${project.id}-${a.id}`));
  const cmds = firewallCommands(project.id, ips, targets, BRIDGE);
  return {
    ...base,
    status: "warning",
    detail: `Run once after changing the scope or the team: lets ${agents.map((a) => a.name).join(", ")} reach ${targets.length} in-scope address${targets.length === 1 ? "" : "es"} directly (scanners). Domains were resolved now; re-run if their IPs change.`,
    fix: fix(cmds.join(" && \\\n"), false, null),
  };
}

/** Whether a container sign-in is saved for this CLI and account (any file in its volume). */
export async function containerLoginSaved(cli: AgentConfig["cli"], account = "default"): Promise<boolean> {
  const r = await run("docker", ["run", "--rm", "-v", `${authVolume(cli, account)}:/v`, "--entrypoint", "sh", IMAGE, "-c", "ls -A /v | head -1"], { timeoutMs: 20_000 });
  return r.ok && !!r.stdout.trim();
}

/** Whether the CLI's shared login volume has a sign-in (any file in it). */
async function checkContainerLogin(cli: AgentConfig["cli"], imageOk: boolean, hqPort: number): Promise<Check> {
  const base = { id: `login-${cli}` as const, label: `${cli} sign-in for containers`, neededFor: "container" as const };
  const cmd = loginCommand(cli, hqPort);
  if (!cmd) return { ...base, status: "unsupported", detail: `${cli} can't run in Container mode yet.`, fix: null };
  if (!imageOk) return { ...base, status: "missing", detail: "Waiting for the agent image.", fix: null };
  const r = await run("docker", ["run", "--rm", "-v", `${authVolume(cli)}:/v`, "--entrypoint", "sh", IMAGE, "-c", "ls -A /v | head -1"], { timeoutMs: 20_000 });
  if (r.ok && r.stdout.trim()) return { ...base, status: "ok", detail: `Saved in the ${authVolume(cli)} volume, shared by every ${cli} container.`, fix: fix(cmd, true, null) };
  return { ...base, status: "missing", detail: "Sign in once; every container of this CLI reuses it. Opens the CLI's own login (a link and code you can use on any device).", fix: fix(cmd, true, null) };
}

/** `team` adds CLI-specific checks for any CLI used by the team. */
export async function runSetupChecks(repo: RepoInfo, team: AgentConfig[] = [], hqPort = 7420, project?: ProjectConfig): Promise<SetupState> {
  const brew = os === "darwin" && (await has("brew"));
  const [osCheck, sbx, tmux, claude, gh] = await Promise.all([checkOs(), checkSbx(brew), checkTmux(brew), checkClaude(), checkGh(brew)]);
  const sbxOk = sbx.status === "ok";
  const [login, secret] = await Promise.all([checkSbxLogin(sbxOk), checkGithubSecret(sbxOk)]);
  const policy = await checkSbxPolicy(login.status === "ok");
  const checks: SetupCheck[] = [osCheck, sbx, login, policy, secret, tmux, claude, gh, checkRemote(repo)];

  const hasCli = (c: AgentConfig["cli"], mode?: AgentConfig["mode"]) =>
    team.some((a) => a.cli === c && (!mode || a.mode === mode));

  if (hasCli("codex", "sandbox")) checks.splice(5, 0, await checkOpenAiSecret(sbxOk));
  if (hasCli("codex", "local")) checks.push(await checkCodex());
  if (hasCli("agy")) checks.push(await checkAgy());
  if (hasCli("opencode", "local")) checks.push(await checkOpenCode());
  if (hasCli("gemini", "local")) checks.push(await checkGemini());
  if (hasCli("copilot", "local")) checks.push(await checkCopilot());

  const containerClis = [...new Set(team.filter((a) => a.mode === "container").map((a) => a.cli))];
  let containerReady = false;
  if (containerClis.length) {
    const docker = await checkDocker();
    const image = await checkAgentImage(docker.status === "ok");
    const imageOk = image.status === "ok";
    const lock = await checkEgressLock(imageOk);
    const reach = await checkHqReach(imageOk, hqPort);
    const logins = await Promise.all(containerClis.map((c) => checkContainerLogin(c, imageOk, hqPort)));
    checks.push(docker, image, lock, reach, ...logins);
    const scopeFw = project ? await checkScopeFirewall(project, team) : null;
    if (scopeFw) checks.push(scopeFw);
    containerReady = docker.status === "ok" && imageOk && lock.status !== "missing" && reach.status === "ok" && tmux.status === "ok";
  }

  const ok = (c: SetupCheck) => c.status === "ok";
  const localClis = checks.filter((c) => c.neededFor === "local");
  return {
    machine: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), persistentAgents: usesTmux() },
    checks,
    sandboxReady: osCheck.status !== "unsupported" && ok(sbx) && ok(login) && ok(policy) && ok(tmux),
    localReady: ok(tmux) && (localClis.some(ok) || ok(claude)),
    containerReady,
    checkedAt: new Date().toISOString(),
  };
}
