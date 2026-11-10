// Isometric pixel art, drawn in code onto canvases: the floor (one canvas per
// layout) and one small canvas per furniture/wall tile (cached by look, so a
// hundred wall tiles share one texture). Light comes from the upper left: top
// faces are brightest, the +y face (lower-left) mid, the +x face (lower-right)
// darkest. Every box gets a 1px ink outline on its visible edges.

import { FONT } from "../engine/font";
import { CanvasPen, disc, ellipse, line, makeCanvas, type Pen } from "../engine/pen";
import { type IsoLayout, type Item, LOW_WALL_H, WALL_H, zoneAt, type ZoneKind } from "./layout";
import { toScreen } from "./proj";

/** Item canvases are 32 px wide; the tile's top corner sits ITEM_TOP px down so art can rise above the floor. */
export const ITEM_TOP = 48;
export const ITEM_H = ITEM_TOP + 16;

const INK = "#05060b";
const GOLD = "#E8B339";
const GOLD_D = "#B9791C";
const GOLD_L = "#ffe08a";
const CREAM = "#F3EDE0";
const CYAN = "#38e4ff";
const CYAN_D = "#128aa8";
const CYAN_DD = "#0a3240";
type Shades = [top: string, left: string, right: string];
// Night-blue walls capped with a dark-gold trim; the SOC keeps its own dark shell.
const WALL: Shades = [GOLD_D, "#26324e", "#19223a"];
const WALL_DARK: Shades = ["#1d2535", "#141b29", "#0e131f"];
const DESK: Shades = ["#46506a", "#333b50", "#262c3d"];
const DESK_LEAD: Shades = ["#3b3250", "#2b2439", "#1f1a2a"];
const DESK_DARK: Shades = ["#262c3a", "#1b202b", "#13171f"];
const METAL: Shades = ["#6b7489", "#4a5265", "#333a4a"];
const WOOD: Shades = ["#9a6534", "#7a4e26", "#5a381a"];
const SOFA: Shades = ["#e0a94a", "#bb8530", "#8e6220"];
const SOFA_BASE: Shades = ["#3a3040", "#2a2230", "#1d1822"];
const CLAY: Shades = ["#8a4e36", "#6b3a27", "#4d291b"];
const FLOOR: Record<ZoneKind, [string, string]> = {
  lobby: ["#161e33", "#121a2c"],
  floor: ["#1e2740", "#1a2238"],
  lead: ["#1b2244", "#171d3b"],
  scrum: ["#232a40", "#1e2438"],
  break: ["#2a2638", "#242131"],
  soc: ["#0a1020", "#080d1b"],
};

interface Ctx {
  p: Pen;
  ox: number;
  oy: number;
}
type Pt = { x: number; y: number };
const S = (c: Ctx, x: number, y: number, z = 0): Pt => {
  const s = toScreen(x, y, z);
  return { x: s.x + c.ox, y: s.y + c.oy };
};

// ------------------------------------------------------------------ primitives

/** Crisp convex polygon fill: integer scanlines, [round(left), round(right)). Adjacent diamonds tile seamlessly. */
function quad(c: Ctx, pts: Pt[], color: string, alpha = 1) {
  const ys = pts.map((p) => p.y);
  const y0 = Math.ceil(Math.min(...ys));
  const y1 = Math.floor(Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    let xl = Infinity;
    let xr = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) continue;
      const xs = a.y === b.y ? [a.x, b.x] : [a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y)];
      for (const x of xs) (xl = Math.min(xl, x)), (xr = Math.max(xr, x));
    }
    const w = Math.round(xr) - Math.round(xl);
    if (w > 0) c.p.rect(Math.round(xl), y, w, 1, color, alpha);
  }
}

const faceZ = (c: Ctx, z: number, x0: number, y0: number, x1: number, y1: number, col: string, a = 1) => quad(c, [S(c, x0, y0, z), S(c, x1, y0, z), S(c, x1, y1, z), S(c, x0, y1, z)], col, a);
const faceY = (c: Ctx, y: number, x0: number, x1: number, z0: number, z1: number, col: string, a = 1) => quad(c, [S(c, x0, y, z0), S(c, x1, y, z0), S(c, x1, y, z1), S(c, x0, y, z1)], col, a);
const faceX = (c: Ctx, x: number, y0: number, y1: number, z0: number, z1: number, col: string, a = 1) => quad(c, [S(c, x, y0, z0), S(c, x, y1, z0), S(c, x, y1, z1), S(c, x, y0, z1)], col, a);
const seg = (c: Ctx, a: Pt, b: Pt, col = INK) => line(c.p, a.x, a.y, b.x, b.y, col);

/** A box from z0 to z1 over the footprint, with outlined visible edges. */
function box(c: Ctx, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, [top, lf, rt]: Shades, outline = true) {
  faceY(c, y1, x0, x1, z0, z1, lf);
  faceX(c, x1, y0, y1, z0, z1, rt);
  faceZ(c, z1, x0, y0, x1, y1, top);
  if (!outline) return;
  const T = (x: number, y: number) => S(c, x, y, z1);
  const B = (x: number, y: number) => S(c, x, y, z0);
  seg(c, T(x0, y0), T(x1, y0));
  seg(c, T(x1, y0), T(x1, y1));
  seg(c, T(x1, y1), T(x0, y1));
  seg(c, T(x0, y1), T(x0, y0));
  seg(c, T(x1, y1), B(x1, y1));
  seg(c, T(x0, y1), B(x0, y1));
  seg(c, T(x1, y0), B(x1, y0));
  seg(c, B(x0, y1), B(x1, y1));
  seg(c, B(x1, y1), B(x1, y0));
}

