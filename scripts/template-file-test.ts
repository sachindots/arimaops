// Saving a template to a file and importing it on another HQ (docs/templates.md section 7): the file's shape, the
// checks on import, pinned packs (vetted, and an unvetted one fetched at the file's commit and hash-checked), and the
// same team and flow on the other side. Run: npx tsx scripts/template-file-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeA = mkdtempSync(join(tmpdir(), "arima-tplfile-a-"));
const homeB = mkdtempSync(join(tmpdir(), "arima-tplfile-b-"));
process.env.HOME = homeA;
const { hqDb } = await import("../server/lib/db");
const { copyToProject, getTemplate, listTemplates, seatsFor, seedBuiltins } = await import("../server/templates");
const { exportTemplate, importTemplate, libraryState, packProblems } = await import("../server/templateIO");
const { decidePack, ownerPacks, skillHash, vettedPacks } = await import("../server/skillPacks");
const { readTemplateFile, packSkillsOf } = await import("../src/data/templateFile");
const { SECURITY_RED_TEMPLATE } = await import("../src/data/securityTemplates");
const { RESEARCH_TEMPLATE } = await import("../src/data/researchTemplate");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const rejects = async (p: Promise<unknown>, mention: RegExp) => {
  try {
    await p;
    return false;
  } catch (e) {
    const ok = mention.test((e as Error).message);
    if (!ok) console.log(`   (said: ${(e as Error).message})`);
    return ok;
  }
};

const db = hqDb();
seedBuiltins(db);

