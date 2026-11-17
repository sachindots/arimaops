// SPDX-License-Identifier: AGPL-3.0-or-later
// The skill scanner (docs/templates.md section 2). Every file of a skill pack, and every custom skill folder, is
// read before any agent gets it. A "block" finding refuses the whole skill; a "warn" is shown but allowed.
//
// Security skills legitimately quote payloads and shell commands, so text in Markdown is judged only on what is
// aimed at the agent itself (hidden characters, "ignore your instructions", "send the secrets", "don't tell the
// user"). Code that would run on its own (hooks, install scripts) or a script that pipes a download into a shell
// is blocked. Findings are reasons to refuse, never to "clean" a file.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface ScanFinding {
  path: string;
  line: number;
  level: "block" | "warn";
  rule: string;
  why: string;
}

const SCRIPT = /\.(sh|bash|zsh|ps1|py|js|mjs|cjs|ts|rb|pl)$/i;
const TEXT = /\.(md|mdx|txt|json|ya?ml|toml|sh|bash|zsh|ps1|py|js|mjs|cjs|ts|rb|pl|html?|xml|csv|ini|cfg|conf)$|(^|\/)[A-Z]+$/i;

/** Files that make a CLI run code on its own: hooks and package lifecycle scripts. */
const AUTORUN = [
  { test: /(^|\/)\.claude\/settings(\.local)?\.json$|(^|\/)hooks\.json$|(^|\/)\.codex\/config\.toml$/i, level: "block" as const, why: "a CLI settings or hooks file: it would run commands without asking" },
  { test: /(^|\/)(setup\.py|install\.sh|postinstall(\.[a-z]+)?)$/i, level: "warn" as const, why: "an install script: runs only if someone runs it, so read it before an agent does" },
];

const HIDDEN: [RegExp, string][] = [
  [/[\u{E0000}-\u{E007F}]/u, "Unicode tag characters: invisible text a model still reads"],
  [/[‪-‮⁦-⁩]/, "bidirectional control characters: text that displays differently from what it says"],
];
const ZERO_WIDTH = /[​-‍⁠﻿]/;