/** Paints bitmap columns [col0, col0 + 16) on the +y face of tile x (plane y), bottom-left at height z. Rows are strings; '.' is clear. */
function decalY(c: Ctx, x: number, y: number, z: number, rows: string[], pal: Record<string, string>, col0 = 0, cols = 16) {
  const o = S(c, x, y, z);
  const h = rows.length;
  for (let j = 0; j < cols; j++) {
    const bx = col0 + j;
    if (bx < 0 || bx >= rows[0].length) continue;
    for (let by = 0; by < h; by++) {
      const col = pal[rows[by][bx]];
      if (col) c.p.rect(o.x + j, o.y + (j >> 1) - (h - by), 1, 1, col);
    }
  }
}

/** Text as bitmap rows ('#' = ink) in the 3×5 office font, optionally scaled. */
function textRows(str: string, scale = 1): string[] {
  const up = str.toUpperCase();
  const rows = Array.from({ length: 5 }, () => "");
  for (const ch of up) {
    const gl = FONT[ch] ?? FONT["?"];
    for (let r = 0; r < 5; r++) rows[r] += gl[r] + ".";
  }
  const trimmed = rows.map((r) => r.slice(0, -1));
  if (scale === 1) return trimmed;
  return trimmed.flatMap((r) => Array.from({ length: scale }, () => [...r].map((ch) => ch.repeat(scale)).join("")));
}


// ------------------------------------------------------------------ floor

/** Tile block (exclusive end) the floor is drawn on; a building passes one per wing. */
export interface Block {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Walkway between rows of wings: a dark street with a faint centre line. */
const STREET = ["#0d121e", "#0b101b"];

export function buildFloor(l: IsoLayout, blocks: Block[] = [{ x0: 0, y0: 0, x1: l.W, y1: l.H }], streets: Block[] = []): HTMLCanvasElement {
  const canvas = makeCanvas(l.worldW, l.worldH);
  const p = new CanvasPen(canvas.getContext("2d") as CanvasRenderingContext2D);
  const c: Ctx = { p, ox: l.origin.x, oy: l.origin.y };
  // No backdrop: the digital rain shows around the building.
  // Ground shadow and the slab each block stands on.
  for (const b of [...blocks, ...streets]) faceZ(c, -14, b.x0 + 0.6, b.y0 + 0.6, b.x1 + 0.6, b.y1 + 0.6, "#04050a", 0.6);
  for (const b of streets)
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++) faceZ(c, -2, x, y, x + 1, y + 1, STREET[(x + y) % 2]);
  for (const b of blocks) {
    faceY(c, b.y1, b.x0, b.x1, -10, 0, "#161b2a");
    faceX(c, b.x1, b.y0, b.y1, -10, 0, "#0f131f");
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++) {
        const zone = zoneAt(l, x, y)?.kind ?? "floor";
        const [a, bb] = FLOOR[zone];
        faceZ(c, 0, x, y, x + 1, y + 1, (x + y) % 2 ? a : bb);
        if (zone === "soc") {
          // Faint cyan grid on the SOC floor.
          seg(c, S(c, x, y), S(c, x + 1, y), "#0f2238");
          seg(c, S(c, x, y), S(c, x, y + 1), "#0f2238");
        } else if (zone === "lead" && (x + y) % 2) {
          const m = S(c, x + 0.5, y + 0.5);
          p.rect(m.x, m.y, 1, 1, GOLD_D, 0.7);
        }
      }
    // Warm pools under the ceiling lights, every few tiles.
    for (let y = b.y0 + 2; y < b.y1 - 1; y += 4)
      for (let x = b.x0 + 2 + ((y >> 2) % 2) * 2; x < b.x1 - 1; x += 4) {
        const m = S(c, x + 0.5, y + 0.5);
        ellipse(p, m.x, m.y, 30, 15, "#ffd27a", 0.035);
        ellipse(p, m.x, m.y, 18, 9, "#ffd27a", 0.045);
      }
    seg(c, S(c, b.x0, b.y1), S(c, b.x1, b.y1));
    seg(c, S(c, b.x1, b.y1), S(c, b.x1, b.y0));
    seg(c, S(c, b.x0, b.y1, -10), S(c, b.x1, b.y1, -10));
    seg(c, S(c, b.x1, b.y1, -10), S(c, b.x1, b.y0, -10));
    seg(c, S(c, b.x1, b.y1), S(c, b.x1, b.y1, -10));
    seg(c, S(c, b.x0, b.y1), S(c, b.x0, b.y1, -10));
    seg(c, S(c, b.x1, b.y0), S(c, b.x1, b.y0, -10));
  }
  return canvas;
}

// ------------------------------------------------------------------ items

/** Cache key: everything about an item except where it stands. */
export const itemKey = ({ x: _x, y: _y, ...look }: Item) => JSON.stringify(look);

/** Draws one item into a fresh 32×64 canvas whose tile diamond's top corner is at (16, ITEM_TOP). */
export function itemCanvas(it: Item): HTMLCanvasElement {
  const canvas = makeCanvas(32, ITEM_H);
  const p = new CanvasPen(canvas.getContext("2d") as CanvasRenderingContext2D);
  const s = toScreen(it.x, it.y);
  const c: Ctx = { p, ox: 16 - s.x, oy: ITEM_TOP - s.y };
  DRAW[it.kind](c, it.x, it.y, it);
  return canvas;
}

