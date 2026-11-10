// One-off effects drawn above the office: gold confetti, paper planes, PR
// parcels, rising labels and additive flashes on the SOC screen wall. Owns its
// sprites; the scene calls update(dt) once per tick. Textures are baked once.

import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import { text, textW } from "../engine/font";
import { CanvasPen, makeCanvas, spriteCanvas } from "../engine/pen";
import { canvasTexture } from "../engine/textures";

type Pt = { x: number; y: number };

interface Flight { sprite: Sprite; from: Pt; to: Pt; t: number; dur: number; arc: number; linger: number; onLand?: () => void }
interface Label { sprite: Sprite; t: number; dur: number; y0: number }
interface Flash { sprites: Sprite[]; t: number; dur: number; pulses: number }
interface Bit { x: number; y: number; vx: number; vy: number; color: string; life: number }

const CONFETTI = ["#E8B339", "#F59E0B", "#FFD166", "#F3EDE0", "#B9791C"];
const GRAVITY = 90; // px/s²

const PLANE = spriteCanvas([".......k", ".....kWk", "...kWWWk", ".kWWWWk.", "kkkWWk..", "...kWk..", "....kk.."], { k: "#05060b", W: "#F3EDE0" });
const PARCEL = spriteCanvas(["kkkkkkkkk", "kTTTGTTTk", "kTTTGTTTk", "kGGGGGGGk", "kTTTGTTTk", "kDDDGDDDk", "kkkkkkkkk"], { k: "#05060b", T: "#c9925a", D: "#9a6a3c", G: "#E8B339" });
const CHAT = spriteCanvas([".kkkkkkkk.", "kWWWWWWWWk", "kWqWWqWWqk", "kWWWWWWWWk", ".kkkkkkkk.", "...kWk....", "....k....."], { k: "#05060b", W: "#F3EDE0", q: "#0B1220" });

export class Fx {
  layer = new Container();
  private bits: Bit[] = [];
  private g = new Graphics();
  private flights: Flight[] = [];
  private labels: Label[] = [];
  private flashes: Flash[] = [];
  private chats: { sprite: Sprite; until: number; anchor: () => Pt | null }[] = [];
  private tex = new Map<string, Texture>();
  private t = 0;

  constructor(private still: () => boolean) {
    this.layer.addChild(this.g);
  }

  private texture(key: string, make: () => HTMLCanvasElement) {
    let t = this.tex.get(key);
    if (!t) this.tex.set(key, (t = canvasTexture(make())));
    return t;
  }

  get busy(): boolean {
    return this.bits.length + this.flights.length + this.labels.length + this.flashes.length + this.chats.length > 0;
  }

