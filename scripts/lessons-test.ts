// Lesson promotion (docs/templates.md section 8): lessons full of hosts, IPs, names and keys go in; none of those
// comes out, whatever the rewrite model returns. Run: npx tsx scripts/lessons-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-lessons-"));
const { hqDb } = await import("../server/lib/db");
const { copyToProject, seedBuiltins } = await import("../server/templates");
const { decideLesson, lessonsForBrief, projectWords, promoteLessons, specificsIn, templateIdOf, templateLessons } = await import("../server/lessons");
const { LessonPromotion } = await import("../server/lessonPromotion");
import type { Memory } from "../src/data/model";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const db = hqDb();
seedBuiltins(db);
copyToProject(db, "acme-shop", "dev");
copyToProject(db, "globex-pentest", "security-red");
check("a project's template is the library template it came from", templateIdOf(db, "acme-shop") === "dev" && templateIdOf(db, "nope") === null);

const project = { id: "acme-shop", name: "Acme Shop", repo: "acmecorp/acme-shop", officeName: "ACME HQ" };
const VAULT = "s3cr3t-vault-value-1234";
const src = { projectId: project.id, words: projectWords(project), keepOut: ["Priya Raman", "@priya_dev"], redact: (x: string) => x.split(VAULT).join("[secret]") };