const DRAW: Record<Item["kind"], (c: Ctx, x: number, y: number, it: Item) => void> = {
  wall(c, x, y, it) {
    const h = it.low ? LOW_WALL_H : WALL_H;
    const T = 0.25; // wall thickness in tiles
    const sh = it.dark ? WALL_DARK : WALL;
    const runs: ("x" | "y")[] = it.dir === "xy" ? ["y", "x"] : [it.dir ?? "x"];
    for (const run of runs) {
      const cap = it.cap === "xy" || it.cap === run;
      // Footprint of this run's slice: a thin strip through the tile centre.
      const [x0, y0, x1, y1] = run === "x" ? [x, y + 0.5 - T / 2, x + 1, y + 0.5 + T / 2] : [x + 0.5 - T / 2, y, x + 0.5 + T / 2, y + 1];
      const P = (px: number, py: number, z: number) => S(c, px, py, z);
      if (it.glass) {
        // Pane along the run, a rail on top, a mullion at mid height, a post where the run ends.
        if (run === "x") faceY(c, y1, x0, x1, 0, h, "#ffd98a", 0.2);
        else faceX(c, x1, y0, y1, 0, h, "#ffe3a3", 0.22);
        const a = run === "x" ? [x0, y1] : [x1, y0];
        const b = run === "x" ? [x1, y1] : [x1, y1];
        for (const z of [h / 2, h]) seg(c, P(a[0], a[1], z), P(b[0], b[1], z), GOLD);
        seg(c, P(a[0], a[1], 0), P(b[0], b[1], 0), GOLD_D);
        if (cap) box(c, x1 - 0.1, y1 - 0.1, x1, y1, 0, h + 1, METAL);
        continue;
      }
      // Long face, top, and only the end face where the run stops; outlines skip the seams between tiles.
      if (run === "x") faceY(c, y1, x0, x1, 0, h, sh[1]);
      else faceX(c, x1, y0, y1, 0, h, sh[2]);
      faceZ(c, h, x0, y0, x1, y1, sh[0]);
      if (cap) {
        if (run === "x") faceX(c, x1, y0, y1, 0, h, sh[2]);
        else faceY(c, y1, x0, x1, 0, h, sh[1]);
        seg(c, P(x1, y0, h), P(x1, y1, h));
        seg(c, P(x1, y1, h), P(x1, y1, 0));
        if (run === "x") (seg(c, P(x1, y0, h), P(x1, y0, 0)), seg(c, P(x1, y0, 0), P(x1, y1, 0)));
        else (seg(c, P(x0, y1, h), P(x0, y1, 0)), seg(c, P(x0, y1, 0), P(x1, y1, 0)));
      }
      if (run === "x") {
        seg(c, P(x0, y1, h), P(x1, y1, h));
        seg(c, P(x0, y0, h), P(x1, y0, h));
        seg(c, P(x0, y1, 0), P(x1, y1, 0));
        faceY(c, y1 + 0.01, x0, x1, 0, 2, sh[2]); // skirting
      } else {
        seg(c, P(x1, y0, h), P(x1, y1, h));
        seg(c, P(x0, y0, h), P(x0, y1, h));
        seg(c, P(x1, y0, 0), P(x1, y1, 0));
      }
    }
    if (it.dir === "xy") faceZ(c, h, x + 0.5 - T / 2, y + 0.5 - T / 2, x + 0.5 + T / 2, y + 0.5 + T / 2, sh[0]);
    if (it.decal === "board") board(c, x, y + 0.5 + T / 2, it.i ?? 0, it.n ?? 1);
    if (it.decal === "screen") screenWall(c, x, y + 0.5 + T / 2, it.i ?? 0, it.n ?? 1);
    if (it.decal === "window") cityWindow(c, x, y + 0.5 + T / 2, it.i ?? 0);
    if (it.decal === "poster") poster(c, x, y + 0.5 + T / 2, it.i ?? 0);
  },

  desk(c, x, y, it) {
    const sh = it.lead ? DESK_LEAD : it.dark ? DESK_DARK : DESK;
    const x0 = it.i === 0 ? x + 0.1 : x;
    const x1 = it.i === 1 ? x + 0.9 : x + 1;
    // legs, then the slab
    if (it.i === 0) box(c, x + 0.14, y + 0.7, x + 0.24, y + 0.82, 0, 11, METAL, false);
    if (it.i === 1) box(c, x + 0.76, y + 0.7, x + 0.86, y + 0.82, 0, 11, METAL, false);
    faceY(c, y + 0.82, x0 + 0.1, x1 - 0.1, 3, 11, sh[2]); // modesty panel
    box(c, x0, y + 0.18, x1, y + 0.84, 10, 14, sh);
    if (it.lead) seg(c, S(c, x0, y + 0.84, 14), S(c, x1, y + 0.84, 14), GOLD);
    if (it.i === 0) {
      // Keyboard and mouse; two monitors (three for leads and the SOC, the third on the other half).
      box(c, x + 0.36, y + 0.62, x + 0.86, y + 0.76, 14, 15, METAL, false);
      box(c, x + 0.9, y + 0.64, x + 0.98, y + 0.74, 14, 15, ["#d0d4de", "#a9afbd", "#8a90a0"], false);
      monitor(c, x + 0.12, y, it, 0);
      monitor(c, x + 0.56, y, it, 1);
    } else if (it.lead || it.dark) {
      monitor(c, x + 0.02, y, it, 2);
      box(c, x + 0.52, y + 0.6, x + 0.62, y + 0.72, 14, 18, ["#f0f0f4", "#d0d4de", "#a9afbd"], false);
      box(c, x + 0.62, y + 0.2, x + 0.88, y + 0.46, 14, 15, [CREAM, "#d8d0bc", "#b9b09a"], false); // papers
    } else {
      // lamp, mug, papers
      faceZ(c, 14.5, x + 0.12, y + 0.3, x + 0.42, y + 0.62, "#d8dce6");
      faceZ(c, 14.5, x + 0.16, y + 0.36, x + 0.4, y + 0.6, "#b9c0cf");
      box(c, x + 0.52, y + 0.6, x + 0.62, y + 0.72, 14, 18, ["#f0f0f4", "#d0d4de", "#a9afbd"], false);
      const m = S(c, x + 0.64, y + 0.66, 16);
      c.p.rect(m.x + 1, m.y - 1, 1, 2, "#a9afbd");
      box(c, x + 0.7, y + 0.26, x + 0.78, y + 0.34, 14, 25, METAL, false);
      box(c, x + 0.56, y + 0.14, x + 0.92, y + 0.46, 24, 28, [GOLD_L, GOLD, GOLD_D]);
      const l = S(c, x + 0.74, y + 0.46, 23);
      c.p.rect(l.x - 2, l.y, 5, 1, "#fff2b0", 0.6);
    }
    if (it.i === 1) {
      // PC tower under the desk, its power light and a glowing side vent.
      box(c, x + 0.5, y + 0.3, x + 0.78, y + 0.66, 0, 10, ["#232838", "#1a1f2c", "#121621"]);
      const led = S(c, x + 0.56, y + 0.66, 7);
      const on = it.screen !== "off";
      c.p.rect(led.x, led.y, 1, 1, on ? (it.dark ? CYAN : "#3ddc84") : "#3a2020");
      if (on) faceX(c, x + 0.781, y + 0.36, y + 0.6, 2, 8, it.dark ? CYAN : it.lead ? GOLD : "#7f5cff", 0.55);
    }
  },

  chair(c, x, y) {
    faceZ(c, 0.5, x + 0.3, y + 0.3, x + 0.7, y + 0.7, "#1a1e29");
    box(c, x + 0.45, y + 0.45, x + 0.55, y + 0.55, 0, 6, METAL, false);
    box(c, x + 0.28, y + 0.28, x + 0.72, y + 0.72, 6, 9, ["#4a5a7c", "#374460", "#283247"]);
    box(c, x + 0.3, y + 0.68, x + 0.7, y + 0.76, 9, 19, ["#4a5a7c", "#374460", "#283247"]);
  },

  plant(c, x, y) {
    box(c, x + 0.32, y + 0.32, x + 0.68, y + 0.68, 0, 8, CLAY);
    faceZ(c, 8, x + 0.38, y + 0.38, x + 0.62, y + 0.62, "#3a2a1e");
    const m = S(c, x + 0.5, y + 0.5, 16);
    disc(c.p, m.x, m.y, 8, INK);
    disc(c.p, m.x, m.y, 7, "#2a6d35");
    disc(c.p, m.x - 2, m.y - 2, 4, "#3e9a4c");
    c.p.rect(m.x - 4, m.y - 5, 2, 2, "#6ecf78");
    c.p.rect(m.x + 3, m.y - 1, 1, 2, "#6ecf78");
    c.p.rect(m.x - 1, m.y + 3, 2, 1, "#1d4a26");
  },

  sofa(c, x, y, it) {
    box(c, x, y + 0.2, x + 1, y + 0.9, 0, 6, SOFA_BASE, false);
    box(c, x, y + 0.2, x + 1, y + 0.42, 6, 18, SOFA); // backrest
    box(c, x + 0.02, y + 0.4, x + 0.98, y + 0.88, 6, 10, SOFA); // cushion
    if (it.i === 0) box(c, x, y + 0.2, x + 0.16, y + 0.9, 6, 14, SOFA);
    if (it.i === 1) box(c, x + 0.84, y + 0.2, x + 1, y + 0.9, 6, 14, SOFA);
    seg(c, S(c, x, y + 0.9), S(c, x + 1, y + 0.9));
  },

  coffee(c, x, y) {
    box(c, x + 0.22, y + 0.22, x + 0.78, y + 0.78, 0, 26, ["#505a70", "#3a4253", "#2a303e"]);
    const f = ["kkkkkkkk", "krrkkkkk", "kkkkkkkk", "kggggggk", "kgcccggk", "kggggggk", "kkkkkkkk", "kwwkkkkk", "kkkkkkkk"];
    decalY(c, x + 0.3, y + 0.78, 8, f, { k: "#1a1f2a", r: "#ff3b3b", g: "#0e1a1f", c: GOLD_L, w: "#f4f4f8" }, 0, 8);
    const o = S(c, x + 0.5, y + 0.5, 26);
    c.p.rect(o.x - 3, o.y - 1, 6, 1, "#f2b632", 0.8);
  },

  table(c, x, y) {
    box(c, x + 0.44, y + 0.44, x + 0.56, y + 0.56, 0, 10, METAL, false);
    const m = S(c, x + 0.5, y + 0.5, 10);
    ellipse(c.p, m.x, m.y, 10, 5, INK);
    ellipse(c.p, m.x, m.y - 1, 10, 5, INK);
    ellipse(c.p, m.x, m.y - 1, 9, 4, WOOD[0]);
    ellipse(c.p, m.x, m.y, 9, 4, WOOD[1]);
    ellipse(c.p, m.x, m.y - 1, 9, 4, WOOD[0]);
    ellipse(c.p, m.x - 2, m.y - 2, 4, 1, "#b7824a");
  },

  counter(c, x, y, it) {
    box(c, x, y + 0.26, x + 1, y + 0.76, 0, 15, ["#2d3550", "#20273d", "#171c2c"]);
    seg(c, S(c, x, y + 0.76, 15), S(c, x + 1, y + 0.76, 15), GOLD);
    if (it.decal === "sign") sign(c, x, y + 0.76, it.i ?? 0, it.n ?? 1, it.label);
  },

  rack(c, x, y) {
    box(c, x + 0.2, y + 0.2, x + 0.8, y + 0.8, 0, 32, ["#2a3242", "#1a2030", "#111621"]);
    const o = S(c, x + 0.22, y + 0.8, 2);
    for (let u = 0; u < 9; u++) {
      const zy = o.y - 3 - u * 3;
      for (let j = 0; j < 9; j++) c.p.rect(o.x + j, zy + (j >> 1), 1, 1, "#0c1018");
      c.p.rect(o.x + 1, zy, 1, 1, u % 3 === 1 ? "#39d98a" : CYAN);
      if (u % 2) c.p.rect(o.x + 7, zy + 3, 1, 1, "#ff9f1c");
    }
    const t = S(c, x + 0.5, y + 0.5, 32);
    c.p.rect(t.x - 4, t.y - 1, 8, 1, CYAN, 0.5);
  },

  rug(c, x, y, it) {
    // One 3-wide rug per break area; the border runs round the outer tiles.
    const i = it.i ?? 0;
    const n = it.n ?? 3;
    const col = i % n;
    const row = Math.floor(i / n);
    const x0 = col === 0 ? 0.1 : 0;
    const x1 = col === n - 1 ? 0.9 : 1;
    const y0 = row === 0 ? 0.1 : 0;
    const y1 = row === n - 1 ? 0.9 : 1;
    faceZ(c, 0.5, x + x0, y + y0, x + x1, y + y1, "#3a2b3c");
    faceZ(c, 0.5, x + Math.max(x0, 0.15), y + Math.max(y0, 0.15), x + Math.min(x1, 0.85), y + Math.min(y1, 0.85), "#2c2231");
    const m = S(c, x + 0.5, y + 0.5, 1);
    c.p.rect(m.x - 1, m.y, 3, 1, GOLD_D, 0.5);
  },

  shelf(c, x, y, it) {
    // Bookcase along the corridor wall; spines face the viewer (+y) on three shelves.
    box(c, x, y + 0.05, x + 1, y + 0.45, 0, 30, ["#3a2d22", "#2a2019", "#1d1711"]);
    const o = S(c, x, y + 0.45, 0);
    const books = ["#c0392b", GOLD, "#2e86de", CREAM, "#27ae60", "#8e44ad", GOLD_D, "#e67e22"];
    const seed = (it.i ?? 0) * 5;
    for (let sh = 0; sh < 3; sh++) {
      const zb = 3 + sh * 9;
      for (let j = 1; j < 15; j++) {
        if ((j * 7 + sh * 3 + seed) % 11 === 0) continue; // a gap now and then
        const h = 5 + ((j * 3 + sh + seed) % 3);
        c.p.rect(o.x + j, o.y + (j >> 1) - zb - h, 1, h, books[(j + sh * 2 + seed) % books.length]);
      }
      for (let j = 0; j < 16; j++) c.p.rect(o.x + j, o.y + (j >> 1) - zb, 1, 1, "#1d1711");
    }
  },

  whiteboard(c, x, y) {
    box(c, x + 0.18, y + 0.42, x + 0.28, y + 0.52, 0, 19, METAL, false);
    box(c, x + 0.72, y + 0.42, x + 0.82, y + 0.52, 0, 19, METAL, false);
    box(c, x + 0.1, y + 0.4, x + 0.9, y + 0.54, 18, 36, ["#2b3140", "#1a1f2a", "#12161f"]);
    faceY(c, y + 0.55, x + 0.14, x + 0.86, 19, 35, CREAM);
    const rows = ["tttt......", "..........", ".rrrr.....", ".r..r..g..", ".r..r.gg..", ".rrrr..g..", "..........", ".bbbbbbb..", "..........", ".ddd......"];
    decalY(c, x + 0.18, y + 0.56, 22, rows, { t: "#1d3557", r: "#e63946", g: "#2a9d8f", b: "#1d3557", d: GOLD_D }, 0, 10);
  },

  cooler(c, x, y) {
    box(c, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 0, 18, ["#3e4a66", "#2b344a", "#1e2535"]);
    box(c, x + 0.34, y + 0.34, x + 0.66, y + 0.66, 18, 30, ["#9fe0ff", "#5fb6e8", "#3a8fc4"]);
    const m = S(c, x + 0.5, y + 0.5, 30);
    c.p.rect(m.x - 2, m.y - 1, 4, 1, "#d8f6ff");
    const f = S(c, x + 0.5, y + 0.7, 9);
    c.p.rect(f.x - 1, f.y, 1, 2, "#3ddc84");
    c.p.rect(f.x + 1, f.y, 1, 2, "#ff3b3b");
  },

  mat(c, x, y) {
    faceZ(c, 0.5, x + 0.12, y + 0.12, x + 0.88, y + 0.88, GOLD_D);
    faceZ(c, 0.5, x + 0.2, y + 0.2, x + 0.8, y + 0.8, "#1c2a4d");
  },

  cabinet(c, x, y) {
    box(c, x + 0.16, y + 0.1, x + 0.84, y + 0.9, 0, 22, ["#2d3550", "#20273d", "#171c2c"]);
    seg(c, S(c, x + 0.5, y + 0.9, 2), S(c, x + 0.5, y + 0.9, 20), "#0f1320");
    const h = S(c, x + 0.42, y + 0.9, 11);
    c.p.rect(h.x, h.y, 1, 2, GOLD);
    c.p.rect(h.x + 3, h.y + 1, 1, 2, GOLD);
  },

  vending(c, x, y) {
    box(c, x + 0.12, y + 0.18, x + 0.88, y + 0.82, 0, 34, ["#b8232f", "#93202a", "#6c1820"]);
    // Glass front with rows of snacks, a slot and a lit panel.
    faceY(c, y + 0.83, x + 0.18, x + 0.62, 10, 31, "#1a2236");
    const o = S(c, x + 0.18, y + 0.83, 0);
    const snack = ["#ffd23f", "#38e4ff", "#ff7aa2", "#6ecf78", "#f4f4f8"];
    for (let r = 0; r < 4; r++) for (let j = 1; j < 7; j += 2) c.p.rect(o.x + j, o.y + (j >> 1) - 13 - r * 5, 1, 3, snack[(r + j) % snack.length]);
    faceY(c, y + 0.83, x + 0.66, x + 0.82, 18, 28, "#ffe08a", 0.85);
    faceY(c, y + 0.83, x + 0.2, x + 0.6, 3, 7, "#0b0e16");
  },

  arcade(c, x, y, it) {
    const body: Shades = ["#2a1f4a", "#211839", "#170f2a"];
    box(c, x + 0.2, y + 0.16, x + 0.84, y + 0.84, 0, 18, body);
    box(c, x + 0.2, y + 0.16, x + 0.84, y + 0.5, 18, 34, body);
    // Screen facing the room (+x), marquee on top, buttons on the control deck.
    const hue = (it.y ?? 0) % 2 ? "#ff3df2" : CYAN;
    faceX(c, x + 0.841, y + 0.2, y + 0.46, 22, 31, "#071722");
    for (let k = 0; k < 4; k++) faceX(c, x + 0.842, y + 0.24 + k * 0.05, y + 0.28 + k * 0.05, 24 + k * 2, 25 + k * 2, hue, 0.9);
    faceX(c, x + 0.841, y + 0.18, y + 0.5, 32, 34, GOLD_L);
    faceZ(c, 18.2, x + 0.5, y + 0.55, x + 0.8, y + 0.8, "#120c22");
    const b = S(c, x + 0.66, y + 0.66, 18.5);
    c.p.rect(b.x - 2, b.y, 1, 1, "#ff3b3b");
    c.p.rect(b.x + 1, b.y - 1, 1, 1, "#ffd23f");
    c.p.rect(b.x + 3, b.y, 1, 1, CYAN);
  },

  pingpong(c, x, y, it) {
    const x0 = it.i === 0 ? x + 0.1 : x;
    const x1 = it.i === 1 ? x + 0.9 : x + 1;
    if (it.i === 0) box(c, x + 0.2, y + 0.4, x + 0.3, y + 0.5, 0, 9, METAL, false);
    if (it.i === 1) box(c, x + 0.7, y + 0.4, x + 0.8, y + 0.5, 0, 9, METAL, false);
    box(c, x0, y + 0.15, x1, y + 0.85, 9, 11, ["#1f6f4a", "#175538", "#103d28"]);
    seg(c, S(c, x0, y + 0.5, 11), S(c, x1, y + 0.5, 11), "#e9f5ee");
    if (it.i === 0) faceX(c, x + 0.995, y + 0.15, y + 0.85, 11, 15, "#e9f5ee", 0.7); // net
    if (it.i === 1) {
      const b = S(c, x + 0.4, y + 0.35, 15);
      c.p.rect(b.x, b.y, 1, 1, "#ff9f1c");
    }
  },

  beanbag(c, x, y) {
    const m = S(c, x + 0.5, y + 0.55, 3);
    ellipse(c.p, m.x, m.y + 1, 9, 5, INK);
    ellipse(c.p, m.x, m.y, 8, 5, (x + y) % 2 ? "#6a3fb5" : "#c0392b");
    ellipse(c.p, m.x - 1, m.y - 2, 6, 3, (x + y) % 2 ? "#8a5fd5" : "#e05a4b");
    ellipse(c.p, m.x - 3, m.y - 3, 2, 1, "#ffffff", 0.25);
  },

  lamp(c, x, y) {
    box(c, x + 0.42, y + 0.42, x + 0.58, y + 0.58, 0, 1, METAL, false);
    box(c, x + 0.48, y + 0.48, x + 0.52, y + 0.52, 1, 26, METAL, false);
    box(c, x + 0.32, y + 0.32, x + 0.68, y + 0.68, 26, 32, [GOLD_L, GOLD, GOLD_D]);
    const g = S(c, x + 0.5, y + 0.5, 0);
    ellipse(c.p, g.x, g.y, 14, 7, "#ffd27a", 0.12);
    ellipse(c.p, g.x, g.y, 8, 4, "#ffd27a", 0.12);
  },

  printer(c, x, y) {
    box(c, x + 0.2, y + 0.25, x + 0.8, y + 0.75, 0, 12, METAL);
    box(c, x + 0.16, y + 0.2, x + 0.84, y + 0.8, 12, 18, ["#d8dce6", "#b9c0cf", "#9aa2b4"]);
    faceZ(c, 18.2, x + 0.3, y + 0.3, x + 0.7, y + 0.55, "#f4f4f8");
    const l = S(c, x + 0.7, y + 0.8, 15);
    c.p.rect(l.x, l.y, 1, 1, "#3ddc84");
  },

  tv(c, x, y) {
    // A big screen on a stand showing a dashboard: bars and a line.
    box(c, x + 0.4, y + 0.4, x + 0.6, y + 0.6, 0, 18, METAL, false);
    box(c, x + 0.05, y + 0.42, x + 0.95, y + 0.52, 18, 36, ["#2b3140", "#1a1f2a", "#12161f"]);
    const rows = [
      "ggggggggggggg", "g...........g", "g.y.........g", "g.y...c.....g", "g.yy..cc..m.g", "g.yy.ccc.mm.g", "g.yyycccmmm.g", "g...........g", "g.wwwwwwwww.g", "ggggggggggggg",
    ];
    decalY(c, x + 0.08, y + 0.53, 21, rows, { g: "#0b1430", ".": "#0e1d3d", y: GOLD, c: CYAN, m: "#ff7aa2", w: "#7f8ba8" }, 0, 13);
  },
};