  confetti(at: Pt, n = 36) {
    if (this.still()) return;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const v = 60 + Math.random() * 70;
      this.bits.push({ x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: CONFETTI[i % CONFETTI.length], life: 1.4 + Math.random() * 0.8 });
    }
  }

  /** A pixel-font label that rises and fades above a point. */
  label(str: string, at: Pt, color: string, dur = 1.8) {
    const s = new Sprite(this.texture(`label|${str}|${color}`, () => {
      const c = makeCanvas(textW(str) + 4, 9);
      const p = new CanvasPen(c.getContext("2d") as CanvasRenderingContext2D);
      p.rect(0, 0, c.width, c.height, "#05060b", 0.85);
      text(p, str, 2, 2, color);
      return c;
    }));
    s.position.set(Math.round(at.x - s.width / 2), Math.round(at.y));
    this.layer.addChild(s);
    this.labels.push({ sprite: s, t: 0, dur, y0: at.y });
  }

  plane(from: Pt, to: Pt) {
    this.fly(PLANE, "plane", from, to, 1.1, 18, 0);
  }

  parcel(from: Pt, to: Pt, onLand?: () => void) {
    this.fly(PARCEL, "parcel", from, to, 1.6, 30, 2.5, onLand);
  }

  /** "…" over a robot for a moment; `anchor` follows the robot (null hides it). */
  chat(anchor: () => Pt | null, dur = 1.6) {
    const s = new Sprite(this.texture("chat", () => CHAT));
    this.layer.addChild(s);
    this.chats.push({ sprite: s, until: this.t + dur, anchor });
  }

  /** The lit pixels of `targets` (screen content) recoloured `color`, pulsing then fading. */
  flash(targets: Sprite[], color: string, pulses = 3, dur = 1.6) {
    if (!targets.length) return;
    const sprites = targets.map((t) => {
      const s = new Sprite(this.texture(`glow|${t.texture.uid}`, () => glowMask(t.texture.source.resource as HTMLCanvasElement)));
      s.position.copyFrom(t.position);
      s.tint = color;
      s.alpha = 0;
      this.layer.addChild(s);
      return s;
    });
    this.flashes.push({ sprites, t: 0, dur, pulses: this.still() ? 1 : pulses });
  }

  private fly(canvas: HTMLCanvasElement, key: string, from: Pt, to: Pt, dur: number, arc: number, linger: number, onLand?: () => void) {
    const s = new Sprite(this.texture(key, () => canvas));
    s.anchor.set(0.5, 1);
    this.layer.addChild(s);
    const f = { sprite: s, from, to, t: this.still() ? dur : 0, dur, arc, linger, onLand };
    this.flights.push(f);
    this.place(f);
  }

  private place(f: Flight) {
    const k = Math.min(1, f.t / f.dur);
    const e = k * k * (3 - 2 * k);
    f.sprite.position.set(Math.round(f.from.x + (f.to.x - f.from.x) * e), Math.round(f.from.y + (f.to.y - f.from.y) * e - Math.sin(Math.PI * k) * f.arc));
    f.sprite.scale.x = f.to.x < f.from.x ? -1 : 1;
  }

  update(dt: number) {
    this.t += dt;
    // Confetti: one Graphics, redrawn.
    this.g.clear();
    this.bits = this.bits.filter((b) => (b.life -= dt) > 0);
    for (const b of this.bits) {
      b.vy += GRAVITY * dt;
      b.vx *= 0.985;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      this.g.rect(Math.round(b.x), Math.round(b.y), 2, Math.floor(b.life * 6) % 2 ? 2 : 1).fill({ color: b.color, alpha: Math.min(1, b.life * 2) });
    }

    this.flights = this.flights.filter((f) => {
      const was = f.t;
      f.t += dt;
      this.place(f);
      if (was < f.dur && f.t >= f.dur) f.onLand?.();
      const left = f.dur + f.linger - f.t;
      f.sprite.alpha = Math.min(1, Math.max(0, left / 0.4));
      if (left > 0) return true;
      f.sprite.destroy();
      return false;
    });

    this.labels = this.labels.filter((l) => {
      l.t += dt;
      const k = l.t / l.dur;
      l.sprite.y = Math.round(l.y0 - (this.still() ? 0 : k * 14));
      l.sprite.alpha = k < 0.75 ? 1 : Math.max(0, (1 - k) / 0.25);
      if (k < 1) return true;
      l.sprite.destroy();
      return false;
    });

    this.flashes = this.flashes.filter((f) => {
      f.t += dt;
      const k = f.t / f.dur;
      const a = k >= 1 ? 0 : 0.85 * Math.abs(Math.sin(Math.PI * f.pulses * k)) * (1 - k * 0.5);
      for (const s of f.sprites) s.alpha = a;
      if (k < 1) return true;
      f.sprites.forEach((s) => s.destroy());
      return false;
    });

    this.chats = this.chats.filter((c) => {
      const at = c.anchor();
      c.sprite.visible = !!at;
      if (at) c.sprite.position.set(Math.round(at.x - 5), Math.round(at.y - 9));
      if (this.t < c.until) return true;
      c.sprite.destroy();
      return false;
    });
  }
}

/** White where the source is lit (screen content), clear elsewhere; tinted per flash. */
function glowMask(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lit = d[i + 3] > 0 && d[i + 1] + d[i + 2] > 150;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = lit ? 255 : 0;
  }
  g.putImageData(img, 0, 0);
  return c;
}
