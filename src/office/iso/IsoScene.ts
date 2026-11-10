// The isometric office: a baked floor, depth-sorted sprites for walls and
// furniture, and one robot sprite per agent at its seat. Reads the stores,
// writes only UI state (hover, drawer) through the ui actions.

import { Application, Container, Graphics, Sprite, TextureStyle, type Texture } from "pixi.js";
import { useOffice } from "../../store/office";
import { useUi, type FocusTarget } from "../../store/ui";
import { drawSelection } from "../draw/overlay";
import { ROBOT_H, ROBOT_W, robotCanvases } from "../draw/robots";
import { Camera } from "../engine/camera";
import { GfxPen } from "../engine/pen";
import { canvasTexture } from "../engine/textures";
import type { PxRect } from "../layout/layout";
import { attachInput, inside, type Target } from "../sceneInput";
import { buildFloor, ITEM_TOP, itemCanvas, itemKey } from "./art";
import { generateIsoLayout, isoLayoutKey, type IsoLayout } from "./layout";
import { depth, toScreen } from "./proj";

TextureStyle.defaultOptions.scaleMode = "nearest";

interface Robot {
  sprite: Sprite;
  rect: PxRect; // world px, for hit-testing
  depth: number;
}

export class IsoScene {
  app = new Application();
  world = new Container();
  items = new Container({ sortableChildren: true });
  camera!: Camera;
  layout: IsoLayout | null = null;
  robots = new Map<string, Robot>();
  hover: { rect: PxRect; agentId: string | null } | null = null;
  private floor: Sprite | null = null;
  private gOver = new Graphics();
  private textures = new Map<string, Texture>();
  private t = 0;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private cleanups: (() => void)[] = [];
  private destroyed = false;

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, background: "#070910", antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1, roundPixels: true });
    if (this.destroyed) return void this.app.destroy(true);
    host.appendChild(this.app.canvas);
    this.app.canvas.style.imageRendering = "pixelated";
    this.world.addChild(this.items, this.gOver);
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
      const dt = Math.min(0.1, tk.deltaMS / 1000);
      this.t += dt;
      this.camera.update(dt);
      this.gOver.clear();
      if (this.hover) drawSelection(new GfxPen(this.gOver), this.hover.rect, this.t);
    });
    if (import.meta.env.DEV) Object.assign(window, { __hqScene: this, __hqStore: useOffice });
  }

  destroy() {
    this.destroyed = true;
    this.cleanups.forEach((fn) => fn());
    if (this.app.renderer) this.app.destroy(true, { children: true, texture: true });
  }

  private sync() {
    const snap = useOffice.getState().snap;
    if (!snap) return;
    const { team, project } = snap.config;
    if (this.layout?.key !== isoLayoutKey(team, project.type)) this.rebuild(generateIsoLayout(team, project.type));
    // Colours can change without moving anyone.
    for (const a of team) {
      const r = this.robots.get(a.id);
      if (r) r.sprite.texture = this.texture(`robot|${a.color}|${a.isLead}`, () => robotCanvases(a.color, a.isLead).back);
    }
  }

  private rebuild(l: IsoLayout) {
    const first = !this.layout;
    this.layout = l;
    this.items.removeChildren().forEach((ch) => ch.destroy());
    this.robots.clear();
    const floorTex = canvasTexture(buildFloor(l));
    if (this.floor) {
      this.floor.texture.destroy(true);
      this.floor.texture = floorTex;
    } else this.floor = this.world.addChildAt(new Sprite(floorTex), 0);
    this.camera.setWorldSize(l.worldW, l.worldH);

    for (const it of l.items) {
      const s = new Sprite(this.texture(itemKey(it), () => itemCanvas(it)));
      const at = toScreen(it.x, it.y);
      s.position.set(l.origin.x + at.x - 16, l.origin.y + at.y - ITEM_TOP);
      s.zIndex = depth(it.x + 0.5, it.y + 0.5);
      this.items.addChild(s);
    }
    for (const seat of l.seats) {
      const [tx, ty] = seat.tile;
      const c = toScreen(tx + 0.5, ty + 0.5);
      // Seated: tucked toward the desk and up onto the chair.
      const x = l.origin.x + c.x - ROBOT_W / 2 + 5;
      const y = l.origin.y + c.y - ROBOT_H - 6;
      const sprite = new Sprite();
      sprite.position.set(x, y);
      sprite.zIndex = depth(tx + 0.5, ty + 0.5, 1);
      this.items.addChild(sprite);
      this.robots.set(seat.agentId, { sprite, rect: { x, y, w: ROBOT_W, h: ROBOT_H }, depth: sprite.zIndex });
    }
    if (first) this.camera.home(false);
  }

  private texture(key: string, make: () => HTMLCanvasElement): Texture {
    let tex = this.textures.get(key);
    if (!tex) this.textures.set(key, (tex = canvasTexture(make())));
    return tex;
  }

  hitTest(sx: number, sy: number): Target | null {
    const { x, y } = this.camera.screenToWorld(sx, sy);
    const robots = [...this.robots].sort((a, b) => b[1].depth - a[1].depth);
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