/** A monitor on its stand at desk tile x (screen on the +y face); `n` varies what's on it. */
function monitor(c: Ctx, x: number, y: number, it: Item, n: number) {
  box(c, x + 0.16, y + 0.38, x + 0.26, y + 0.48, 14, 17, METAL, false);
  box(c, x, y + 0.46, x + 0.42, y + 0.53, 17, 27, ["#2b3140", "#1a1f2a", "#12161f"]);
  const off = it.screen === "off";
  const bright = it.screen === "glow";
  const glow = it.dark ? ["#0b2a38", CYAN, CYAN_D] : bright ? ["#1d4a80", "#bfe6ff", "#5aa6ff"] : ["#17365c", "#7fc4ff", "#3a7fcc"];
  const scr = off
    ? ["aaaaaa", "aaaaaa", "aaaaaa", "aaaaaa", "aaaaaa"]
    : [["aaaaaa", "abbaaa", "aaacca", "abbbaa", "aaaaca"], ["aaaaaa", "accaca", "aaaaaa", "abbbba", "aaaaaa"], ["aaaaaa", "aabaaa", "abcbaa", "aabaca", "aaaaaa"]][n % 3];
  decalY(c, x + 0.04, y + 0.531, 19, scr, off ? { a: "#0b0e16" } : { a: glow[0], b: glow[1], c: glow[2] }, 0, 6);
  if (bright) faceZ(c, 14.2, x, y + 0.56, x + 0.44, y + 0.84, it.dark ? CYAN : "#8fc8ff", 0.2);
}