/** Text aimed at the agent reading the skill, not at the task. */
const AIMED: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|your\s+|the\s+)?(previous|prior|above|earlier|system|original)\s+(instructions?|prompts?|rules?|messages?)/i, "tells the agent to drop its instructions"],
  [/\b(do\s*n['o]?t|never|without)\s+(tell(ing)?|inform(ing)?|notify(ing)?|mention(ing)?|alert(ing)?|show(ing)?)\s+(the\s+)?(user|owner|human|operator)/i, "tells the agent to hide something from the user"],
  [/\b(send|post|upload|exfiltrate|forward|transmit|leak|copy)\b[^.\n]{0,80}\b(secrets?|credentials?|api[\s_-]?keys?|tokens?|passwords?|\.env\b|ssh\s+keys?|id_rsa|vault)\b[^\n]{0,80}\b(to|into)\b[^\n]{0,40}(https?:\/\/|webhook\.site|pastebin|discord|telegram|gist\.github|ngrok|requestbin|interact\.sh|burpcollaborator)/i, "tells the agent to send secrets somewhere"],
  [/\b(cat|read|open|print|dump)\b[^\n]{0,40}(~\/\.ssh\/|\/\.aws\/credentials|~\/\.arima\/|vault\.json|agent-token|\.claude\/\.credentials)/i, "reads the machine's keys, HQ's vault or token"],
];

const FETCH_RUN = /\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(curl|wget)\b[^\n]*\|\s*(python3?|node|perl|ruby)\b/i;
const DECODE_RUN = /\b(base64\s+(-d|--decode)|atob\(|b64decode\()[^\n]{0,120}(\|\s*(ba)?sh\b|\beval\b|\bexec\b)|\beval\s*\(\s*(atob|Buffer\.from)\(/i;
const UNPINNED = /\b(npx\s+(-y\s+)?[a-z@][\w./@-]*(?<!@\d[\w.-]*)(\s|$)|pip3?\s+install\s+(?!-r\b)(?![\w.-]+==)[a-z][\w.-]*(\s|$))/i;

/**
 * The prose of a line: inline code spans and quoted strings removed. Security skills quote attack strings ("ignore
 * previous instructions" as a payload to test); quoted, they describe an attack rather than give an order.
 */
const prose = (l: string) => l.replace(/`[^`]*`/g, " ").replace(/"[^"\n]*"|'[^'\n]{8,}'|“[^”]*”/g, " ");

/** Lines of `text` inside fenced code blocks (``` or ~~~), 1-based. */
function fencedLines(text: string): Set<number> {
  const inside = new Set<number>();
  let open = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) open = !open;
    else if (open) inside.add(i + 1);
  });
  return inside;
}

/** Scans one file. `path` is relative to the pack (or skill folder) root. */
export function scanFile(path: string, content: Buffer | string): ScanFinding[] {
  const out: ScanFinding[] = [];
  const add = (line: number, level: ScanFinding["level"], rule: string, why: string) => out.push({ path, line, level, rule, why });
  for (const a of AUTORUN) if (a.test.test(path)) add(0, a.level, "autorun", a.why);
  if (/(^|\/)package\.json$/i.test(path)) {
    try {
      const scripts = (JSON.parse(String(content)) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const k of ["preinstall", "install", "postinstall", "prepare"]) if (scripts[k]) add(0, "block", "autorun", `package.json runs "${k}" on install`);
    } catch {
      /* not JSON: judged as text below */
    }
  }
  if (!TEXT.test(path)) return out; // images, archives: hashed but not read
  const text = typeof content === "string" ? content : content.toString("utf8");
  const script = SCRIPT.test(path);
  const fenced = script ? new Set<number>() : fencedLines(text);
  text.split("\n").forEach((l, i) => {
    const n = i + 1;
    for (const [re, why] of HIDDEN) if (re.test(l)) add(n, "block", "hidden", why);
    if (ZERO_WIDTH.test(l) && !fenced.has(n)) add(n, "block", "hidden", "zero-width characters in prose");
    // An order in plain prose blocks; the same words quoted, in code or in a table row describe an attack: a warning.
    const plain = !fenced.has(n) && !/^\s*\|/.test(l);
    for (const [re, why] of AIMED) {
      if (plain && re.test(prose(l))) add(n, "block", "aimed-at-agent", why);
      else if (re.test(l)) add(n, "warn", "aimed-at-agent", `${why} (quoted or in code: read it)`);
    }
    if (FETCH_RUN.test(l)) add(n, script ? "block" : "warn", "fetch-and-run", "pipes a download into an interpreter");
    if (DECODE_RUN.test(l)) add(n, script ? "block" : "warn", "decode-and-run", "decodes hidden code and runs it");
    if (script && UNPINNED.test(l)) add(n, "warn", "unpinned-install", "installs a package without a fixed version");
  });
  return out;
}

/** Scans every file under a folder (a custom skill); links and huge trees are findings, not followed. */
export function scanFolder(root: string, limit = 2000): ScanFinding[] {
  const out: ScanFinding[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (out.length > limit) return;
      const full = join(dir, name);
      const rel = relative(root, full);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out.push({ path: rel, line: 0, level: "block", rule: "link", why: "a link: it could point anywhere on this machine" });
      else if (st.isDirectory()) walk(full);
      else if (st.size <= 2 * 1024 * 1024) out.push(...scanFile(rel, readFileSync(full)));
    }
  };
  walk(root);
  return out;
}

/** Scans many files; returns the findings and whether anything blocks. */
export function scanFiles(files: { path: string; content: Buffer | string }[]): { findings: ScanFinding[]; blocked: boolean } {
  const findings = files.flatMap((f) => scanFile(f.path, f.content));
  return { findings, blocked: findings.some((f) => f.level === "block") };
}

/** The skill a pack file belongs to: the folder holding its SKILL.md (`…/skills/<name>/…`), or null for pack-level files. */
export function skillOf(path: string, skillDirs: string[]): string | null {
  const dir = skillDirs.filter((d) => path === d || path.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
  return dir ?? null;
}
