// Records the product site's screenshots and demo videos from the built-in demo (sample data, nothing real runs).
// Needs: the demo UI running (`HQ_PORT=59999 pnpm exec vite --port 5178 --strictPort`), google-chrome and ffmpeg.
// Run: node scripts/site-media.mjs [--only shots|videos|phone] [--url http://localhost:5178/?mock=1]
// Writes site/assets/shots/*.webp and site/assets/video/{demo,demo-red}.{mp4,webm} plus posters.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const URL = arg("url", "http://localhost:5178/?mock=1");
const ONLY = arg("only", "all");
const SHOTS = "site/assets/shots";
const VIDEO = "site/assets/video";
const W = 1600;
const H = 1000;
const PORT = 9244;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(VIDEO, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "arima-media-"));

// ------------------------------------------------------------ Chrome over the DevTools protocol

const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, "profile")}`, `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((x) => x.type === "page");
      if (page?.webSocketDebuggerUrl) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = await connect();
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = new Set();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) for (const fn of listeners) fn(msg);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable");
await send("Runtime.enable");

async function viewport(width, height, mobile = false) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}

async function load(url = URL) {
  await send("Page.navigate", { url });
  await sleep(3500);
  await js(`(${injectCursor.toString()})()`);
}

// A visible pointer for the videos: a soft ring that glides to what gets clicked.
function injectCursor() {
  if (document.getElementById("demo-cursor")) return;
  const c = document.createElement("div");
  c.id = "demo-cursor";
  Object.assign(c.style, { position: "fixed", left: "800px", top: "500px", width: "22px", height: "22px", margin: "-11px 0 0 -11px", borderRadius: "50%", border: "2px solid rgba(37,99,235,.9)", background: "rgba(37,99,235,.18)", zIndex: 99999, pointerEvents: "none", transition: "left .55s cubic-bezier(.3,0,.2,1), top .55s cubic-bezier(.3,0,.2,1), transform .15s" });
  document.body.appendChild(c);
}

/** Moves the pointer to the first element matching `pick` (a JS expression returning an element), then clicks it. */
async function click(pick, { pause = 700 } = {}) {
  const ok = await js(`(async () => {
    const el = (${pick});
    if (!el) return false;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const c = document.getElementById("demo-cursor");
    if (c) { c.style.left = (r.left + r.width / 2) + "px"; c.style.top = (r.top + r.height / 2) + "px"; }
    await new Promise((res) => setTimeout(res, 600));
    if (c) { c.style.transform = "scale(.7)"; setTimeout(() => (c.style.transform = ""), 160); }
    el.focus?.();
    el.click();
    return true;
  })()`);
  if (!ok) console.warn(`  (nothing to click for ${pick.slice(0, 80)})`);
  await sleep(pause);
}

const rail = (label) => `document.querySelector('nav button[aria-label^="${label}"]')`;
const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;
const KEYS = { Tab: 9, Enter: 13, Escape: 27, j: 74, k: 75, a: 65, r: 82 };
/** A real key press, sent to whatever has focus (so a text box's own handlers see it). */
async function key(k) {
  const code = KEYS[k] ?? k.toUpperCase().charCodeAt(0);
  const text = k.length === 1 ? k : k === "Enter" ? "\r" : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code });
}
async function typeInto(selector, text) {
  for (const ch of text) {
    await send("Input.insertText", { text: ch });
    await sleep(45);
  }
  void selector;
}
async function preset(prefix) {
  await click(`document.querySelector('button[title="Switch, create or manage projects"]')`, { pause: 900 });
  await click(button(prefix), { pause: 900 });
  await click(`document.querySelector('[aria-label="Side panel"] button[aria-label="Close"]')`, { pause: 1200 });
}

