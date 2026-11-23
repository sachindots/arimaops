// Records the product tour video and the README loop.
//   Part A: a fresh Rust HQ, first run: boot screen, team, how agents sign in, Docker check, the first agent starting.
//   Part B: the built-in demo (sample data, nothing real runs): the team at work, chat, board, inbox, usage.
// Needs: HQ built (`cargo build --release -p arima-server`) and running on a fresh ARIMA_HOME, `pnpm exec vite build`,
// `vite preview --port 5178` for the demo, google-chrome and ffmpeg.
// Run: node scripts/site-tour.mjs --live http://127.0.0.1:7621 --token <start-up token> --demo "http://127.0.0.1:5178/?mock=1"
// Writes site/assets/video/{tour,loop}.{mp4,webm}, tour-poster.jpg and loop.webp.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const LIVE = arg("live", "http://127.0.0.1:7621");
const TOKEN = arg("token", "");
const DEMO = arg("demo", "http://127.0.0.1:5178/?mock=1");
const VIDEO = "site/assets/video";
const W = 1600;
const H = 1000;
const PORT = 9246;
mkdirSync(VIDEO, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "arima-tour-"));
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
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

// ------------------------------------------------------------ on-page helpers: pointer, captions, title card

function overlays() {
  if (document.getElementById("demo-cursor")) return;
  const c = document.createElement("div");
  c.id = "demo-cursor";
  Object.assign(c.style, { position: "fixed", left: "800px", top: "500px", width: "22px", height: "22px", margin: "-11px 0 0 -11px", borderRadius: "50%", border: "2px solid rgba(34,184,207,.95)", background: "rgba(34,184,207,.2)", zIndex: 99999, pointerEvents: "none", transition: "left .55s cubic-bezier(.3,0,.2,1), top .55s cubic-bezier(.3,0,.2,1), transform .15s" });
  document.body.appendChild(c);
  const cap = document.createElement("div");
  cap.id = "demo-cap";
  Object.assign(cap.style, { position: "fixed", left: "50%", bottom: "46px", transform: "translateX(-50%) translateY(10px)", opacity: "0", padding: "10px 20px", borderRadius: "999px", background: "rgba(6,10,20,.9)", color: "#f1f5f9", font: "600 18px Inter, system-ui, sans-serif", border: "1px solid rgba(34,184,207,.55)", boxShadow: "0 10px 34px rgba(0,0,0,.45)", zIndex: 100000, transition: "opacity .35s, transform .35s", pointerEvents: "none", whiteSpace: "nowrap" });
  document.body.appendChild(cap);
}
const inject = () => js(`(${overlays.toString()})()`);
async function caption(text, hold = 2600) {
  await inject();
  await js(`(() => { const c = document.getElementById("demo-cap"); c.textContent = ${JSON.stringify(text)}; requestAnimationFrame(() => { c.style.opacity = "1"; c.style.transform = "translateX(-50%)"; }); })()`);
  await sleep(hold);
}
async function captionOff() {
  await js(`(() => { const c = document.getElementById("demo-cap"); if (c) { c.style.opacity = "0"; c.style.transform = "translateX(-50%) translateY(10px)"; } })()`);
  await sleep(400);
}
async function titleCard(title, sub, hold = 2200) {
  await js(`(() => {
    const d = document.createElement("div");
    d.id = "demo-title";
    Object.assign(d.style, { position: "fixed", inset: 0, zIndex: 100001, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px", background: "#060a14", color: "#f1f5f9", font: "600 56px Inter, system-ui, sans-serif", letterSpacing: "-.02em", opacity: 1, transition: "opacity .7s" });
    d.innerHTML = '<div>' + ${JSON.stringify(title)} + '</div><div style="font:400 22px Inter,system-ui,sans-serif;color:#94a3b8;letter-spacing:0">' + ${JSON.stringify(sub)} + '</div>';
    document.body.appendChild(d);
  })()`);
  await sleep(hold);
  await js(`(() => { const d = document.getElementById("demo-title"); if (d) { d.style.opacity = 0; setTimeout(() => d.remove(), 800); } })()`);
  await sleep(700);
}
async function badge(text) {
  await js(`(() => { document.getElementById("demo-badge")?.remove(); const b = document.createElement("div"); b.id = "demo-badge"; b.textContent = ${JSON.stringify(text)}; Object.assign(b.style, { position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", padding: "4px 12px", borderRadius: "999px", background: "rgba(245,158,11,.16)", color: "#fbbf24", border: "1px solid rgba(245,158,11,.5)", font: "600 13px Inter, system-ui, sans-serif", zIndex: 100000, pointerEvents: "none" }); document.body.appendChild(b); })()`);
}

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
  if (!ok) console.warn(`  (nothing to click for ${pick.slice(0, 90)})`);
  await sleep(pause);
}
const rail = (label) => `document.querySelector('nav button[aria-label^="${label}"]')`;
const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.includes(${JSON.stringify(text)}))`;
const KEYS = { Tab: 9, Enter: 13, Escape: 27, j: 74, k: 75, a: 65, r: 82 };
async function key(k) {
  const code = KEYS[k] ?? k.toUpperCase().charCodeAt(0);
  const text = k.length === 1 ? k : k === "Enter" ? "\r" : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code });
}
async function typeText(text) {
  for (const ch of text) {
    await send("Input.insertText", { text: ch });
    await sleep(45);
  }
}
async function go(url, settle = 3200) {
  await send("Page.navigate", { url });
  await sleep(settle);
  await inject();
}

// ------------------------------------------------------------ screencast -> mp4 / webm

const parts = [];
const chapters = [];
const seg = { start: 0, offset: 0 };
/** Notes where a scene starts, in seconds of the finished video, so the site can link to it. */
const mark = (label) => chapters.push([label, +((Date.now() - seg.start) / 1000 + seg.offset).toFixed(1)]);
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
  seg.start = Date.now();
  await send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await script();
  await sleep(800);
  await send("Page.stopScreencast");
  listeners.delete(onFrame);
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, (frames[i + 1]?.t ?? f.t + 0.5) - f.t).toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`;
  const concat = join(dir, "frames.txt");
  writeFileSync(concat, list);
  const out = join(work, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-movflags", "+faststart", out]);
  parts.push(out);
  seg.offset += (frames.at(-1).t - frames[0].t) || 0;
  console.log(`  ${name}: ${frames.length} frames, ${((frames.at(-1).t - frames[0].t) || 0).toFixed(1)} s`);
  return out;
}

