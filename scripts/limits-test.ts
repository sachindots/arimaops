// Usage-limit detection. Run: npx tsx scripts/limits-test.ts
import { detectLimit, detectRefusal } from "../server/limits";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const now = new Date(2026, 10, 8, 14, 0, 0); // 2:00 pm local
const hm = (d: Date | undefined) => (d ? `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : "none");

check("Claude 5-hour limit with a clock time", hm(detectLimit("  ⎿  5-hour limit reached ∙ resets 3pm\n> ", now)?.until) === "8 15:00");
check("clock time earlier than now rolls to tomorrow", hm(detectLimit("Weekly limit reached · resets 9:30 am", now)?.until) === "9 9:30");
check("Claude epoch form", detectLimit("Claude AI usage limit reached|1767225600", now)?.until.getTime() === 1767225600 * 1000);
check("Codex relative time", hm(detectLimit("■ You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.", now)?.until) === "8 16:13");
check("Gemini quota without time → 30 min, not exact", (() => {
  const h = detectLimit("✕ [API Error: Quota exceeded for quota metric 'Requests']", now);
  return hm(h?.until) === "8 14:30" && h?.exact === false;
})());
check("Copilot", !!detectLimit("Sorry, you've hit the rate limit. Please try again in 37m", now));
check("code about rate limits is not a hit", detectLimit("  const rateLimit = new RateLimiter({ max: 100 });\n  // rate limit per user", now) === null);
check("plain screen", detectLimit("> Working on B1-T02…\n  Edited src/app.ts", now) === null);

check("OpenCode's free quota is a limit with its retry time", hm(detectLimit("⬝⬝■■■■■■ Free usage exceeded, subscribe to Go [retrying in 12h 44m attempt #1]", now)?.until) === "9 2:44");

// Refusals: waiting won't help.
check("Gemini's filter refusal", detectRefusal("> [HQ] Cipher assigned you B1-T01\n  This request was blocked by Gemini's filters. They can occasionally trigger by mistake")?.why === "Gemini's safety filter refused the request");
check("Claude's safeguards", /Claude's safeguards/.test(detectRefusal("● Opus 5.5's safeguards flagged this session. You may be seeing this for the first time")?.why ?? ""));
check("a withdrawn model names the replacement", detectRefusal("  ┃  Model glm-5.3-flash-free has been deprecated. Use deepseek-v4.1-flash-free instead.")?.why.includes("deepseek-v4.1-flash-free") === true);
check("a refusal isn't a usage limit", detectLimit("This request was blocked by Gemini's filters.", now) === null);
check("an agent writing about safeguards in code isn't refused", detectRefusal("  // input safeguards for the form\n  const safeguards = []") === null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
