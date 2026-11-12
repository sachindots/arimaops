// The template library and project copies: built-ins, saving, copies, re-sync and seats.
// Run: npx tsx scripts/templates-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateErrors } from "../src/data/model";
import { BUILTIN_TEMPLATES, DEV_TEMPLATE } from "../src/data/templates";
import { hqDb } from "../server/lib/db";
import { closeDocs } from "../server/lib/docs";
import {
  copyToProject,
  getTemplate,
  listTemplates,
  projectTemplate,
  resyncProject,
  roleOf,
  saveTemplate,
  seatsFor,
  seedBuiltins,
  updateProjectTemplate,
} from "../server/templates";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const throws = (fn: () => unknown, mention: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return mention.test((e as Error).message);
  }
};
const clone = <T>(v: T): T => structuredClone(v);

for (const t of BUILTIN_TEMPLATES) check(`built-in "${t.id}" is valid`, templateErrors(t).length === 0, templateErrors(t).join(" | "));

const db = hqDb(mkdtempSync(join(tmpdir(), "arima-templates-")));
seedBuiltins(db);
seedBuiltins(db);
check("seeding twice keeps one row per built-in", listTemplates(db).length === BUILTIN_TEMPLATES.length);

{
  const stale = { ...clone(DEV_TEMPLATE), version: 0, name: "Old" };
  db.prepare("UPDATE templates SET version = 0, body = ? WHERE id = 'dev'").run(JSON.stringify(stale));
  seedBuiltins(db);
  check("seeding replaces an older built-in", getTemplate(db, "dev")?.name === DEV_TEMPLATE.name);
}

check("a built-in can't be overwritten", throws(() => saveTemplate(db, clone(DEV_TEMPLATE), "sachin"), /built in/));

{
  const mine = { ...clone(DEV_TEMPLATE), id: "my-dev", name: "My dev", version: 42 };
  const first = saveTemplate(db, mine, "sachin");
  check("a new template starts at version 1, whatever the caller says", first.version === 1);
  const second = saveTemplate(db, { ...mine, name: "My dev 2" }, "sachin");
  check("saving again bumps the version", second.version === 2 && getTemplate(db, "my-dev")?.name === "My dev 2");
  const bad = { ...clone(mine), roles: mine.roles.map((r) => ({ ...r, isLead: false })) };
  check("an invalid template is refused", throws(() => saveTemplate(db, bad, "sachin"), /exactly one lead/));
  check("a refused save leaves the stored one alone", getTemplate(db, "my-dev")?.version === 2);
}

{
  const copy = copyToProject(db, "askwell", "my-dev");
  check("a project gets its own copy", projectTemplate(db, "askwell")?.name === copy.name);
  check("copying twice is refused", throws(() => copyToProject(db, "askwell", "dev"), /already has a template/));
  check("an unknown template can't be copied", throws(() => copyToProject(db, "p2", "nope"), /No template/));

  saveTemplate(db, { ...clone(copy), name: "My dev 3" }, "sachin");
  check("a library edit doesn't change the project", projectTemplate(db, "askwell")?.name === "My dev 2");

  const edited = updateProjectTemplate(db, "askwell", { ...clone(copy), id: "elsewhere", name: "Askwell's team" });
  check("a project edit changes only the project", edited.name === "Askwell's team" && getTemplate(db, "my-dev")?.name === "My dev 3");
  check("a project edit keeps its template id", edited.id === "my-dev");
  check("an invalid project edit is refused", throws(() => updateProjectTemplate(db, "askwell", { ...clone(copy), flow: { stages: [] } }), /at least one stage/));

  const synced = resyncProject(db, "askwell");
  check("re-sync takes the library's current version", synced.version === 3 && projectTemplate(db, "askwell")?.name === "My dev 3");
  check("a project made before templates has none", projectTemplate(db, "hq-home") === null);
}

{
  const seats = seatsFor(DEV_TEMPLATE);
  const per = (role: string) => seats.filter((s) => s.roleId === role).length;
  check("the dev team starts with 1 lead, 2 developers, 1 reviewer", per("lead") === 1 && per("developer") === 2 && per("reviewer") === 1);
  check("the lead comes first", seats[0].roleId === "lead");
  check("every seat has its own id", new Set(seats.map((s) => s.id)).size === seats.length);
  const dev = seats.find((s) => s.roleId === "developer")!;
  check("a seat runs its role's CLI and model", roleOf(DEV_TEMPLATE, dev).cli === "claude" && roleOf(DEV_TEMPLATE, dev).model === "claude-sonnet-5-5");
  check("a seat with an unknown role is refused", throws(() => roleOf(DEV_TEMPLATE, { roleId: "designer" }), /No role/));
}

closeDocs();
if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
