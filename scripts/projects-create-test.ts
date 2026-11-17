// Creating a project from the Projects panel: the folder is registered with no config saved, so it loads as new
// and opens on the welcome screen (not as a read-only "made before templates" project).
// Run: npx tsx scripts/projects-create-test.ts
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-create-"));
const { registerProjectPath, readRegistry } = await import("../server/projectsRegistry");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const dir = join(process.env.HOME, "projects", "lion-shop");
const added = registerProjectPath(dir, true);
check("returns the folder it made", added.path === dir && existsSync(dir), added.path);
check("saves no config, so the project loads as new", readdirSync(dir).length === 0, readdirSync(dir).join(", "));
check("is registered", readRegistry().some((e) => e.path === dir));
check("has no overview until it is loaded", added.project === null);

let refused = "";
try {
  registerProjectPath(join(process.env.HOME, "projects"), true);
} catch (e) {
  refused = e instanceof Error ? e.message : String(e);
}
check("won't create into a folder that isn't empty", /isn't empty/.test(refused), refused);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
