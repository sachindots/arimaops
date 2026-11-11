// The sign-in link found in terminal output. Run: npx tsx scripts/links-test.ts
import { lastLink } from "../src/ui/drawers/links";

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
  if (!ok) fails++;
};

const long = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c&scope=org%3Acreate_api_key+user%3Aprofile&state=4Vwwb11cMFT8DLYDGLsb";
check("one line", lastLink(`Browser didn't open? Use the url below:\r\n\r\n${long}\r\n\r\nPaste code here if prompted >`), long);
check("cut into lines by a narrow screen", lastLink(`Use the url below:\r\n\r\n ${long.slice(0, 50)}\r\n${long.slice(50, 100)}\r\n${long.slice(100)}\r\n\r\n Paste code here if prompted >`), long);
check("colours and cursor moves removed", lastLink(`\x1b[2m\x1b[1;1H${long.slice(0, 60)}\x1b[0m\r\n\x1b[2m${long.slice(60)}\x1b[0m\r\n`), long);
check("the last link wins", lastLink("old https://example.com/a\r\nnew https://example.com/b\r\n"), "https://example.com/b");
check("trailing full stop dropped", lastLink("Open https://github.com/login/device."), "https://github.com/login/device");
check("next line with words is not joined", lastLink("Go to https://github.com/login/device\r\nand enter ABCD-1234\r\n"), "https://github.com/login/device");
check("OSC 8 link when no plain one", lastLink("\x1b]8;;https://example.com/x\x07click\x1b]8;;\x07"), "https://example.com/x");
const nested = "https://claude.ai/oauth/authorize?redirect_uri=https://console.anthropic.com/oauth/code/callback&state=x";
check("a link inside another link's query", lastLink(`Use the url below:\r\n${nested}\r\n\r\nPaste code >`), nested);
check("an encoded link inside the query", lastLink(`url:\r\n${long}&redirect_uri=https%3A%2F%2Fconsole.anthropic.com\r\n`), `${long}&redirect_uri=https%3A%2F%2Fconsole.anthropic.com`);
check("no link", lastLink("$ docker run hello\r\nDone\r\n"), null);
check("not a web link", lastLink("file:///etc/passwd and javascript:alert(1)"), null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
