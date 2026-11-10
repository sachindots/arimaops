// The isometric office: a baked floor, depth-sorted sprites for walls and
// furniture, and one animated robot per agent driven by its live status
// (see behaviour.ts). Reads the stores, writes only UI state (hover, drawer)
// through the ui actions.

import { Application, Container, Graphics, Sprite, TextureStyle, type Texture } from "pixi.js";
import type { AgentConfig, OfficeSnapshot } from "../../data/types";
import { followBuilding, useBuilding } from "../../store/building";
import { useOffice } from "../../store/office";
import { useUi, type FocusTarget } from "../../store/ui";
import { drawSelection } from "../draw/overlay";
import { Camera } from "../engine/camera";
import { text, textW } from "../engine/font";
import { CanvasPen, GfxPen, makeCanvas } from "../engine/pen";
import { canvasTexture } from "../engine/textures";
import type { PxRect } from "../layout/layout";
import { attachInput, inside, type Target } from "../sceneInput";
import { buildFloor, ITEM_TOP, itemCanvas, itemKey } from "./art";
import { canHuddle, IsoBot, modeOf, seatOf, update, type Mode } from "./behaviour";
import { EventDiff, SEVERITY_COLOR, type IsoEvent } from "./events";
import { Fx } from "./fx";
import { demoSnapshot, wantsDemo } from "./demo";
import { buildingKey, generateBuilding, remoteId, type Building, type Wing, type WingInput } from "./building";
import { doorOf, WALL_H, type Item } from "./layout";
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

interface WingData {
  project: string;
  name: string;
  current: boolean;
  snap: OfficeSnapshot;
}

/** Another project's snapshot with every agent, message and event id prefixed "<project>/". */
const nsCache = new WeakMap<OfficeSnapshot, OfficeSnapshot>();
function namespaced(snap: OfficeSnapshot, project: string): OfficeSnapshot {
  const hit = nsCache.get(snap);
  if (hit) return hit;
  const ns = (id: string) => remoteId(project, id);
  const out: OfficeSnapshot = {
    ...snap,
    config: { ...snap.config, team: snap.config.team.map((a) => ({ ...a, id: ns(a.id) })) },
    agents: snap.agents.map((a) => ({ ...a, agentId: ns(a.agentId) })),
    messages: snap.messages.map((m) => ({ ...m, id: ns(m.id), fromId: ns(m.fromId), toId: ns(m.toId) })),
    activity: snap.activity.map((e) => ({ ...e, id: ns(e.id), agentId: e.agentId && ns(e.agentId) })),
    pullRequests: snap.pullRequests.map((pr) => ({ ...pr, authorId: ns(pr.authorId) })),
    findings: (snap.findings ?? []).map((f) => ({ ...f, reporterId: ns(f.reporterId) })),
  };
  nsCache.set(snap, out);
  return out;
}

export interface IsoSceneOptions {
  /** Phone/tablet layout: no HUD panels around the canvas. */
  compact?: boolean;
}

const SEAT_LIFT = 7; // px a seated robot rises onto its chair
const DIM = 0x8d98ad;

export class IsoScene {
  app = new Application();
  world = new Container();
  items = new Container({ sortableChildren: true });
  camera!: Camera;
  layout: Building | null = null;
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
  private visits = new Map<string, string[]>(); // per lead: agents to walk over to, in order
  private demo = wantsDemo();
  private rand = Math.random;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private cleanups: (() => void)[] = [];
  private diffs = new Map<string, EventDiff>(); // per project
  private fx = new Fx(() => this.reducedMotion);
  private cheerUntil = new Map<string, number>();
  private screens: { sprite: Sprite; x: number }[] = []; // SOC screen wall slices (tile x), for finding flashes
  private banners = new Container();

  constructor(private opts: IsoSceneOptions = {}) {}

  private insets = () => (this.opts.compact ? { left: 8, top: 8, bottom: 8, right: 8 } : { left: 312, top: 74, bottom: 16, right: useUi.getState().drawer ? 552 : 16 });

