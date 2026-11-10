// The isometric office: a baked floor, depth-sorted sprites for walls and
// furniture, and one animated robot per agent driven by its live status
// (see behaviour.ts). Reads the stores, writes only UI state (hover, drawer)
// through the ui actions.

import { Application, Container, Graphics, Sprite, TextureStyle, type Texture } from "pixi.js";
import type { OfficeSnapshot } from "../../data/types";
import { useOffice } from "../../store/office";
import { useUi, type FocusTarget } from "../../store/ui";
import { drawSelection } from "../draw/overlay";
import { Camera } from "../engine/camera";
import { GfxPen, makeCanvas } from "../engine/pen";
import { canvasTexture } from "../engine/textures";
import type { PxRect } from "../layout/layout";
import { attachInput, inside, type Target } from "../sceneInput";
import { buildFloor, ITEM_TOP, itemCanvas, itemKey } from "./art";
import { canHuddle, IsoBot, modeOf, seatOf, update, type Mode } from "./behaviour";
import { EventDiff, SEVERITY_COLOR, type IsoEvent } from "./events";
import { Fx } from "./fx";
import { demoSnapshot, wantsDemo } from "./demo";
import { generateIsoLayout, isoLayoutKey, type IsoLayout, type Item } from "./layout";
import type { Tile } from "../engine/path";
import { depth, toScreen } from "./proj";
import { bubbleCanvas, frameKey, ISO_ROBOT_W, isoRobotFrames, type Pose } from "./robots";

TextureStyle.defaultOptions.scaleMode = "nearest";

interface Robot {
  bot: IsoBot;
  color: string;
  sprite: Sprite;
  shadow: Sprite;
  bubble: Sprite;
  desk: { sprite: Sprite; item: Item } | null;
  rect: PxRect; // world px, for hit-testing
  seed: number;
}

const SEAT_LIFT = 7; // px a seated robot rises onto its chair
const DIM = 0x8d98ad;