/** A window in the back wall: night sky, a few stars, the city skyline with lit windows. Varies by `seed`. */
function cityWindow(c: Ctx, x: number, y: number, seed: number) {
  const H = 20;
  const rows: string[] = [];
  const heights = Array.from({ length: 16 }, (_, col) => 3 + ((Math.floor((col + seed * 3) / 3) * 7 + seed * 5) % 11));
  for (let r = 0; r < H; r++) {
    let row = "";
    for (let col = 0; col < 16; col++) {
      const up = H - 1 - r;
      if (col <= 1 || col >= 14 || r === 0 || r === H - 1) row += col === 0 || col === 15 ? "." : "f";
      else if (col === 8 || r === 9) row += "m";
      else if (up <= heights[col]) row += (col * 5 + r * 3 + seed) % 7 === 0 && up < heights[col] ? "l" : "b";
      else if ((col * 7 + r * 13 + seed * 3) % 41 === 0) row += "*";
      else row += r < 7 ? "s" : "t";
    }
    rows.push(row);
  }
  decalY(c, x, y + 0.01, 12, rows, { f: "#2a3350", m: "#3a4566", s: "#070d22", t: "#101b3c", b: "#090c16", l: "#ffd27a", "*": "#cfe3ff" }, 0, 16);
}

/** A framed poster: the mascot on gold, or a growth chart. */
function poster(c: Ctx, x: number, y: number, seed: number) {
  const art =
    seed % 2
      ? ["kkkkkkkkkkkkk", ...MASCOT.map((r) => "k" + r.replace(/\./g, "o") + "k"), "kkkkkkkkkkkkk"]
      : ["kkkkkkkkkkkkk", "kooooooooooook".slice(0, 13), "koooooooooook", "kooooooooocok", "koooooooocccok".slice(0, 13), "kooooyooccook", "koooyyoocoook", "kooyyyycooook", "koyyyyyyooook", "kooooooooooook".slice(0, 13), "kgggggggggggk", "kkkkkkkkkkkkk"];
  decalY(c, x, y + 0.01, 14, art, { ...MASCOT_PAL, k: "#3a2d22", o: seed % 2 ? "#1b2440" : "#f3ede0", y: GOLD, c: "#e63946", g: GOLD_D }, -2, 16);
}

