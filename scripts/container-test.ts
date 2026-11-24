// Container mode: allowlist rules, docker run flags, and (when Docker and the arimaops-agent image exist)
// a real container going through HQ's egress proxy. Run: npx tsx scripts/container-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = process.env.USERPROFILE = mkdtempSync(join(tmpdir(), "hq-ctr-"));
const { hostAllowed, loginCommand, runArgs, ensureNetwork, startEgressProxy, hostFirewallCmd, IMAGE, NETWORK, GATEWAY, egressPort, BASE_ALLOW } = await import("../server/containers");
const { run } = await import("../server/lib/exec");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

// ---------------------------------------------------------------- rules
check("exact domain on 443", hostAllowed(["docs.example.com"], "docs.example.com", 443));
check("exact domain not on 22", !hostAllowed(["docs.example.com"], "docs.example.com", 22));
check("wildcard matches subdomain", hostAllowed(["*.example.com"], "a.b.example.com", 443));
check("wildcard doesn't match lookalike", !hostAllowed(["*.example.com"], "evilexample.com", 443));
check("host:port rule", hostAllowed(["db.example.com:5432"], "db.example.com", 5432) && !hostAllowed(["db.example.com:5432"], "db.example.com", 443));
check("base list has the AI APIs", hostAllowed(BASE_ALLOW, "api.anthropic.com", 443) && hostAllowed(BASE_ALLOW, "api.openai.com", 443));
check("base list blocks random sites", !hostAllowed(BASE_ALLOW, "example.org", 443));

// ---------------------------------------------------------------- docker run flags
const agent = { id: "dwight", cli: "claude", mode: "container", sandbox: { resources: { cpus: 2, memoryGb: 4 }, allow: ["example.com"], deny: [] } };
const args = runArgs(agent as never, "hq-t-dwight", "/tmp/w", ["--model", "opus"], null, 7420);
const has = (...xs: string[]) => xs.every((x, i) => args[args.indexOf(xs[0]) + i] === x);
check("no capabilities, no privilege escalation", has("--cap-drop", "ALL") && has("--security-opt", "no-new-privileges"));
check("on the agents network", has("--network", NETWORK));
check("resources applied", has("--cpus", "2") && has("--memory", "4096m"));
check("only its own CLI's login volume", args.includes("hq-auth-claude:/auth/claude") && !args.some((a) => a.startsWith("hq-auth-codex")));
check("proxy env set, HQ not proxied", args.includes(`HTTPS_PROXY=http://${GATEWAY}:${egressPort(7420)}`) && args.includes(`NO_PROXY=${GATEWAY}`));
const withGit = runArgs(agent as never, "hq-t-dwight", "/tmp/w", [], null, 7420, { GIT_AUTHOR_NAME: "Ada" });
check("extra env (git identity) passed before the image", withGit.indexOf("GIT_AUTHOR_NAME=Ada") > 0 && withGit.indexOf("GIT_AUTHOR_NAME=Ada") < withGit.indexOf(IMAGE));
check("sign-in container is named so the proxy lets it reach the CLI's sites", loginCommand("codex", 7420).includes("--name hq-login-codex"));
check("runs the CLI with its args", args.slice(-4).join(" ") === `${IMAGE} claude --model opus`);
const agyArgs = runArgs({ ...agent, cli: "agy" } as never, "x", "/tmp", [], null, 7420);
check("Antigravity has its own persistent auth volume", agyArgs.includes("hq-auth-agy:/home/agent/.gemini") && agyArgs.at(-1) === "agy");

const multiEnvArgs = runArgs(agent as never, "x", "/tmp", [], ["/p/project.env", "/p/dev.env"], 7420);
const pEnvIdx = multiEnvArgs.indexOf("/p/project.env");
const aEnvIdx = multiEnvArgs.indexOf("/p/dev.env");
check("multiple --env-file flags preserve project-then-agent order", pEnvIdx > 0 && aEnvIdx > pEnvIdx && multiEnvArgs[pEnvIdx - 1] === "--env-file" && multiEnvArgs[aEnvIdx - 1] === "--env-file");