  /** The whole building when it fits; otherwise the wing you're viewing (zoom never drops below 1, to keep pixels crisp). */
  private home(animate = true) {
    const l = this.layout;
    const wing = this.currentWing;
    const z = this.camera.fitZoom();
    const i = this.insets();
    const fits = (this.app.screen.width - i.left - i.right) / z >= (l?.worldW ?? 0) && (this.app.screen.height - i.top - i.bottom) / z >= (l?.worldH ?? 0);
    if (!l || !wing || l.wings.length < 2 || fits) return this.camera.home(animate);
    const c = this.tileAt([(wing.x0 + wing.x1) / 2, l.H / 2]);
    this.camera.flyTo(c.x, c.y - 20, z, animate);
  }
  private demoT = 3;
  private demoStep = 0;
  private destroyed = false;

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, background: "#070910", antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1, roundPixels: true });
    if (this.destroyed) return void this.app.destroy(true);
    host.appendChild(this.app.canvas);
    this.app.canvas.style.imageRendering = "pixelated";
    this.world.addChild(this.items, this.banners, this.fx.layer, this.gOver);
    this.app.stage.addChild(this.world);
    this.camera = new Camera(
      this.world,
      () => ({ w: this.app.screen.width, h: this.app.screen.height }),
      this.insets,
      () => this.reducedMotion,
    );
    this.sync();
    this.cleanups.push(useOffice.subscribe((s, prev) => (s.snap !== prev.snap || s.epoch !== prev.epoch) && this.sync()));
    this.cleanups.push(useBuilding.subscribe(() => this.sync()));
    this.cleanups.push(followBuilding());
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

  /** The current project first, then every other running project with a team. */
  private wingsData(): WingData[] {
    const cur = this.snapshot();
    if (!cur) return [];
    const p = cur.config.project;
    const out: WingData[] = [{ project: p.id, name: p.officeName || p.name, current: true, snap: cur }];
    const others = Object.values(useBuilding.getState().others).sort((a, b) => a.id.localeCompare(b.id));
    for (const o of others) if (o.snap?.config.team.length) out.push({ project: o.id, name: o.name, current: false, snap: namespaced(o.snap, o.id) });
    return out;
  }

  private sync() {
    const wings = this.wingsData();
    if (!wings.length) return;
    const { epoch } = useOffice.getState();
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.seenMessages.clear();
      this.diffs.clear();
      this.cheerUntil.clear();
      this.visits.clear();
      this.layout = null;
    }
    const inputs: WingInput[] = wings.map((w) => ({ project: w.project, name: w.name, type: w.snap.config.project.type, team: w.snap.config.team }));
    const fresh = this.layout?.key !== buildingKey(inputs);
    if (fresh) this.rebuild(generateBuilding(inputs), wings);
    const l = this.layout as Building;

    const prev = this.modes;
    this.modes = new Map();
    for (const w of wings) {
      const { agents, messages } = w.snap;
      const { team } = w.snap.config;
      const lead = team.find((a) => a.isLead);
      const queue = lead ? (this.visits.get(lead.id) ?? []) : [];
      if (lead) this.visits.set(lead.id, queue);
      for (const a of team) {
        const r = this.robots.get(a.id);
        if (!r) continue;
        const mode = modeOf(agents.find((s) => s.agentId === a.id));
        this.modes.set(a.id, mode);
        r.color = a.color;
        if (fresh) {
          // First sight: everyone is already at their desk, except an agent that is just starting (at the door).
          r.bot.mode = mode;
          r.bot.place(mode === "starting" ? doorOf(l, a.id) : (seatOf(l, a.id) ?? doorOf(l, a.id)));
          if (mode !== "starting") r.bot.facing = "ne";
        }
        // The lead comes over when someone needs the user or is stuck...
        if (!fresh && lead && a.id !== lead.id && (mode === "needs-input" || mode === "alert") && prev.get(a.id) !== mode) queue.push(a.id);
        this.setScreen(r, mode);
      }
      // ...or when the lead messages an agent.
      for (const m of [...messages].reverse()) {
        if (this.seenMessages.has(m.id)) continue;
        this.seenMessages.add(m.id);
        if (fresh || !lead || m.fromId !== lead.id || m.toId === lead.id || !this.robots.has(m.toId)) continue;
        queue.push(m.toId);
      }
      let diff = this.diffs.get(w.project);
      if (!diff) this.diffs.set(w.project, (diff = new EventDiff()));
      const wing = l.wings.find((x) => x.project === w.project);
      for (const ev of diff.next(w.snap)) if (wing) this.play(ev, wing);
    }
  }

  /** Top-centre of a robot, in world px. */
  private head(id: string | null | undefined): { x: number; y: number } | null {
    const r = id ? this.robots.get(id) : undefined;
    return r && r.rect.w ? { x: r.rect.x + r.rect.w / 2, y: r.rect.y } : null;
  }

  private tileAt([x, y]: Tile, lift = 0) {
    const l = this.layout as Building;
    const s = toScreen(x + 0.5, y + 0.5);
    return { x: l.origin.x + s.x, y: l.origin.y + s.y - lift };
  }

  private screensOf(wing: Wing) {
    return this.screens.filter((x) => x.x >= wing.x0 && x.x <= wing.x1).map((x) => x.sprite);
  }

  /** Middle of a wing's SOC screen wall (or null without a SOC). */
  private socWall(wing: Wing) {
    const screens = this.screensOf(wing);
    if (!screens.length) return null;
    const a = screens[0];
    const b = screens[screens.length - 1];
    return { x: (a.x + b.x + b.width) / 2, y: (a.y + b.y) / 2 + 22 }; // on the wall, just above the map
  }

  private leadOf(wing: Wing) {
    return wing.agentIds.find((id) => this.robots.get(id)?.bot.isLead) ?? null;
  }

  private get currentWing(): Wing | null {
    return this.layout?.wings[0] ?? null;
  }

  play(ev: IsoEvent, wing: Wing | null = this.currentWing) {
    const l = this.layout;
    if (!l || !wing) return;
    const mine = new Set(wing.agentIds);
    const fx = this.fx;
    switch (ev.kind) {
      case "huddle": {
        // Everyone who is up gathers at the scrum board for a few seconds.
        const spots = [...wing.spots.scrum];
        const scrum = wing.scrum;
        if (scrum)
          for (let y = scrum.y0; y <= scrum.y1; y++)
            for (let x = scrum.x0; x <= scrum.x1; x++) if (l.grid.ok(x, y) && !spots.some(([sx, sy]) => sx === x && sy === y)) spots.push([x, y]);
        let i = 0;
        for (const [id, r] of this.robots) {
          if (!mine.has(id)) continue;
          if (!canHuddle(this.modes.get(id) ?? "stopped") || r.bot.visit || i >= spots.length) continue;
          Object.assign(r.bot, { huddle: spots[i++], huddleFor: 4.5, path: [], errand: null, pause: 0 });
        }
        if (scrum && i) fx.label("PLANNING", this.tileAt([Math.round((scrum.x0 + scrum.x1) / 2), scrum.y0], 30), "#E8B339");
        break;
      }
      case "cheer": {
        for (const id of wing.agentIds) if (canHuddle(this.modes.get(id) ?? "stopped")) this.cheerUntil.set(id, this.t + 2.6);
        const at = this.head(ev.agentId) ?? this.head(this.leadOf(wing)) ?? this.tileAt([Math.floor((wing.x0 + wing.x1) / 2), Math.floor(l.H / 2)], 20);
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
        const leadSeat = seatOf(l, this.leadOf(wing) ?? "");
        if (!from || !leadSeat) break;
        const to = this.tileAt([leadSeat[0], leadSeat[1] - 1], 14); // onto the lead's desk
        fx.parcel(from, to, () => fx.label(`PR #${ev.num}`, { x: to.x, y: to.y - 22 }, "#F3EDE0"));
        break;
      }
      case "finding":
      case "refused": {
        const color = ev.kind === "finding" ? SEVERITY_COLOR[ev.severity] : "#ff3b3b";
        const text = ev.kind === "finding" ? `${ev.id} ${ev.severity.toUpperCase()}` : "OUT OF SCOPE";
        const wall = this.socWall(wing);
        if (wall) fx.flash(this.screensOf(wing), color, ev.kind === "refused" ? 4 : 3);
        const at = wall ?? this.head(ev.agentId);
        if (at) fx.label(text, { x: at.x, y: at.y - 12 }, color, 2.4);
        break;
      }
      case "report": {
        const at = this.head(this.leadOf(wing)) ?? this.socWall(wing);
        if (!at) break;
        fx.confetti(at, 18);
        fx.label("REPORT READY", { x: at.x, y: at.y - 14 }, "#22D3EE", 2.6);
        break;
      }
    }
  }

  /** `?officeDemo=1`: replay one of each moment in turn so all of them can be seen and recorded. */
  private demoTick(dt: number) {
    const wing = this.currentWing;
    if ((this.demoT -= dt) > 0 || !wing) return;
    const ids = wing.agentIds;
    const lead = this.leadOf(wing);
    const workers = ids.filter((id) => id !== lead);
    const up = workers.filter((id) => canHuddle(this.modes.get(id) ?? "stopped"));
    const [a, b] = [up[0] ?? workers[0], up[1] ?? workers[1]];
    const script: IsoEvent[] = [
      { kind: "huddle" },
      { kind: "plane", from: lead ?? a, to: a, chat: false },
      { kind: "plane", from: a, to: b, chat: true },
      { kind: "parcel", from: a, num: 14 },
      { kind: "cheer", agentId: a, label: "MERGED" },
      ...(this.screensOf(wing).length
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

  private rebuild(l: Building, wings: WingData[]) {
    // Frame the whole building again when it first appears or a project's wing comes or goes.
    const first = !this.layout || this.layout.wings.length !== l.wings.length;
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
      if (it.decal === "screen") this.screens.push({ sprite: s, x: it.x });
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
    const team: AgentConfig[] = wings.flatMap((w) => w.snap.config.team);
    team.forEach((a, i) => {
      const seat = seatOf(l, a.id) ?? doorOf(l, a.id);
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
    this.drawBanners(l, wings);
    if (first) this.home(false);
  }

  /** With several projects: each wing's name over its back wall, the one you're viewing in gold. */
  private drawBanners(l: Building, wings: WingData[]) {
    this.banners.removeChildren().forEach((ch) => ch.destroy({ texture: true }));
    if (l.wings.length < 2) return;
    for (const w of l.wings) {
      const current = wings.find((x) => x.project === w.project)?.current ?? false;
      const label = w.name.toUpperCase().slice(0, 24);
      const c = makeCanvas(textW(label, 2) + 8, 16);
      const p = new CanvasPen(c.getContext("2d") as CanvasRenderingContext2D);
      p.rect(0, 0, c.width, c.height, current ? "#E8B339" : "#111A2C");
      p.rect(1, 1, c.width - 2, c.height - 2, "#0B1220");
      text(p, label, 4, 3, current ? "#E8B339" : "#8A97B0", 2);
      const sprite = new Sprite(canvasTexture(c));
      const at = toScreen((w.x0 + w.x1 + 1) / 2, 0);
      sprite.position.set(Math.round(l.origin.x + at.x - c.width / 2), Math.round(l.origin.y + at.y - WALL_H - 30));
      this.banners.addChild(sprite);
    }
  }

  private tick(dt: number) {
    const l = this.layout;
    if (!l) return;
    const still = this.reducedMotion;
    const t = still ? 0 : this.t;
    this.fx.update(dt);
    if (this.demo) this.demoTick(dt);
    for (const [leadId, queue] of this.visits) {
      const lead = this.robots.get(leadId);
      if (!lead || still || lead.bot.visit || lead.bot.moving || lead.bot.errand !== null) continue;
      if (queue.length) lead.bot.visit = queue.shift() ?? null;
      else if (this.demo && lead.bot.pause <= 0 && this.currentWing?.agentIds.includes(leadId)) {
        // Demo: the lead keeps doing its rounds to whoever needs it.
        queue.push(...(this.currentWing?.agentIds ?? []).filter((id) => ["needs-input", "alert"].includes(this.modes.get(id) ?? "")));
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
    if (target.kind === "home") return this.home();
    if (target.kind !== "agent") return;
    const r = this.robots.get(target.id);
    if (r) this.camera.flyTo(r.rect.x + r.rect.w / 2, r.rect.y + r.rect.h / 2, Math.max(this.camera.zoom, Math.min(4, this.camera.fitZoom() + 1)));
  }
}
