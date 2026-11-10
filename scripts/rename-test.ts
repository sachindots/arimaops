// The ArimaOps rename: folders move once and safely, old markers and logs still count. Run: npx tsx scripts/rename-test.ts
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "arima-rename-"));
process.env.HOME = HOME;
const { migrateHome, migrateLegacy } = await import("../server/project");
const { repoDirOf, projectHome } = await import("../server/paths");
const { writeSettings } = await import("../server/agentFiles");
const { UsageMeter, claudeDirKey } = await import("../server/usage");
const { BRAND } = await import("../src/data/brand");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

// ---------------------------------------------------------------- ~/.hq → ~/.arima
mkdirSync(join(HOME, ".hq", "alpha", "nyx"), { recursive: true });
writeFileSync(join(HOME, ".hq", "users.json"), "[]");
check("no ~/.hq: nothing to do", migrateHome(mkdtempSync(join(tmpdir(), "arima-empty-"))) === "none");
check("~/.hq moves to ~/.arima", migrateHome(HOME) === "moved" && existsSync(join(HOME, ".arima", "users.json")) && existsSync(join(HOME, ".arima", "alpha", "nyx")));
check("a link stays at ~/.hq, so old paths still work", lstatSync(join(HOME, ".hq")).isSymbolicLink() && readlinkSync(join(HOME, ".hq")) === ".arima" && existsSync(join(HOME, ".hq", "users.json")));
check("running it again does nothing", migrateHome(HOME) === "none");
const both = mkdtempSync(join(tmpdir(), "arima-both-"));
mkdirSync(join(both, ".hq")); mkdirSync(join(both, ".arima"));
writeFileSync(join(both, ".hq", "keep.txt"), "x");
check("two folders are never merged (both kept, ~/.arima used)", migrateHome(both) === "both" && existsSync(join(both, ".hq", "keep.txt")) && !lstatSync(join(both, ".hq")).isSymbolicLink());
check("projects live in ~/.arima after the move", projectHome("alpha") === join(HOME, ".arima", "alpha"));

// ---------------------------------------------------------------- <repo>/.hq
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
const tracked = mkdtempSync(join(tmpdir(), "arima-repo-t-"));
git(tracked, "init", "-q");
mkdirSync(join(tracked, ".hq")); writeFileSync(join(tracked, ".hq", "config.json"), "{}");
git(tracked, "add", "."); git(tracked, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
await migrateLegacy(tracked, "t");
check("a committed .hq stays where it is, and HQ reads it there", existsSync(join(tracked, ".hq", "config.json")) && !existsSync(join(tracked, ".arima")) && repoDirOf(tracked) === join(tracked, ".hq"));
const loose = mkdtempSync(join(tmpdir(), "arima-repo-u-"));
git(loose, "init", "-q");
mkdirSync(join(loose, ".hq")); writeFileSync(join(loose, ".hq", "plan.json"), "{}");
await migrateLegacy(loose, "u");
check("an untracked .hq moves to .arima", existsSync(join(loose, ".arima", "plan.json")) && !existsSync(join(loose, ".hq")) && repoDirOf(loose) === join(loose, ".arima"));
check("a new repo gets .arima", repoDirOf(mkdtempSync(join(tmpdir(), "arima-new-"))).endsWith("/.arima"));

// ---------------------------------------------------------------- old hook markers are replaced, never duplicated
const ws = mkdtempSync(join(tmpdir(), "arima-ws-"));
mkdirSync(join(ws, ".claude"));
writeFileSync(join(ws, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "curl old-hq-hook || true # dothq-hook" }, { type: "command", command: "echo mine" }] }] } }));
writeSettings(ws, { id: "nyx", cli: "claude", mode: "local", name: "Nyx" } as never, 7420, "tok");
const stop = JSON.parse(readFileSync(join(ws, ".claude", "settings.local.json"), "utf8")).hooks.Stop as { hooks: { command: string }[] }[];
const cmds = stop.flatMap((e) => e.hooks.map((h) => h.command));
check("an old '# dothq-hook' is replaced by the new one; your own hooks stay", !cmds.some((c) => c.includes("old-hq-hook")) && cmds.includes("echo mine") && cmds.filter((c) => c.includes(BRAND.hookMark)).length === 1, JSON.stringify(cmds));

// ---------------------------------------------------------------- token history survives the move
const newDir = join(HOME, ".arima", "alpha", "nyx");
const oldKey = claudeDirKey(join(HOME, ".hq", "alpha", "nyx"));
mkdirSync(join(HOME, ".claude", "projects", oldKey), { recursive: true });
writeFileSync(join(HOME, ".claude", "projects", oldKey, "s.jsonl"), JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } } }) + "\n");
const t = new UsageMeter(HOME).read("claude", newDir);
check("Claude token logs filed under the old ~/.hq path still count", !!t && t.input + t.output > 0, JSON.stringify(t));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
