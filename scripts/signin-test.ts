// Spotting a sign-in screen in terminal output. Run: npx tsx scripts/signin-test.ts
import { signInPrompt } from "../src/ui/drawers/signin";

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
  if (!ok) fails++;
};

const claude = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c&state=4Vww";
check("Claude Code: paste the code", signInPrompt(`Browser didn't open? Use the url below to sign in\r\n\r\n${claude}\r\n\r\nPaste code here if prompted >`), { link: claude, step: "paste" });
check("Codex: one-time code on a page", signInPrompt("Follow these steps to sign in with ChatGPT\r\n1. Open this link in your browser\r\n   https://auth.openai.com/codex/device\r\n2. Enter this one-time code\r\n   ABCD-12345\r\n"), { link: "https://auth.openai.com/codex/device", step: "device", code: "ABCD-12345" });
check("a sign-in link that finishes in the browser", signInPrompt("Please authenticate in your browser:\r\nhttps://accounts.google.com/o/oauth2/v2/auth?x=1\r\n"), { link: "https://accounts.google.com/o/oauth2/v2/auth?x=1", step: "browser" });
check("done once logged in", signInPrompt(`Use the url below to sign in\r\n${claude}\r\nPaste code here >\r\nLogged in as you@example.com\r\n`), null);
check("an ordinary link is not a sign-in", signInPrompt("See the docs at https://example.com/docs for details\r\n"), null);
check("no link", signInPrompt("Paste code here >"), null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