// ---------------------------------------------------------------- export
const red = exportTemplate(SECURITY_RED_TEMPLATE, new Date("2026-11-13T00:00:00Z"));
const used = packSkillsOf(SECURITY_RED_TEMPLATE);
check("the file names its format and version", red.format === "arimaops-template" && red.v === 1 && red.exportedAt === "2026-11-13T00:00:00.000Z");
check("it pins every pack the template names, at this HQ's commit, with only the skills it uses", [...used].every(([src, names]) => red.packs[src]?.commit === vettedPacks()[src].commit && Object.keys(red.packs[src].skills).sort().join() === [...names].sort().join()));
check("…with their hashes", Object.entries(red.packs).every(([src, p]) => Object.entries(p.skills).every(([n, s]) => s.sha256 === vettedPacks()[src].skills[n].sha256)));
const text = JSON.stringify(red);
check("no secrets, seats or project data: only the template's own fields", Object.keys(red.template).sort().join() === "description,flow,id,memoryTypes,name,roles,rules,starter,version" && !/token|apiKey|password|team":/i.test(text));

// ---------------------------------------------------------------- reading a file
check("not JSON is refused", (() => { try { readTemplateFile("{oops"); return false; } catch (e) { return /isn't JSON/.test((e as Error).message); } })());
check("another format is refused", (() => { try { readTemplateFile(JSON.stringify({ format: "other" })); return false; } catch (e) { return /Not an ArimaOps template/.test((e as Error).message); } })());
check("a newer version is refused", (() => { try { readTemplateFile(JSON.stringify({ ...red, v: 2 })); return false; } catch (e) { return /version 2/.test((e as Error).message); } })());
check("an invalid template is refused with why", (() => { try { readTemplateFile(JSON.stringify({ ...red, template: { ...red.template, roles: [] } })); return false; } catch (e) { return /isn't valid/.test((e as Error).message); } })());
check("a file over 512 KB is refused", (() => { try { readTemplateFile(" ".repeat(600 * 1024)); return false; } catch (e) { return /over 512 KB/.test((e as Error).message); } })());
const firstPack = Object.keys(red.packs)[0];
check("a pin without a hash for a skill the template uses is refused", (() => { try { readTemplateFile(JSON.stringify({ ...red, packs: { ...red.packs, [firstPack]: { commit: red.packs[firstPack].commit, skills: {} } } })); return false; } catch (e) { return /no hash/.test((e as Error).message); } })());
const extra = readTemplateFile(JSON.stringify({ ...red, template: { ...red.template, secretSauce: "x" }, packs: { ...red.packs, "someone/unused": { commit: "b".repeat(40), skills: {} } } }));
check("fields a template doesn't have, and pins for packs it doesn't use, are dropped", !("secretSauce" in extra.template) && !extra.packs["someone/unused"]);

// ---------------------------------------------------------------- import on another HQ
process.env.HOME = homeB; // hqDb() is per home: a fresh HQ
const dbB = (await import("../server/lib/db")).hqDb();
const sameDb = dbB === db;
check("the second HQ is a different database", !sameDb);
seedBuiltins(dbB);
const r = await importTemplate(dbB, text, "you");
check("it imports under a new id (the built-in keeps its own)", r.template.id === "security-red-2" && getTemplate(dbB, "security-red")?.name === SECURITY_RED_TEMPLATE.name && r.pending.length === 0, JSON.stringify(r));
check("same roles, flow and rules", JSON.stringify([r.template.roles, r.template.flow, r.template.rules]) === JSON.stringify([SECURITY_RED_TEMPLATE.roles, SECURITY_RED_TEMPLATE.flow, SECURITY_RED_TEMPLATE.rules]));
const copy = copyToProject(dbB, "acme-pentest", r.template.id);
check("a project uses it and gets the same team", JSON.stringify(seatsFor(copy).map((s) => s.roleId)) === JSON.stringify(seatsFor(SECURITY_RED_TEMPLATE).map((s) => s.roleId)));
const again = await importTemplate(dbB, text, "you");
check("importing again makes another copy, never overwriting", again.template.id === "security-red-3" && listTemplates(dbB).filter((t) => t.name === SECURITY_RED_TEMPLATE.name).length === 3);
const research = await importTemplate(dbB, JSON.stringify(exportTemplate(RESEARCH_TEMPLATE)), "you");
check("a template with built-in skills only imports with no pins", research.template.id === "research-2" && research.pending.length === 0);

// ---------------------------------------------------------------- an unvetted pack: fetched at the file's commit, hash-checked, scanned
const COMMIT = "c".repeat(40);
const files: Record<string, string> = { "skills/brand-voice/SKILL.md": "---\nname: brand-voice\n---\nWrite like us.\n" };
const asked: string[] = [];
const fake = async (url: string) => {
  asked.push(url);
  const ok = (s: string) => ({ ok: true, status: 200, text: async () => s, arrayBuffer: async () => new TextEncoder().encode(s).buffer as ArrayBuffer });
  if (url === "https://api.github.com/repos/acme/voice") return ok(JSON.stringify({ default_branch: "main", license: { spdx_id: "MIT" } }));
  if (url.startsWith(`https://api.github.com/repos/acme/voice/git/trees/${COMMIT}`)) return ok(JSON.stringify({ tree: Object.keys(files).map((path) => ({ path, type: "blob", mode: "100644", size: 10 })) }));
  const m = url.match(new RegExp(`^https://raw\\.githubusercontent\\.com/acme/voice/${COMMIT}/(.+)$`));
  const c = m ? files[decodeURIComponent(m[1])] : undefined;
  return c !== undefined ? ok(c) : { ok: false, status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
};
const hash = skillHash([{ path: "SKILL.md", content: Buffer.from(files["skills/brand-voice/SKILL.md"]) }]);
const withPack = (sha: string) =>
  JSON.stringify({
    ...exportTemplate(RESEARCH_TEMPLATE),
    template: { ...RESEARCH_TEMPLATE, id: "voice-research", name: "Voice research", roles: RESEARCH_TEMPLATE.roles.map((ro) => (ro.isLead ? { ...ro, skills: [...ro.skills, "acme/voice@brand-voice"] } : ro)) },
    packs: { "acme/voice": { commit: COMMIT, skills: { "brand-voice": { path: "skills/brand-voice", sha256: sha } } } },
  });
check("a file whose hash doesn't match GitHub at that commit is refused, and nothing is left behind", (await rejects(importTemplate(dbB, withPack("0".repeat(64)), "you", fake), /hash differs/)) && !ownerPacks()["acme/voice"] && !getTemplate(dbB, "voice-research"));
const v = await importTemplate(dbB, withPack(hash), "you", fake);
check("with the right hash it imports, the pack pinned at the file's commit (not the newest) and waiting for you", v.pending.join() === "acme/voice" && ownerPacks()["acme/voice"]?.commit === COMMIT && ownerPacks()["acme/voice"]?.status === "pending" && !asked.some((u) => u.includes("/commits/")));
check("…and no project can use it until you check the pack", /wait for your check/.test(packProblems(v.template).join()) && libraryState(dbB).find((e) => e.template.id === "voice-research")?.problems.length === 1);
let refused = "";
try {
  copyToProject(dbB, "voice", "voice-research");
} catch (e) {
  refused = (e as Error).message;
}
check("…the welcome refuses it with why", /can't be used yet: the skills from acme\/voice wait for your check/.test(refused), refused);
decidePack("acme/voice", true);
check("approved, it's usable", packProblems(v.template).length === 0 && copyToProject(dbB, "voice", "voice-research").id === "voice-research");
check("a pack pinned here at another commit refuses the file", await rejects(importTemplate(dbB, withPack(hash).replace(COMMIT, "d".repeat(40)), "you", fake), /pinned here at/));
decidePack("acme/voice", false);
check("a pack you rejected refuses the file", await rejects(importTemplate(dbB, withPack(hash), "you", fake), /rejected/));
check("the built-ins all stay usable", libraryState(dbB).filter((e) => e.builtin).every((e) => e.problems.length === 0));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
