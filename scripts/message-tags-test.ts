// Team messages: the tag (Done / Blocked / Question / FYI / Disagrees) and the body without chat filler.
// Run: npx tsx scripts/message-tags-test.ts
import { isLong, splitTag, tidy } from "../src/data/messageTags";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

eq("leading word becomes the tag", splitTag("Done: P3-T01 merged in #14."), { tag: "done", body: "P3-T01 merged in #14." });
eq("bold and bracket forms", [splitTag("**Blocked:** need DATABASE_URL").tag, splitTag("[FYI] main moved").tag, splitTag("Question - which port?").tag], ["blocked", "fyi", "question"]);
eq("explicit kind wins, the word still comes off", splitTag("FYI: build is green", "done"), { tag: "done", body: "build is green" });
eq("no tag word: no tag, text kept", splitTag("Pull main, start P3-T01."), { tag: null, body: "Pull main, start P3-T01." });
eq("a word that only starts a sentence is not a tag", [splitTag("Stuck-at-zero bug fixed in sum.ts").tag, splitTag("Update the readme with the port").tag], [null, null]);
eq("greeting, praise and sign-off come off",
  tidy("Hi Ghost, great question! The route lives in src/chat.ts and returns 200.\n\nLet me know if you need anything else!\n\nBest,\nVortex"),
  "The route lives in src/chat.ts and returns 200.");
eq("filler only at the edges", tidy("Thanks, merged. Hope this helps the next one: keep the lock."), "merged. Hope this helps the next one: keep the lock.");
eq("'Hey check this' is not a greeting to strip", tidy("Hey check the failing test in auth.ts"), "Hey check the failing test in auth.ts");
eq("all filler keeps the original", tidy("Thanks!"), "Thanks!");
eq("the owner's own words are never tidied", splitTag("Hi Ghost, ship it today.", null, false).body, "Hi Ghost, ship it today.");
check("long: more than 3 lines or ~3 lines of text", isLong("a\nb\nc\nd") && isLong("x".repeat(400)) && !isLong("one\ntwo\nthree"));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