let n = 0;
const mem = (type: string, text: string, certified = true): Memory => ({ id: `M-${++n}`, projectId: project.id, type, text, taskId: null, about: [], certified, certifiedBy: certified ? "you" : null, source: "extraction", by: "hq", createdAt: "", lastUsedAt: "" });
const dirty = [
  mem("Lesson", "The staging box at staging.acme-shop.io (10.20.0.15) needs NODE_OPTIONS raised before next build, or it runs out of memory."),
  mem("DeadEnd", "Priya Raman tried polling https://api.acmecorp.com/v2/sessions for sign-outs; it missed revoked sessions."),
  mem("Decision", "Acme Shop keeps rate limits in middleware.ts, before auth, so anonymous floods never reach the database."),
  mem("Lesson", "The Stripe key sk-live-abcdefghijklmnopqrstuvwx1234 must never be logged; ask @priya_dev or mail ops@acmecorp.com."),
  mem("Lesson", `Seeding with token ${VAULT} from /home/deploy/acme/.env failed until row-level security was on.`),
  mem("Lesson", "Enable row-level security before seeding Postgres, or the seed writes rows nobody can read back."),
  mem("Decision", "Use the provider's session webhook for sign-outs instead of polling its sessions endpoint."),
  mem("Lesson", "Database at 2001:db8::8a2e:370:7334 is reachable only from the VPN.", true),
  mem("Asset", "staging.acme-shop.io runs nginx 1.25."), // not a lesson type
  mem("Lesson", "Uncertified: something about acme.", false),
];
const SENSITIVE = [/acme/i, /10\.20\.0\.15/, /2001:db8/, /https?:\/\//, /@/, /Priya/i, /sk-live/, new RegExp(VAULT), /\/home\//, /\.io\b/, /ops@/, /\[(secret|email|ip|name|phone)\]/];

const prompts: string[] = [];
// A lazy model: hands every text back unchanged.
const echo = async (req: { prompt: string }) => {
  prompts.push(req.prompt);
  return JSON.stringify({ lessons: req.prompt.split("\n").map((line) => ({ i: Number(line.split(".")[0]), text: line.replace(/^\d+\.\s*\w+:\s*/, "") })) });
};
const r1 = await promoteLessons(db, "dev", dirty, src, echo);
const stored = () => templateLessons(db, "dev").map((l) => l.text);
check("only certified Lessons, Decisions and Dead ends are sent", prompts[0].split("\n").length === 8 && !/nginx|Uncertified/.test(prompts[0]), prompts[0]);
check("keys, vault values, emails and keep-out names never reach the model", !/sk-live|ops@acmecorp|Priya Raman|@priya_dev/.test(prompts[0]) && !prompts[0].includes(VAULT), prompts[0]);
check("a model that changes nothing: only the already-general lessons survive", r1.offered.length === 2 && r1.dropped === 6 && stored().every((t) => /row-level security before seeding Postgres|session webhook/.test(t)), JSON.stringify(stored()));
check("none of the hosts, IPs, URLs, names, keys or paths survives", stored().every((t) => !SENSITIVE.some((re) => re.test(t))), JSON.stringify(stored()));
check("they wait for the owner, with no project id kept", templateLessons(db, "dev").every((l) => l.status === "pending") && !JSON.stringify(db.prepare("SELECT * FROM template_lessons").all()).includes("acme-shop"));

// A model that tries to slip specifics back in, and one that rewrites well.
const sneaky = async (req: { prompt: string }) =>
  JSON.stringify({
    lessons: req.prompt.split("\n").map((line, i) => ({
      i,
      text: [
        "Raise NODE_OPTIONS on the staging host staging.acme-shop.io before builds.",
        "Polling a session endpoint misses revoked sessions; see https://example.com/docs.",
        "Keep rate limits in middleware, before auth, as the Acme Shop team did.",
        null,
        "Seeding failed until row-level security was on (token in /home/deploy/.env).",
        "x",
      ][i % 6],
    })),
  });
const fresh = dirty.map((m) => ({ ...m, id: `${m.id}-b` }));
const r2 = await promoteLessons(db, "dev", fresh, src, sneaky);
check("a model that slips specifics back in gets nothing through", r2.offered.length === 0 && r2.dropped === 8, JSON.stringify(r2));
const good = async () =>
  JSON.stringify({
    lessons: [
      { i: 0, text: "Raise the Node heap limit before building on small machines, or the build runs out of memory." },
      { i: 1, text: "Polling a session endpoint misses revoked sessions; subscribe to the session webhook instead." },
      { i: 2, text: "Keep rate limits in middleware.ts, before auth, so anonymous floods never reach the database." },
      { i: 3, text: null },
      { i: 4, text: "Seeding fails until row-level security is on." },
    ],
  });
const third = dirty.map((m) => ({ ...m, id: `${m.id}-c` }));
const r3 = await promoteLessons(db, "dev", third, src, good);
check("good rewrites pass, conventional file names included", r3.offered.length === 4 && r3.offered.some((l) => l.text.includes("middleware.ts")), JSON.stringify(r3));
check("still nothing sensitive in anything stored", stored().every((t) => !SENSITIVE.some((re) => re.test(t))));
const r4 = await promoteLessons(db, "dev", third, src, good);
check("a memory is offered once", r4.offered.length === 0 && r4.seen === 8);
check("bad JSON from the model stores nothing", await promoteLessons(db, "dev", dirty.map((m) => ({ ...m, id: `${m.id}-d` })), src, async () => "no json here").then(() => false, () => templateLessons(db, "dev").length === 6));

// The check itself.
check("specificsIn catches hosts, IPs, URLs, emails, paths, masks and the project's words", [
  "Use staging.example.com", "Reach 192.168.1.4", "See http://x", "mail a@b.co", "In /Users/me/app", "the [secret] value", "Acme Shop does it", "acme-shop repo", "ask Priya Raman",
].every((t) => specificsIn(t, src).length > 0));
check("…and passes plain lessons with file names", ["Put rate limits in middleware.ts before auth.", "Run next.config.js checks; README.md lists them.", "Bump Node to 22 and re-run app.py."].every((t) => specificsIn(t, src).length === 0));

// The owner decides; approved lessons reach the briefs of projects from that template only.
const waiting = templateLessons(db, "dev", "pending");
decideLesson(db, waiting[0].id, true);
decideLesson(db, waiting[1].id, false);
const brief = lessonsForBrief(db, "dev");
check("an approved lesson is in the brief of a project from the template", brief.includes(waiting[0].text) && !brief.includes(waiting[1].text) && /approved by the owner/.test(brief));
check("…not in a project from another template", lessonsForBrief(db, "security-red") === "" && lessonsForBrief(db, null) === "");
decideLesson(db, waiting[0].id, false);
check("a removed lesson leaves the briefs", lessonsForBrief(db, "dev") === "");

// The switch: off by default for security engagements.
const hubFor = (id: string, findings: boolean, promote?: boolean) => ({ snap: { config: { project: { id, ...(promote === undefined ? {} : { promoteLessons: promote }) }, rules: { findings } } }, emit: () => {}, activity: () => {}, configChanged: () => {} });
const dev = new LessonPromotion(hubFor("acme-shop", false) as never, () => null);
const sec = new LessonPromotion(hubFor("globex-pentest", true) as never, () => null);
const secOn = new LessonPromotion(hubFor("globex-pentest", true, true) as never, () => null);
check("on by default for a dev project, off for a security engagement, and the owner can switch it on", dev.enabled() && !sec.enabled() && secOn.enabled());
check("the state names the project's template", dev.state().templateId === "dev" && sec.state().templateId === "security-red");
let said = "";
const blocked = new LessonPromotion({ ...hubFor("globex-pentest", true), activity: (_k: string, _a: null, t: string) => void (said = t) } as never, () => null);
await blocked.run();
check("a run while it's off does nothing and says why", /off for this project/.test(said) && blocked.state().last === said);
for (const p of [dev, sec, secOn, blocked]) p.close();

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