export class IsoScene {
  app = new Application();
  world = new Container();
  items = new Container({ sortableChildren: true });
  camera!: Camera;
  layout: IsoLayout | null = null;
  robots = new Map<string, Robot>();
  modes = new Map<string, Mode>();
  hover: { rect: PxRect; agentId: string | null } | null = null;
  /** Ticker CPU time per frame (ms); read as `__hqScene.perf` in dev. */
  perf = { frames: 0, total: 0, max: 0 };
  private floor: Sprite | null = null;
  private gOver = new Graphics();
  private textures = new Map<string, Texture>();
  private t = 0;
  private epoch = -1;
  private seenMessages = new Set<string>();
  private visits: string[] = []; // agents the lead should walk over to, in order
  private demo = wantsDemo();
  private rand = Math.random;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private cleanups: (() => void)[] = [];
  private events = new EventDiff();
  private fx = new Fx(() => this.reducedMotion);
  private cheerUntil = new Map<string, number>();
  private screens: Sprite[] = []; // SOC screen wall slices, for finding flashes
  private demoT = 3;
  private demoStep = 0;
  private destroyed = false;

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, background: "#070910", antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1, roundPixels: true });
    if (this.destroyed) return void this.app.destroy(true);
    host.appendChild(this.app.canvas);
    this.app.canvas.style.imageRendering = "pixelated";
    this.world.addChild(this.items, this.fx.layer, this.gOver);
    this.app.stage.addChild(this.world);
    this.camera = new Camera(
      this.world,
      () => ({ w: this.app.screen.width, h: this.app.screen.height }),
      () => ({ left: 312, top: 74, bottom: 16, right: useUi.getState().drawer ? 552 : 16 }),
      () => this.reducedMotion,
    );
    this.sync();
    this.cleanups.push(useOffice.subscribe((s, prev) => (s.snap !== prev.snap || s.epoch !== prev.epoch) && this.sync()));
    this.cleanups.push(
      useUi.subscribe((s, prev) => {
        if (s.focus && s.focus !== prev.focus) this.focusOn(s.focus.target);
        if (s.zoomRequest && s.zoomRequest !== prev.zoomRequest) this.camera.zoomBy(s.zoomRequest.delta);
      }),
    );
    this.cleanups.push(attachInput(this));
    this.app.renderer.on("resize", () => this.camera.apply());
    this.app.ticker.add((tk) => {
      const t0 = performance.now();
      const dt = Math.min(0.1, tk.deltaMS / 1000);
      this.t += dt;
      this.camera.update(dt);
      this.tick(dt);
      this.gOver.clear();
      if (this.hover) drawSelection(new GfxPen(this.gOver), this.hover.rect, this.t);
      const ms = performance.now() - t0;
      this.perf.frames++;
      this.perf.total += ms;
      this.perf.max = Math.max(this.perf.max, ms);
    });
    if (import.meta.env.DEV) Object.assign(window, { __hqScene: this, __hqStore: useOffice });
  }

  destroy() {
    this.destroyed = true;
    this.cleanups.forEach((fn) => fn());
    if (this.app.renderer) this.app.destroy(true, { children: true, texture: true });
  }

  private snapshot(): OfficeSnapshot | null {
    const snap = useOffice.getState().snap;
    return snap && this.demo ? demoSnapshot(snap) : snap;
  }

  private sync() {
    const snap = this.snapshot();
    if (!snap) return;
    const { team, project } = snap.config;
    const { epoch } = useOffice.getState();
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.seenMessages.clear();
      this.events.reset();
      this.cheerUntil.clear();
      this.visits = [];
      this.layout = null;
    }
    const first = !this.layout;
    if (this.layout?.key !== isoLayoutKey(team, project.type)) this.rebuild(generateIsoLayout(team, project.type));
    const l = this.layout as IsoLayout;
    const lead = team.find((a) => a.isLead);

    const prev = this.modes;
    this.modes = new Map();
    for (const a of team) {
      const r = this.robots.get(a.id) as Robot;
      const mode = modeOf(snap.agents.find((s) => s.agentId === a.id));
      this.modes.set(a.id, mode);
      r.color = a.color;
      if (first) {
        // First sight: everyone is already at their desk, except an agent that is just starting (at the door).
        r.bot.mode = mode;
        r.bot.place(mode === "starting" ? l.door : (seatOf(l, a.id) ?? l.door));
        if (mode !== "starting") r.bot.facing = "ne";
      }
      // The lead comes over when someone needs the user or is stuck...
      if (!first && lead && a.id !== lead.id && (mode === "needs-input" || mode === "alert") && prev.get(a.id) !== mode) this.visits.push(a.id);
      this.setScreen(r, mode);
    }
    // ...or when the lead messages an agent.
    for (const m of [...snap.messages].reverse()) {
      if (this.seenMessages.has(m.id)) continue;
      this.seenMessages.add(m.id);
      if (first || !lead || m.fromId !== lead.id || m.toId === lead.id || !this.robots.has(m.toId)) continue;
      this.visits.push(m.toId);
    }
    for (const ev of this.events.next(snap)) this.play(ev);
  }

  /** Top-centre of a robot, in world px. */
  private head(id: string | null | undefined): { x: number; y: number } | null {
    const r = id ? this.robots.get(id) : undefined;
    return r && r.rect.w ? { x: r.rect.x + r.rect.w / 2, y: r.rect.y } : null;
  }

  private tileAt([x, y]: Tile, lift = 0) {
    const l = this.layout as IsoLayout;
    const s = toScreen(x + 0.5, y + 0.5);
    return { x: l.origin.x + s.x, y: l.origin.y + s.y - lift };
  }

  /** Middle of the SOC screen wall (or null without a SOC). */
  private socWall() {
    if (!this.screens.length) return null;
    const a = this.screens[0];
    const b = this.screens[this.screens.length - 1];
    return { x: (a.x + b.x + b.width) / 2, y: (a.y + b.y) / 2 + 22 }; // on the wall, just above the map
  }

  private leadId() {
    return [...this.robots.values()].find((r) => r.bot.isLead)?.bot.id ?? null;
  }

  play(ev: IsoEvent) {
    const l = this.layout;
    if (!l) return;
    const fx = this.fx;
    switch (ev.kind) {
      case "huddle": {
        // Everyone who is up gathers at the scrum board for a few seconds.
        const spots = [...l.spots.scrum];
        const scrum = l.zones.find((z) => z.kind === "scrum");
        if (scrum)
          for (let y = scrum.y0; y <= scrum.y1; y++)
            for (let x = scrum.x0; x <= scrum.x1; x++) if (l.grid.ok(x, y) && !spots.some(([sx, sy]) => sx === x && sy === y)) spots.push([x, y]);
        let i = 0;
        for (const [id, r] of this.robots) {
          if (!canHuddle(this.modes.get(id) ?? "stopped") || r.bot.visit || i >= spots.length) continue;
          Object.assign(r.bot, { huddle: spots[i++], huddleFor: 4.5, path: [], errand: null, pause: 0 });
        }
        if (scrum && i) fx.label("PLANNING", this.tileAt([Math.round((scrum.x0 + scrum.x1) / 2), scrum.y0], 30), "#E8B339");
        break;
      }
      case "cheer": {
        for (const [id] of this.robots) if (canHuddle(this.modes.get(id) ?? "stopped")) this.cheerUntil.set(id, this.t + 2.6);
        const at = this.head(ev.agentId) ?? this.head(this.leadId()) ?? this.tileAt([Math.floor(l.W / 2), Math.floor(l.H / 2)], 20);
        fx.confetti(at);
        fx.label(ev.label, { x: at.x, y: at.y - 14 }, "#E8B339");
        break;
      }
      case "plane": {
        const from = this.head(ev.from);
        const to = this.head(ev.to);
        if (!from || !to) break;
        fx.plane(from, to);
        if (ev.chat) fx.chat(() => this.head(ev.from));
        break;
      }
      case "parcel": {
        const from = this.head(ev.from);
        const leadSeat = seatOf(l, this.leadId() ?? "");
        if (!from || !leadSeat) break;
        const to = this.tileAt([leadSeat[0], leadSeat[1] - 1], 14); // onto the lead's desk
        fx.parcel(from, to, () => fx.label(`PR #${ev.num}`, { x: to.x, y: to.y - 22 }, "#F3EDE0"));
        break;
      }
      case "finding":
      case "refused": {
        const color = ev.kind === "finding" ? SEVERITY_COLOR[ev.severity] : "#ff3b3b";
        const text = ev.kind === "finding" ? `${ev.id} ${ev.severity.toUpperCase()}` : "OUT OF SCOPE";
        const wall = this.socWall();
        if (wall) fx.flash(this.screens, color, ev.kind === "refused" ? 4 : 3);
        const at = wall ?? this.head(ev.agentId);
        if (at) fx.label(text, { x: at.x, y: at.y - 12 }, color, 2.4);
        break;
      }
      case "report": {
        const at = this.head(this.leadId()) ?? this.socWall();
        if (!at) break;
        fx.confetti(at, 18);
        fx.label("REPORT READY", { x: at.x, y: at.y - 14 }, "#22D3EE", 2.6);
        break;
      }
    }
  }

  /** `?officeDemo=1`: replay one of each moment in turn so all of them can be seen and recorded. */
  private demoTick(dt: number) {
    if ((this.demoT -= dt) > 0 || !this.layout) return;
    const ids = [...this.robots.keys()];
    const lead = this.leadId();
    const workers = ids.filter((id) => id !== lead);
    const up = workers.filter((id) => canHuddle(this.modes.get(id) ?? "stopped"));
    const [a, b] = [up[0] ?? workers[0], up[1] ?? workers[1]];
    const script: IsoEvent[] = [
      { kind: "huddle" },
      { kind: "plane", from: lead ?? a, to: a, chat: false },
      { kind: "plane", from: a, to: b, chat: true },
      { kind: "parcel", from: a, num: 14 },
      { kind: "cheer", agentId: a, label: "MERGED" },
      ...(this.screens.length
        ? ([
            { kind: "finding", id: "F-006", severity: "high", agentId: a },
            { kind: "refused", agentId: a },
            { kind: "report" },
          ] as IsoEvent[])
        : []),
    ];
    this.play(script[this.demoStep++ % script.length]);
    this.demoT = script[(this.demoStep - 1) % script.length].kind === "huddle" ? 8 : 3.5;
  }

  /** Monitor off for a stopped agent, bright for a working one. */
  private setScreen(r: Robot, mode: Mode) {
    if (!r.desk) return;
    const screen = mode === "stopped" ? "off" : mode === "working" || mode === "cheer" ? "glow" : undefined;
    const item: Item = { ...r.desk.item, ...(screen ? { screen } : {}) };
    r.desk.sprite.texture = this.texture(itemKey(item), () => itemCanvas(item));
  }

  private rebuild(l: IsoLayout) {
    const first = !this.layout;
    this.layout = l;
    this.items.removeChildren().forEach((ch) => ch.destroy());
    this.screens = [];
    this.robots.clear();
    const floorTex = canvasTexture(buildFloor(l));
    if (this.floor) {
      this.floor.texture.destroy(true);
      this.floor.texture = floorTex;
    } else this.floor = this.world.addChildAt(new Sprite(floorTex), 0);
    this.camera.setWorldSize(l.worldW, l.worldH);

    const desks = new Map<string, { sprite: Sprite; item: Item }>();
    for (const it of l.items) {
      const s = new Sprite(this.texture(itemKey(it), () => itemCanvas(it)));
      const at = toScreen(it.x, it.y);
      s.position.set(l.origin.x + at.x - 16, l.origin.y + at.y - ITEM_TOP);
      s.zIndex = depth(it.x + 0.5, it.y + 0.5);
      this.items.addChild(s);
      if (it.decal === "screen") this.screens.push(s);
      if (it.kind === "desk" && it.i === 0) desks.set(`${it.x},${it.y}`, { sprite: s, item: it });
    }
    const shadowTex = this.texture("shadow", () => {
      const c = makeCanvas(12, 6);
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.beginPath();
      g.ellipse(6, 3, 6, 3, 0, 0, Math.PI * 2);
      g.fill();
      return c;
    });
    (this.snapshot()?.config.team ?? []).forEach((a, i) => {
      const seat = seatOf(l, a.id) ?? l.door;
      const sprite = new Sprite();
      const shadow = new Sprite(shadowTex);
      const bubble = new Sprite();
      bubble.visible = false;
      this.items.addChild(shadow, sprite, bubble);
      this.robots.set(a.id, {
        bot: new IsoBot(a.id, a.isLead, seat), color: a.color, sprite, shadow, bubble,
        desk: desks.get(`${seat[0]},${seat[1] - 1}`) ?? null, rect: { x: 0, y: 0, w: 0, h: 0 }, seed: i * 3,
      });
    });
    this.modes.clear();
    if (first) this.camera.home(false);
  }

  private tick(dt: number) {
    const l = this.layout;
    if (!l) return;
    const still = this.reducedMotion;
    const t = still ? 0 : this.t;
    this.fx.update(dt);
    if (this.demo) this.demoTick(dt);
    const lead = [...this.robots.values()].find((r) => r.bot.isLead);
    if (lead && !still && !lead.bot.visit && !lead.bot.moving && lead.bot.errand === null) {
      if (this.visits.length) lead.bot.visit = this.visits.shift() ?? null;
      else if (this.demo && lead.bot.pause <= 0) {
        // Demo: the lead keeps doing its rounds to whoever needs it.
        this.visits = [...this.modes].filter(([, m]) => m === "needs-input" || m === "alert").map(([id]) => id);
        lead.bot.pause = 5;
      }
    }

    for (const [id, r] of this.robots) {
      const mode = this.modes.get(id) ?? "stopped";
      const { bot } = r;
      update(bot, l, mode, dt, this.rand, still);
      const seat = seatOf(l, id);
      const seated = !!seat && bot.at(seat) && bot.facing === "ne";

      let pose: Pose = seated ? "sit" : "stand";
      if (bot.moving) pose = "walk";
      else if (mode === "cheer" || (canHuddle(mode) && (this.cheerUntil.get(id) ?? 0) > this.t)) pose = "cheer";
      else if (mode === "alert") pose = "alert";
      // Only a working agent types; anyone else at a desk just sits, and one with something to say turns to the room.
      const facing = seated && (mode === "needs-input" || mode === "alert" || pose === "cheer") ? "sw" : bot.facing;
      const frame = pose === "sit" && mode !== "working" ? `${facing}.sit0` : frameKey(facing, pose, t, r.seed);
      r.sprite.texture = this.texture(`robot|${r.color}|${bot.isLead}|${frame}`, () => isoRobotFrames(r.color, bot.isLead)[frame]);

      const s = toScreen(bot.x, bot.y);
      const x = Math.round(l.origin.x + s.x - ISO_ROBOT_W / 2);
      const y = Math.round(l.origin.y + s.y - r.sprite.texture.height - (seated ? SEAT_LIFT : 0) + 2);
      r.sprite.position.set(x, y);
      r.sprite.zIndex = depth(bot.x, bot.y, 2);
      r.sprite.alpha = mode === "stopped" ? 0.55 : 1;
      r.sprite.tint = mode === "stopped" ? DIM : 0xffffff;
      r.shadow.position.set(Math.round(l.origin.x + s.x - 6), Math.round(l.origin.y + s.y - 1));
      r.shadow.zIndex = depth(bot.x, bot.y, 1);
      r.shadow.visible = !seated;
      r.rect = { x, y, w: ISO_ROBOT_W, h: r.sprite.texture.height };

      const glyph = mode === "needs-input" ? "?" : mode === "alert" ? "!" : null;
      r.bubble.visible = !!glyph && (glyph === "?" || still || Math.floor(t * 3) % 2 === 0);
      if (glyph) {
        r.bubble.texture = this.texture(`bubble|${glyph}`, () => bubbleCanvas(glyph));
        r.bubble.position.set(x + 3, y - 12 - (glyph === "?" && !still ? Math.floor(t * 2) % 2 : 0));
        r.bubble.zIndex = depth(bot.x, bot.y, 3);
      }
      if (this.hover?.agentId === id) this.hover.rect = r.rect;
    }
  }

  private texture(key: string, make: () => HTMLCanvasElement): Texture {
    let tex = this.textures.get(key);
    if (!tex) this.textures.set(key, (tex = canvasTexture(make())));
    return tex;
  }

  hitTest(sx: number, sy: number): Target | null {
    const { x, y } = this.camera.screenToWorld(sx, sy);
    const robots = [...this.robots].sort((a, b) => b[1].sprite.zIndex - a[1].sprite.zIndex);
    for (const [id, r] of robots) if (inside(r.rect, x, y)) return { hit: { kind: "agent", id, rect: r.rect }, rect: r.rect };
    return null;
  }

  focusOn(target: FocusTarget) {
    if (target.kind === "home") return this.camera.home();
    if (target.kind !== "agent") return;
    const r = this.robots.get(target.id);
    if (r) this.camera.flyTo(r.rect.x + r.rect.w / 2, r.rect.y + r.rect.h / 2, Math.max(this.camera.zoom, Math.min(4, this.camera.fitZoom() + 1)));
  }
}