// ------------------------------------------------------------------ wall decals

/** Cork board with sticky notes, spanning `n` wall tiles; this is slice `i`. */
function board(c: Ctx, x: number, y: number, i: number, n: number) {
  const cork = i === 0 || i === n - 1 ? "#6a5440" : "#5a4634";
  faceY(c, y + 0.02, x + (i === 0 ? 0.1 : 0), x + (i === n - 1 ? 0.9 : 1), 12, 34, cork);
  if (i === 0) faceY(c, y + 0.03, x + 0.1, x + 0.16, 12, 34, "#7a6248");
  if (i === n - 1) faceY(c, y + 0.03, x + 0.84, x + 0.9, 12, 34, "#7a6248");
  seg(c, S(c, x + (i === 0 ? 0.1 : 0), y + 0.03, 34), S(c, x + (i === n - 1 ? 0.9 : 1), y + 0.03, 34), "#7a6248");
  // Three swimlanes and a few notes placed by slice index so the board varies but stays deterministic.
  const o = S(c, x, y + 0.04, 0);
  const notes = ["#ffd23f", CYAN, "#ff7aa2", "#6ecf78", GOLD_L];
  for (let k = 0; k < 2; k++) {
    const col = 3 + ((i * 7 + k * 5) % 9);
    const row = 15 + ((i * 3 + k * 11) % 14);
    const nc = notes[(i + k * 2) % notes.length];
    for (let j = 0; j < 4; j++) {
      c.p.rect(o.x + col + j, o.y + ((col + j) >> 1) - row, 1, 4, nc);
      c.p.rect(o.x + col + j, o.y + ((col + j) >> 1) - row + 4, 1, 1, "#2a2016");
    }
    c.p.rect(o.x + col + 1, o.y + ((col + 1) >> 1) - row + 1, 2, 1, "#4a3a20", 0.6);
  }
}

