// Reading an agent's screen (server/screen.ts): busy, a question, a trust prompt, the input prompt, or no login.
// The samples are the last lines of each CLI's screen as HQ sees them. They catch a pattern edited by mistake;
// they can't catch a CLI that changes its own wording, so when one does, add its new screen here first.
//
//   npx tsx scripts/screen-test.ts

import { canType, readScreen, type Screen } from "../server/screen";

let failed = false;
const expect = (name: string, text: string, want: Partial<Screen> & { canType?: boolean }) => {
  const got = { ...readScreen(text), canType: canType(text) };
  const wrong = Object.entries(want).filter(([k, v]) => got[k as keyof typeof got] !== v);
  console.log(`${wrong.length ? "✗" : "✓"} ${name}${wrong.length ? `  ${wrong.map(([k]) => `${k}=${got[k as keyof typeof got]}`).join(" ")}` : ""}`);
  if (wrong.length) failed = true;
};

const SAMPLES: [string, string, Partial<Screen> & { canType?: boolean }][] = [
  // Claude Code
  ["Claude Code at its prompt", "╭──────────────────╮\n│ >                │\n╰──────────────────╯\n  ? for shortcuts", { ready: true, busy: false, dialog: false, canType: true }],
  ["Claude Code in accept-edits mode", "│ >                │\n  ⏵⏵ accept edits on (shift+tab to cycle)", { ready: true, canType: true }],
  ["Claude Code mid-turn", "✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)\n│ >                │\n  ? for shortcuts", { busy: true, canType: false }],
  ["Claude Code asking permission", "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently", { dialog: true, canType: false }],
  ["Claude Code's folder-trust prompt", "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\nEnter to confirm · Esc to exit", { dialog: true, canType: false }],
  ["Claude Code without a login", "Not logged in · Run /login\n│ >                │\n  ? for shortcuts", { noLogin: true }],
  ["an expired login", "API Error: 401 · Login expired · Please run /login", { noLogin: true }],
  // Codex
  ["Codex at its prompt", "▌ Ask Codex to do anything\n ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit", { ready: true, canType: true }],
  ["Codex mid-turn", "• Working (5s • esc to interrupt)\n▌ Ask Codex to do anything", { busy: true, canType: false }],
  ["Codex's folder-trust prompt", "Do you trust the contents of this directory?\n› 1. Yes, allow Codex to work in this folder\n  2. No, quit", { trust: true, dialog: true, canType: false }],
  ["Codex asking to run a command", "Run this command?\n  pnpm test\n› 1. Yes\n  2. No", { dialog: true, canType: false }],
  // Gemini, Antigravity, OpenCode
  ["Gemini at its prompt", "╭────────────────────────────────────────╮\n│ > Type your message or @path/to/file   │\n╰────────────────────────────────────────╯", { ready: true, canType: true }],
  ["Gemini mid-turn", "⠏ Reading files (esc to cancel, 3s)", { busy: true, canType: false }],
  ["Gemini's trust prompt", "Do you trust this folder?\n● 1. Trust folder\n  2. Don't trust", { trust: true, canType: false }],
  ["Antigravity's workspace trust", "Do you trust the contents of this project?\n  Yes, I trust this folder", { trust: true, canType: false }],
  ["OpenCode at its prompt", "  >\n  ctrl+p commands", { ready: true, canType: true }],
  // Edges
  ["an empty screen is never safe to type into", "", { canType: false, ready: false }],
  ["output that only mentions a menu isn't a question", "Listed steps:\n  1. build\n  2. test\n│ >                │\n  ? for shortcuts", { dialog: false, canType: true }],
];

for (const [name, text, want] of SAMPLES) expect(name, text, want);
process.exit(failed ? 1 : 0);