async function shot(name) {
  await js(`(() => { const c = document.getElementById("demo-cursor"); if (c) c.style.display = "none"; })()`);
  await sleep(500);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const png = join(work, `${name}.png`);
  writeFileSync(png, Buffer.from(data, "base64"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-c:v", "libwebp", "-quality", "86", join(SHOTS, `${name}.webp`)]);
  await js(`(() => { const c = document.getElementById("demo-cursor"); if (c) c.style.display = ""; })()`);
  console.log(`  shot ${name}.webp`);
}

// ------------------------------------------------------------ screencast → mp4 / webm

async function record(name, script) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const onFrame = async (msg) => {
    if (msg.method !== "Page.screencastFrame") return;
    const { data, metadata, sessionId } = msg.params;
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    void send("Page.screencastFrameAck", { sessionId });
  };
  listeners.add(onFrame);
  await send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await script();
  await sleep(800);
  await send("Page.stopScreencast");
  listeners.delete(onFrame);
  // Frames arrive only when the page changes: give each the time until the next one.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, ((frames[i + 1]?.t ?? f.t + 0.5) - f.t)).toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`;
  const concat = join(dir, "frames.txt");
  writeFileSync(concat, list);
  const vf = `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-movflags", "+faststart", join(VIDEO, `${name}.mp4`)]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-vf", vf, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", join(VIDEO, `${name}.webm`)]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1.5", "-i", join(VIDEO, `${name}.mp4`), "-frames:v", "1", "-q:v", "3", join(VIDEO, `${name}-poster.jpg`)]);
  console.log(`  video ${name} (${frames.length} frames, ${((frames.at(-1).t - frames[0].t) || 0).toFixed(1)} s)`);
}

// ------------------------------------------------------------ what to capture

async function shots() {
  console.log("Screenshots");
  await viewport(W, H);
  await load();
  await shot("home");
  for (const [label, name] of [["Chat", "chat"], ["Board", "board"], ["Inbox", "inbox"], ["Agents", "agents"], ["Goals", "goals"], ["Flow", "flow"], ["Usage", "usage"]]) {
    await click(rail(label), { pause: 1400 });
    await shot(name);
  }
  await click(rail("PRs"), { pause: 1200 });
  await click(`document.querySelectorAll('nav[aria-label="Pull request lists"] button')[1]`, { pause: 900 });
  await shot("prs");
  await click(`document.querySelector('button[aria-label="Settings"]')`, { pause: 1200 });
  await shot("settings");
  await click(button("Done"), { pause: 800 });
  await click(rail("Grid"), { pause: 1600 });
  await shot("command");
  await click(button("← Home"), { pause: 1200 });

  await preset("RedCell");
  await shot("red-home");
  await click(rail("Findings"), { pause: 1400 });
  await shot("findings");
  await click(`document.querySelector('tbody tr')`, { pause: 1000 });
  await shot("finding");
  await key("Escape");
  await click(rail("Board"), { pause: 1400 });
  await shot("red-board");

  await phone();
}

async function phone() {
  await js("localStorage.clear(); sessionStorage.clear()"); // the Grid view is remembered; the phone shot starts at Home
  await viewport(390, 844, true);
  await load();
  await shot("phone-home");
  await viewport(W, H);
}

async function videos() {
  console.log("Videos");
  await js("localStorage.clear(); sessionStorage.clear()");
  await viewport(W, H);
  await load();
  await record("demo", async () => {
    await sleep(3500); // the team at work on Home
    await click(rail("Chat"), { pause: 1500 });
    await click(`document.querySelector('textarea')`, { pause: 300 });
    await typeInto("textarea", "Can you add rate limits to the upload route? @Gh");
    await sleep(500);
    await key("Tab");
    await sleep(900);
    await click(button("Send to"), { pause: 1600 });
    await click(rail("Board"), { pause: 1600 });
    await click(`[...document.querySelectorAll('button[aria-label$=": open"]')][1]`, { pause: 2200 });
    await key("Escape");
    await sleep(600);
    await click(rail("Inbox"), { pause: 1800 });
    await js("document.activeElement?.blur()");
    await key("j");
    await sleep(1200);
    await key("a");
    await sleep(1500);
    await click(rail("Agents"), { pause: 2000 });
    await click(rail("PRs"), { pause: 1200 });
    await click(`document.querySelectorAll('nav[aria-label="Pull request lists"] button')[1]`, { pause: 1800 });
    await click(rail("Usage"), { pause: 2200 });
    await click(rail("Home"), { pause: 2500 });
  });

  await load();
  await preset("RedCell");
  await record("demo-red", async () => {
    await sleep(3000);
    await click(rail("Findings"), { pause: 1800 });
    await click(`[...document.querySelectorAll('[aria-label="Filter by severity"] button')][0]`, { pause: 1300 });
    await click(`[...document.querySelectorAll('[aria-label="Filter by severity"] button')][0]`, { pause: 900 });
    await click(`document.querySelector('tbody tr')`, { pause: 2600 });
    await js(`document.querySelector('[role=dialog] .scroll-thin')?.scrollBy({ top: 400, behavior: "smooth" })`);
    await sleep(1800);
    await key("Escape");
    await sleep(700);
    await click(button("Scope"), { pause: 2200 });
    await key("Escape");
    await sleep(700);
    await click(button("Export report"), { pause: 2000 });
    await click(rail("Board"), { pause: 2000 });
    await click(rail("Home"), { pause: 2500 });
  });
}

try {
  if (ONLY === "all" || ONLY === "shots") await shots();
  if (ONLY === "all" || ONLY === "videos") await videos();
  if (ONLY === "phone") await phone();
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
console.log("Done.");