// ------------------------------------------------------------ Part A: first run on a real, fresh HQ

async function partA() {
  console.log("Part A: first run");
  await record("part-a", async () => {
    await send("Page.navigate", { url: `${LIVE}/?token=${TOKEN}` });
    await sleep(900);
    await inject();
    await titleCard("ArimaOps", "An AI team for every project. You stay in charge.", 2000);
    mark("First run");
    await caption("First run: pick the team you want", 2800);
    await captionOff();
    await click(button("Create team"), { pause: 1600 });
    mark("Sign in");
    await caption("Say how each agent signs in: your subscription, or an API key", 3400);
    await captionOff();
    await click(button("Next"), { pause: 1500 });
    mark("Ready check");
    await caption("ArimaOps checks that this machine can run agents", 3000);
    await captionOff();
    await click(button("Next"), { pause: 1500 });
    mark("Start the lead");
    await caption("Press Start. Cipher, the lead, runs in its own container", 2600);
    await captionOff();
    await click(`[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes("Start Cipher"))`, { pause: 5500 });
    await click(`[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Later")`, { pause: 900 }); // the owner sign-in prompt, not part of this story
    await caption("Its terminal opens right here", 2800);
    await captionOff();
  });
}

// ------------------------------------------------------------ Part B: the team at work (sample data)

async function partB() {
  console.log("Part B: the team at work");
  await go(DEMO, 3500);
  await record("part-b", async () => {
    await badge("Sample project: the built-in demo");
    mark("The team at work");
    await caption("Running agents glow and link to the core", 3600);
    await captionOff();
    await click(rail("Team"), { pause: 1500 });
    await click(`[...document.querySelectorAll("button")].find((b) => b.offsetParent && /forum\\s*Chat/.test(b.textContent))`, { pause: 1300 });
    mark("Chat");
    await caption("Talk to the lead, or any agent with @", 1500);
    await click(`document.querySelector('textarea')`, { pause: 300 });
    await typeText("Can you add rate limits to the upload route?");
    await sleep(500);
    await click(`[...document.querySelectorAll("button")].find((b) => b.offsetParent && b.textContent.trim() === "Ask")`, { pause: 1800 });
    await captionOff();
    await click(rail("Work"), { pause: 1700 });
    mark("Board");
    await caption("Every task has a spec, gates and a history", 1800);
    await click(`[...document.querySelectorAll('button[aria-label$=": open"]')][1]`, { pause: 2400 });
    await key("Escape");
    await captionOff();
    await click(rail("Inbox"), { pause: 1700 });
    mark("Inbox");
    await caption("Anything final waits for you. Approve with one key", 1500);
    await js("document.activeElement?.blur()");
    await key("j");
    await sleep(1100);
    await key("a");
    await sleep(1500);
    await captionOff();
    await click(rail("Team"), { pause: 1500 });
    await click(button("Agents"), { pause: 2200 });
    mark("Agents");
    await caption("Who runs on what, and what it costs today", 2200);
    await captionOff();
    await click(rail("Home"), { pause: 2400 });
    await titleCard("ArimaOps", "Free and open source  ·  arimaops.tech", 2200);
  });
}

async function loop() {
  console.log("Loop");
  await go(DEMO, 3200);
  return record("loop", async () => {
    await sleep(3600);
    await click(rail("Work"), { pause: 2200 });
    await click(rail("Inbox"), { pause: 1500 });
    await js("document.activeElement?.blur()");
    await key("j");
    await sleep(900);
    await key("a");
    await sleep(1400);
    await click(rail("Home"), { pause: 2800 });
  });
}

try {
  await partA();
  await partB();
  const listFile = join(work, "tour.txt");
  writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n"));
  const tour = join(VIDEO, "tour.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tour]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", tour, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", join(VIDEO, "tour.webm")]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "9", "-i", tour, "-frames:v", "1", "-q:v", "3", join(VIDEO, "tour-poster.jpg")]);
  parts.length = 0;
  const l = await loop();
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", l, "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-an", "-movflags", "+faststart", join(VIDEO, "loop.mp4")]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", l, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-an", join(VIDEO, "loop.webm")]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", l, "-vf", "fps=10,scale=800:-1:flags=lanczos", "-c:v", "libwebp", "-lossless", "0", "-quality", "50", "-loop", "0", join(VIDEO, "loop.webp")]);
  console.log("CHAPTERS " + JSON.stringify(chapters));
  console.log("Done.");
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
