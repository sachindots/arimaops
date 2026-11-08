// Engagement scope rules. Run: npx tsx scripts/scope-test.ts
import { checkScope, cleanEntry, firewallCommands, parseTarget, scopeDomains, scopeNetworks } from "../server/scope";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const scope = {
  inScope: ["*.acme.test", "acme.test", "10.20.0.0/24", "203.0.113.7", "api.partner.test:8443"],
  outOfScope: ["vpn.acme.test", "10.20.0.1"],
  rules: "No DoS. 09:00–18:00 UTC.",
};
const ok = (t: string) => checkScope(scope, t).ok;

check("wildcard subdomain in scope", ok("https://app.acme.test/login"));
check("apex in scope", ok("acme.test"));
check("lookalike domain out", !ok("evilacme.test"));
check("out of scope wins over wildcard", !ok("vpn.acme.test") && checkScope(scope, "vpn.acme.test").why.includes("explicitly"));
check("IP inside CIDR in scope", ok("10.20.0.55"));
check("excluded IP inside CIDR out", !ok("10.20.0.1"));
check("IP outside CIDR out", !ok("10.20.1.5"));
check("single IP in scope", ok("203.0.113.7:22"));
check("port-pinned entry: right port", ok("api.partner.test:8443"));
check("port-pinned entry: other port refused", !ok("https://api.partner.test/"));
check("no scope means nothing is in scope", !checkScope({ inScope: [], outOfScope: [], rules: "" }, "acme.test").ok);
check("garbage target refused", !ok("not a host!!"));

check("cleanEntry keeps domains, IPs, CIDRs, ports", ["Example.com", "*.a.io", "10.0.0.0/8", "1.2.3.4:443", "https://x.io/"].map(cleanEntry).join(",") === "example.com,*.a.io,10.0.0.0/8,1.2.3.4:443,x.io");
check("cleanEntry rejects junk", [cleanEntry("hello"), cleanEntry("300.1.1.1"), cleanEntry("10.0.0.0/40"), cleanEntry("a.com:99999")].every((x) => x === null));
check("parseTarget URL", JSON.stringify(parseTarget("https://A.acme.test:8443/x")) === JSON.stringify({ host: "a.acme.test", port: 8443 }));
check("networks vs domains split", scopeNetworks(scope).join(",") === "10.20.0.0/24,203.0.113.7" && scopeDomains(scope).join(",") === "*.acme.test,acme.test,api.partner.test");

const cmds = firewallCommands("acme", ["172.30.0.10"], ["10.20.0.0/24"], "br-hq");
check("firewall: clears this project's old rules first", cmds[0].includes("hq-scope-acme") && cmds[0].includes("s/^-A/-D/") && !cmds[0].includes(" -I "));
check("firewall: one ACCEPT per agent and target, tagged", cmds.length === 2 && cmds[1] === "sudo iptables -I DOCKER-USER -i br-hq -s 172.30.0.10 -d 10.20.0.0/24 -m comment --comment hq-scope-acme -j ACCEPT");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