// ---------------------------------------------------------------- app variables (envFiles) & tmux order
{
  const { setEnvVar, removeEnvVar, listEnvKeys, hasEnvKey, envFilesForAgent, projectEnvPath, agentEnvPath } = await import("../server/envFiles");
  const { shellCommand } = await import("../server/backends/tmux");
  const { readFileSync, statSync } = await import("node:fs");
  const pFile = projectEnvPath("envtest");
  const aFile = agentEnvPath("envtest", "dev");
  setEnvVar(pFile, "GH_TOKEN", "ghp_secret_1", "# project header");
  setEnvVar(pFile, "FOO", "bar");
  setEnvVar(pFile, "GH_TOKEN", "ghp_secret_2"); // update in place
  setEnvVar(aFile, "DATABASE_URL", "postgres://localhost/db");
  const content = readFileSync(pFile, "utf8");
  check("env file created with mode 0600", process.platform === "win32" || (statSync(pFile).mode & 0o777) === 0o600);
  check("env var updates in place without quotes and keeps comments", content.includes("# project header") && content.includes("GH_TOKEN=ghp_secret_2") && !content.includes("ghp_secret_1"));
  check("listEnvKeys returns sorted key names only", JSON.stringify(listEnvKeys(pFile)) === JSON.stringify(["FOO", "GH_TOKEN"]) && hasEnvKey(pFile, "GH_TOKEN"));
  let badKeyRejected = false;
  try {
    setEnvVar(pFile, "1BAD", "x");
  } catch {
    badKeyRejected = true;
  }
  let multilineRejected = false;
  try {
    setEnvVar(pFile, "GOOD", "line1\nline2");
  } catch {
    multilineRejected = true;
  }
  check("env var helper rejects invalid names and multiline values", badKeyRejected && multilineRejected);
  removeEnvVar(pFile, "FOO");
  check("removeEnvVar drops only the requested key", JSON.stringify(listEnvKeys(pFile)) === JSON.stringify(["GH_TOKEN"]));
  check("envFilesForAgent returns project.env then agent.env", JSON.stringify(envFilesForAgent("envtest", "dev")) === JSON.stringify([pFile, aFile]));
  const tmuxCmd = shellCommand({ file: "claude", args: [], envFile: null, envFiles: [pFile, aFile] });
  check("tmux shellCommand loads project.env before agent.env", tmuxCmd.includes(pFile) && tmuxCmd.indexOf(pFile) < tmuxCmd.indexOf(aFile));
}

