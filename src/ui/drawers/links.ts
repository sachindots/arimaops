// The last web link a program printed to a terminal, whole, even when the terminal is too narrow to show it.
// Sign-in screens (Claude Code, Codex, Antigravity) print one long URL that a phone-width terminal cuts up.

const OSC_LINK = /\x1b\]8;[^;]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const URL_CHARS = /^[^\s"'<>`]+/;

export function lastLink(output: string): string | null {
  const tail = output.slice(-30_000);
  const text = tail
    .replace(/\x1b\[\d*C/g, " ") // cursor-forward: how full-screen CLIs draw a gap
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Z0-9]|\x1b[=>78]/g, "")
    .replace(/\r/g, "");
  // The last place a link starts: not a URL inside another link's query (redirect_uri=https://…).
  const at = [...text.matchAll(/(?:^|[\s"'(<])(https?:\/\/)/g)].pop();
  const osc = [...tail.matchAll(OSC_LINK)].pop()?.[1] ?? null;
  if (!at) return osc;
  // A URL wider than the screen comes out on several lines: join the lines that carry on without a space.
  const [first, ...rest] = text.slice(at.index + at[0].length - at[1].length).split("\n");
  let url = URL_CHARS.exec(first)?.[0] ?? "";
  if (url.length === first.trimEnd().length) {
    for (const line of rest) {
      const part = line.trim();
      if (!part || /\s/.test(part)) break;
      url += part;
    }
  }
  url = url.replace(/[).,;:!?]+$/, "");
  try {
    return new URL(url).protocol.startsWith("http") ? url : osc;
  } catch {
    return osc;
  }
}
