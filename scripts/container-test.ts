// Container mode: allowlist rules, docker run flags, and (when Docker and the dothq-agent image exist)
// a real container going through HQ's egress proxy. Run: npx tsx scripts/container-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-ctr-"));
const { hostAllowed, runArgs, ensureNetwork, startEgressProxy, hostFirewallCmd, IMAGE, NETWORK, GATEWAY, egressPort, BASE_ALLOW } = await import("../server/containers");
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
check("runs the CLI with its args", args.slice(-4).join(" ") === `${IMAGE} claude --model opus`);
let threw = false;
try {
  runArgs({ ...agent, cli: "agy" } as never, "x", "/tmp", [], null, 7420);
} catch {
  threw = true;
}
check("agy is refused in Container mode", threw);

// ---------------------------------------------------------------- live proxy
const docker = (await run("docker", ["image", "inspect", IMAGE], { timeoutMs: 8000 })).ok && (await ensureNetwork());
if (!docker) console.log("- skipped live proxy test (needs Docker and the dothq-agent image)");
else {
  const requests: string[] = [];
  const cfg = { ...agent, mode: "container" };
  const hub = {
    snap: { accessRequests: [] as unknown[] },
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
  const blocked = await curl("https://example.org/");
  check("other sites are refused", blocked.stdout.trim() !== "200", blocked.stdout);
  check("a refused site becomes an access request", requests.includes("example.org"), requests.join(","));
  const unknown = await run("docker", ["run", "--rm", "--network", NETWORK, "-e", `HTTPS_PROXY=http://${GATEWAY}:${egressPort(PORT)}`, IMAGE, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "10", "https://api.github.com/zen"], { timeoutMs: 30_000 });
  check("a container HQ doesn't know gets nothing", unknown.stdout.trim() !== "200", unknown.stdout);
  proxy.close();
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
