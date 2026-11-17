// Machine-wide account limits and the agent cap. Run: npx tsx scripts/accounts-test.ts
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEnv, cleanAccount, fitsInRam, markLimited, maxAgents, mirrorHome, onAccountLimit, runningAgents, shareLimit } from "../server/accounts";
import { allocate, BLOCK, PORT_BASE } from "../server/ports";
import { shellCommand } from "../server/backends/tmux";
import { authVolume, loginCommand } from "../server/containers";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

type Agent = { id: string; name: string; cli: string; account?: string };
function hub(slug: string, team: Agent[], sessions: Record<string, string>) {
  const statuses = new Map(team.map((a) => [a.id, { agentId: a.id, limitedUntil: null as string | null, note: "", session: { state: sessions[a.id] ?? "running" } }]));
  return {
    slug,
    snap: { config: { team }, agents: [...statuses.values()] },
    status: (id: string) => statuses.get(id),
    setStatus: (id: string, patch: object) => Object.assign(statuses.get(id)!, patch),
  };
}

const until = new Date(Date.now() + 3 * 3600_000);
const a = hub("alpha", [{ id: "cipher", name: "Cipher", cli: "claude" }, { id: "nyx", name: "Nyx", cli: "codex" }, { id: "ghost", name: "Ghost", cli: "claude" }], {});
const b = hub("beta", [{ id: "cipher", name: "Vega", cli: "claude" }, { id: "rook", name: "Rook", cli: "claude" }, { id: "kit", name: "Kit", cli: "claude" }, { id: "wren", name: "Wren", cli: "claude", account: "work" }], { kit: "stopped" });
const marks: string[][] = [];
const offs = [a, b].map((h) => onAccountLimit((cli, t, from) => marks.push(markLimited(h as never, cli, t, from))));
shareLimit("claude", until, { project: "alpha", agentId: "ghost", name: "Ghost", account: "default" });
check("same CLI in the same project is marked, the agent itself and other CLIs aren't", JSON.stringify(marks[0]) === JSON.stringify(["Cipher"]) && a.status("nyx")!.limitedUntil === null && a.status("ghost")!.limitedUntil === null);
check("same CLI in another project is marked, even with the same agent id; stopped agents aren't", JSON.stringify(marks[1]) === JSON.stringify(["Vega", "Rook"]) && b.status("kit")!.limitedUntil === null);
check("an agent on another account of the same CLI keeps working", b.status("wren")!.limitedUntil === null);
a.setStatus("ghost", { limitedUntil: until.toISOString() }); // sessions marks the agent that hit it
marks.length = 0;
shareLimit("claude", new Date(until.getTime() - 3600_000), { project: "beta", agentId: "rook", name: "Rook", account: "default" });
check("an earlier reset doesn't shorten a longer limit", marks.every((m) => m.length === 0), JSON.stringify(marks));
offs.forEach((off) => off());
marks.length = 0;
shareLimit("claude", until, { project: "alpha", agentId: "ghost", name: "Ghost", account: "default" });
check("an unloaded project stops listening", marks.length === 0);

check("agent cap: 16 GB allows 26 CLI processes", maxAgents(16 * 2 ** 30, undefined) === 26, String(maxAgents(16 * 2 ** 30, undefined)));
check("agent cap: 4 GB and tiny machines still 2", maxAgents(4 * 2 ** 30, undefined) === 2 && maxAgents(2 ** 30, undefined) === 2);
check("agent cap: ARIMA_MAX_AGENTS wins", maxAgents(4 * 2 ** 30, "12") === 12 && maxAgents(4 * 2 ** 30, "nope") === 2);

// RAM budget: sandboxes count their own size (sbx's half-RAM default made them 11 GB each on a 22 GB laptop).
{
  const GB = 2 ** 30;
  const seat = (id: string, mode: string, memoryGb: number | null) => ({ id, mode, sandbox: { resources: { cpus: null, memoryGb } } });
  const hubOf = (agents: [ReturnType<typeof seat>, number | null][]) => ({
    snap: {
      config: { team: agents.map(([a]) => a) },
      agents: agents.map(([a, actual]) => ({ agentId: a.id, session: { state: "running", sandbox: actual === null ? null : { cpus: 2, memoryGb: actual } } })),
    },
  });
  const sb = seat("new", "sandbox", null);
  check("default 2 GB sandboxes: 9 fit in 22 GB", fitsInRam([hubOf(Array.from({ length: 8 }, (_, i) => [seat(`s${i}`, "sandbox", null), null]))] as never, sb as never, 22 * GB, undefined)
    && !fitsInRam([hubOf(Array.from({ length: 9 }, (_, i) => [seat(`s${i}`, "sandbox", null), null]))] as never, sb as never, 22 * GB, undefined));
  check("an old half-RAM sandbox counts at its real size", !fitsInRam([hubOf([[seat("old", "sandbox", null), 11], [seat("old2", "sandbox", null), 11]])] as never, sb as never, 22 * GB, undefined));
  check("Local agents count as a CLI process", fitsInRam([hubOf(Array.from({ length: 30 }, (_, i) => [seat(`l${i}`, "local", null), null]))] as never, seat("n", "local", null) as never, 22 * GB, undefined));
  check("a big sandbox the owner chose counts its size", !fitsInRam([hubOf([])] as never, seat("big", "sandbox", 20) as never, 22 * GB, undefined));
  check("ARIMA_MAX_AGENTS counts agents instead", fitsInRam([hubOf([[seat("old", "sandbox", null), 11], [seat("old2", "sandbox", null), 11]])] as never, sb as never, 22 * GB, "3"));
}
check("running agents counted across projects (stopped excluded)", runningAgents([a, b] as never) === 6);