// ---------------------------------------------------------------- live proxy
// ---------------------------------------------------------------- GitHub access for container agents
{
  const { checkContainerGithub } = await import("../server/setup");
  const { projectHome } = await import("../server/paths");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const team = [
    { id: "lead", name: "Cipher", mode: "container", isLead: true },
    { id: "dev", name: "Ghost", mode: "container" },
    { id: "rev", name: "Nyx", mode: "container" },
  ] as never;
  check("no GitHub remote: no check", checkContainerGithub({ github: null }, "ghtest", team) === null);
  const none = checkContainerGithub({ github: "me/blog" }, "ghtest", team);
  check("no token: a warning naming the agents, not the lead", none?.status === "warning" && /Ghost, Nyx/.test(none.detail) && !/Cipher/.test(none.detail), none?.detail);
  mkdirSync(projectHome("ghtest"), { recursive: true });
  writeFileSync(join(projectHome("ghtest"), "dev.env"), "FOO=1\nGH_TOKEN=github_pat_x\n");
  writeFileSync(join(projectHome("ghtest"), "rev.env"), "GH_TOKEN=\n");
  const some = checkContainerGithub({ github: "me/blog" }, "ghtest", team);
  check("an empty GH_TOKEN still counts as missing", some?.status === "warning" && /^Nyx can't/.test(some.detail), some?.detail);
  writeFileSync(join(projectHome("ghtest"), "rev.env"), "GH_TOKEN=github_pat_y\n");
  check("every agent has a token: ok", checkContainerGithub({ github: "me/blog" }, "ghtest", team)?.status === "ok");

  // Shared project.env satisfies all container agents without per-agent env files.
  mkdirSync(projectHome("ghshared"), { recursive: true });
  writeFileSync(join(projectHome("ghshared"), "project.env"), "GH_TOKEN=\n");
  check("empty GH_TOKEN in project.env still warns", checkContainerGithub({ github: "me/blog" }, "ghshared", team)?.status === "warning");
  writeFileSync(join(projectHome("ghshared"), "project.env"), "GH_TOKEN=github_pat_all\n");
  check("shared GH_TOKEN in project.env satisfies every container agent", checkContainerGithub({ github: "me/blog" }, "ghshared", team)?.status === "ok");
}

const docker = (await run("docker", ["image", "inspect", IMAGE], { timeoutMs: 8000 })).ok && (await ensureNetwork());
if (!docker) console.log("- skipped live proxy test (needs Docker and the arimaops-agent image)");
else {
  const requests: string[] = [];
  const cfg = { ...agent, mode: "container" };
  const hub = {
    snap: { accessRequests: [] as unknown[], config: { project: { id: "ctrtest", type: "security", scope: { inScope: ["example.net"], outOfScope: ["www.iana.org"], rules: "" } } } },
    cfg: (id: string) => (id === "dwight" ? cfg : undefined),
    holdForAccess: () => {},
    emit: (e: { type: string; request?: { domain: string } }) => e.request && requests.push(e.request.domain),
    setStatus: () => {},
    activity: () => {},
  };
  const projects = new Map([["ctrtest", { slug: "ctrtest", hub }]]);
  const PORT = Number(process.env.HQ_TEST_PORT ?? 7701); // 7420 matches the firewall rule the setup checklist suggests
  const proxy = startEgressProxy(projects as never, PORT);
  await new Promise((r) => setTimeout(r, 300));
  // A host firewall that drops incoming traffic (ufw default) hides the proxy from containers: say so instead of failing.
  const probe = await run("docker", ["run", "--rm", "--network", NETWORK, IMAGE, "sh", "-c", `curl -s -o /dev/null -m 4 http://${GATEWAY}:${egressPort(PORT)}/; echo $?`], { timeoutMs: 30_000 });
  if (probe.stdout.trim() === "28") {
    console.log(`- skipped live proxy test: the host firewall blocks containers from reaching HQ. Run: ${hostFirewallCmd(PORT)}`);
    proxy.close();
    console.log(fails ? `\n${fails} failed` : "\nall passed");
    process.exit(fails ? 1 : 0);
  }
  const name = "hq-ctrtest-dwight";
  await run("docker", ["rm", "-f", name]);
  const curl = (url: string) =>
    run("docker", ["run", "--rm", "--name", name, "--network", NETWORK, "-e", `HTTPS_PROXY=http://${GATEWAY}:${egressPort(PORT)}`, IMAGE, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "15", url], { timeoutMs: 40_000 });
  const allowed = await curl("https://api.github.com/zen");
  check("allowed site goes through the proxy", allowed.stdout.trim() === "200", `${allowed.stdout} ${allowed.stderr}`);
  const extra = await curl("https://example.com/");
  check("the agent's own allow list works", extra.stdout.trim() === "200", `${extra.stdout} ${extra.stderr}`);
  const scoped = await curl("https://example.net/");
  check("security engagement: an in-scope site is allowed", scoped.stdout.trim() === "200", `${scoped.stdout} ${scoped.stderr}`);
  const outScope = await curl("https://www.iana.org/");
  check("security engagement: out of scope is refused", outScope.stdout.trim() !== "200", outScope.stdout);
  const blocked = await curl("https://example.org/");
  check("other sites are refused", blocked.stdout.trim() !== "200", blocked.stdout);
  check("a refused site becomes an access request", requests.includes("example.org"), requests.join(","));
  const unknown = await run("docker", ["run", "--rm", "--network", NETWORK, "-e", `HTTPS_PROXY=http://${GATEWAY}:${egressPort(PORT)}`, IMAGE, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "10", "https://api.github.com/zen"], { timeoutMs: 30_000 });
  check("a container HQ doesn't know gets nothing", unknown.stdout.trim() !== "200", unknown.stdout);
  proxy.close();
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