// A rough world map, 64×12, drawn by hand (original). '#' is land.
const WORLD = [
  "...####...##.....................##..####.######.##.............",
  "..#########..................#########..#######################.",
  "..##########...............##########.###########.##########....",
  "...#########..............######.#.#####################.###....",
  "....#######...............##########################.#####......",
  ".....#####.................#########################..###.......",
  "......###...................#######################....##.......",
  ".......##....................#################.........#........",
  "........###..................###############............##......",
  "........####..................############...............####...",
  ".........###...................#########................#####...",
  "..........##....................#######..................###....",
  "..........#......................####...........................",
  "...........#......................##............................",
];

/** SOC screen wall: dark panel with a cyan frame and the world map centred across all `n` tiles. */
function screenWall(c: Ctx, x: number, y: number, i: number, n: number) {
  faceY(c, y + 0.02, x, x + 1, 9, 36, "#071722");
  seg(c, S(c, x, y + 0.03, 36), S(c, x + 1, y + 0.03, 36), CYAN_D);
  seg(c, S(c, x, y + 0.03, 9), S(c, x + 1, y + 0.03, 9), CYAN_D);
  seg(c, S(c, x, y + 0.03, 6), S(c, x + 1, y + 0.03, 6), CYAN);
  const total = 16 * n;
  const map = WORLD.flatMap((r) => [r, r].map((row) => [...row].map((ch) => ch.repeat(2)).join("")));
  const mapW = map[0].length;
  const left = Math.floor((total - mapW) / 2);
  const col0 = 16 * i - left;
  // Map pixels light up cyan; the sea gets a faint grid.
  const sea = Array.from({ length: map.length }, (_, r) => Array.from({ length: mapW }, (_, k) => ((r % 6 === 0 || k % 8 === 0) ? "g" : ".")).join(""));
  decalY(c, x, y + 0.02, 12, sea, { g: CYAN_DD }, col0, 16);
  decalY(c, x, y + 0.02, 12, map, { "#": CYAN }, col0, 16);
  // Side panels: little bar charts where the map doesn't reach.
  if (16 * i + 16 <= left || 16 * i >= left + mapW) {
    const o = S(c, x + 0.15, y + 0.04, 16);
    for (let b = 0; b < 5; b++) {
      const hgt = 3 + ((i * 5 + b * 3) % 9);
      c.p.rect(o.x + b * 2, o.y + ((b * 2) >> 1) - hgt, 1, hgt, b % 2 ? CYAN_D : CYAN);
    }
  }
}