// Accounts: names, folders, container volumes.
check("account names are cleaned", cleanAccount("  Work Account! ") === "work-account" && cleanAccount("///") === "");
check("default account: the CLI's usual folder and volume", JSON.stringify(accountEnv("claude", "default", "/h")) === "{}" && authVolume("claude") === "hq-auth-claude");
check("another account: its own folder (Claude, Codex) and volume", accountEnv("claude", "work", "/h").CLAUDE_CONFIG_DIR?.endsWith("accounts/claude-work") === true && accountEnv("codex", "work", "/h").CODEX_HOME?.endsWith("accounts/codex-work") === true && authVolume("codex", "work") === "hq-auth-codex-work" && loginCommand("codex", 7420, "work").includes("hq-auth-codex-work:"));

const g = accountEnv("agy", "g2", "/h");
check("another Google account: its own home and no shared keyring", g.HOME?.endsWith("accounts/agy-g2") === true && g.DBUS_SESSION_BUS_ADDRESS?.startsWith(`unix:path=${g.HOME}/`) === true);
const real = mkdtempSync(join(tmpdir(), "arima-home-"));
for (const d of [".ssh", ".gemini", ".config/gh", ".config/antigravity", ".local/bin", ".arima/accounts"]) mkdirSync(join(real, d), { recursive: true });
writeFileSync(join(real, ".gitconfig"), "");
const acct = join(real, ".arima/accounts/agy-g2");
mirrorHome(acct, real);
mirrorHome(acct, real);
const link = (p: string) => { try { return readlinkSync(join(acct, p)); } catch { return null; } };
check("account home: git, ssh, gh and tools link to the real home", link(".gitconfig") === join(real, ".gitconfig") && link(".ssh") === join(real, ".ssh") && link(".config/gh") === join(real, ".config/gh") && link(".local/bin") === join(real, ".local/bin"));
check("account home: sign-in folders and HQ's own folder are not shared", link(".gemini") === null && link(".config/antigravity") === null && link(".arima") === null && lstatSync(join(acct, ".config")).isDirectory() && !lstatSync(join(acct, ".config")).isSymbolicLink());
rmSync(real, { recursive: true, force: true });

check("Antigravity sign-in keeps its settings folders in the login volume", loginCommand("agy", 7420, "g2").includes("-e XDG_CONFIG_HOME=/home/agent/.gemini/") && loginCommand("agy", 7420, "g2").includes("hq-auth-agy-g2:/home/agent/.gemini") && !loginCommand("claude", 7420).includes("XDG_"));

{
  const { containerLogins } = await import("../server/setup");
  const t = (cli: string, mode: string, account?: string) => ({ cli, mode, account }) as never;
  const got = containerLogins([t("agy", "container"), t("agy", "container", "g2"), t("claude", "container", "work-key"), t("codex", "local", "g3")], (id) => id === "work-key");
  check("Setup asks for each container account's sign-in, not API-key or Local ones", JSON.stringify(got) === JSON.stringify([["agy", "default"], ["agy", "g2"], ["claude", "default"]]), JSON.stringify(got));
}

// Port blocks: unique, stable, reused after release.
let taken: Record<string, number> = {};
const first = allocate(taken, "alpha/cipher");
taken = first.taken;
const second = allocate(taken, "beta/cipher");
taken = second.taken;
check("port blocks: same agent name in two projects gets two blocks", first.block.first === PORT_BASE && second.block.first === PORT_BASE + BLOCK && second.block.last === PORT_BASE + 2 * BLOCK - 1);
check("port blocks: an agent keeps its block", allocate(taken, "alpha/cipher").block.first === PORT_BASE);
delete taken["alpha/cipher"];
check("port blocks: a freed block is reused", allocate(taken, "gamma/nyx").block.first === PORT_BASE);
const cmd = shellCommand({ file: "claude", args: [], envFile: "/x/.env", env: { PORT: "4100", "BAD KEY": "x", CLAUDE_CONFIG_DIR: "/h/a b" } });
check("launch: port and account variables exported after the env file, bad names dropped", cmd.indexOf("export PORT=") > cmd.indexOf("/x/.env") && cmd.includes("CLAUDE_CONFIG_DIR='/h/a b'") && !cmd.includes("BAD KEY"), cmd.slice(-160));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