/** The mascot's head, 11×11: crown, gold mane, navy face, cyan eyes. */
const MASCOT = [
  "..Y...Y...Y",
  "..YYYYYYYYY",
  ".GGGGGGGGG.",
  "GGnnnnnnnGG",
  "GnnCnnnCnnG",
  "GnnnnnnnnnG",
  "GnnnGGGnnnG",
  ".GnnnnnnnG.",
  ".GGnnnnnGG.",
  "..GGGGGGG..",
  "...ddddd...",
];
export const MASCOT_PAL = { Y: "#FFD166", G: GOLD, n: "#243050", C: CYAN, d: GOLD_D, k: INK };

/** Lobby sign: the mascot head + ARIMAOPS at double size, on the reception counter's front, sliced over `n` tiles. */
function sign(c: Ctx, x: number, y: number, i: number, n: number, label = "ArimaOps") {
  // Long project names drop to single size so they fit the 5-tile counter.
  const big = label.length <= 8;
  const txt = textRows(label.slice(0, 14), big ? 2 : 1);
  const gap = 3;
  const w = MASCOT[0].length + gap + txt[0].length;
  const top = Math.floor((MASCOT.length - txt.length) / 2);
  const rows = MASCOT.map((r, k) => r + ".".repeat(gap) + (k >= top && k < top + txt.length ? txt[k - top] : ".".repeat(txt[0].length)));
  // Dark plate behind, one pixel larger than the art.
  const plate = Array.from({ length: rows.length + 2 }, () => "p".repeat(w + 2));
  const left = Math.floor((16 * n - w) / 2);
  decalY(c, x, y + 0.01, 1, plate, { p: "#0B1220" }, 16 * i - left + 1, 16);
  decalY(c, x, y + 0.02, 2, rows, { ...MASCOT_PAL, "#": GOLD }, 16 * i - left, 16);
}
