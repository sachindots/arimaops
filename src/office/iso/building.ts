// One building for every running project: each project's office is a wing.
// Wings sit side by side along +x in rows; rows stack along +y with a walkway
// between them (a row's full-height back wall would otherwise hide the lobby of
// the row behind). The grid is chosen to keep W + H, and so the on-screen size,
// small: 20 projects is a 5×4 block, not a 20-wing strip.
// Agents from other projects carry namespaced ids ("<project>/<agent>"), so a
// building is just a bigger IsoLayout plus where each wing is. Pure.

import { WalkGrid, type Tile } from "../engine/path";
import { generateCommons, generateIsoLayout, HALL_D, isoLayoutKey, PAD, WALL_H, type IsoLayout, type Spots, type TeamMember } from "./layout";
import { HALF_H, HALF_W } from "./proj";

export interface WingInput {
  project: string;
  name: string;
  secure: boolean;
  team: TeamMember[];
}

export interface Wing {
  project: string;
  name: string;
  /** Tile bounds (inclusive). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  agentIds: string[];
  door: Tile;
  spots: Spots;
  /** Scrum corner tile bounds, for huddles. */
  scrum: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface Building extends IsoLayout {
  wings: Wing[];
  /** The HQ hall along the front: tile bounds (inclusive). */
  hall: { x0: number; y0: number; x1: number; y1: number };
  /** Walkways: one in front of each row of wings, and the east corridor joining them to the hall. */
  streets: { x0: number; y0: number; x1: number; y1: number }[];
}

/** Tiles of corridor east of the wings, joining every row's walkway to the hall. */
export const SPINE = 2;
const HALL_MIN_W = 20;

const shift = ([x, y]: Tile, dx: number, dy: number): Tile => [x + dx, y + dy];

/** Tiles of walkway between rows of wings. */
export const ROW_GAP = 3;

/** Rows of wing indexes, in order, minimising building width + depth. */
export function arrange(widths: number[], depth: number): number[][] {
  const n = widths.length;
  let best: number[][] = [widths.map((_, i) => i)];
  let score = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows: number[][] = [];
    for (let i = 0; i < n; i += cols) rows.push(widths.slice(i, i + cols).map((_, k) => i + k));
    const w = Math.max(...rows.map((r) => r.reduce((t, i) => t + widths[i], 0)));
    const h = rows.length * depth + (rows.length - 1) * ROW_GAP;
    if (w + h < score) (score = w + h), (best = rows);
  }
  return best;
}

export const buildingKey = (wings: WingInput[]) => JSON.stringify(wings.map((w) => [w.project, w.name, isoLayoutKey(w.team, w.secure)]));

/**
 * Every project's wing in rows, a walkway in front of each row, a corridor down the east side,
 * and the HQ hall across the front. With no project it's just the hall.
 */
export function generateBuilding(inputs: WingInput[]): Building {
  const sign = (w: WingInput, i: number) => (inputs.length === 1 && i === 0 ? undefined : w.name);
  // Two passes: the deepest office sets the depth for all.
  const minH = inputs.length ? Math.max(...inputs.map((w, i) => generateIsoLayout(w.team, w.secure, { sign: sign(w, i) }).H)) : 0;
  const parts = inputs.map((w, i) => generateIsoLayout(w.team, w.secure, { minH, sign: sign(w, i) }));
  const rows = inputs.length ? arrange(parts.map((p) => p.W), minH) : [];
  const wingsW = rows.length ? Math.max(...rows.map((r) => r.reduce((t, i) => t + parts[i].W, 0))) : 0;
  const W = Math.max(wingsW + (rows.length ? SPINE : 0), HALL_MIN_W);
  const hallY = rows.length * (minH + ROW_GAP);
  const H = hallY + HALL_D;

  const grid = new WalkGrid(W, H);
  const building: Building = {
    key: buildingKey(inputs),
    W,
    H,
    origin: { x: H * HALF_W + PAD, y: PAD + WALL_H + 24 },
    worldW: (W + H) * HALF_W + 2 * PAD,
    worldH: 0,
    zones: [],
    items: [],
    seats: [],
    door: [0, 0],
    spots: { wander: [], coffee: [], scrum: [] },
    grid,
    doors: new Map(),
    agentSpots: new Map(),
    wings: [],
    hall: { x0: 0, y0: hallY, x1: W - 1, y1: H - 1 },
    streets: [],
  };
  building.worldH = (W + H) * HALF_H + building.origin.y + PAD + 12;

  const wings: Wing[] = new Array(parts.length);
  rows.forEach((row, r) => {
    const dy = r * (minH + ROW_GAP);
    let dx = 0;
    row.forEach((i, col) => {
      const p = parts[i];
      const w = inputs[i];
      for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) grid.set(x + dx, y + dy, x + dx, y + dy, p.grid.ok(x, y));
      for (const it of p.items) {
        // Between wings in a row the west wall is cut away, like the front walls, so the wing behind stays visible.
        const joint = col > 0 && it.kind === "wall" && it.x === 0 && it.y > 0;
        building.items.push({ ...it, x: it.x + dx, y: it.y + dy, ...(joint ? { low: true } : {}) });
      }
      for (const z of p.zones) building.zones.push({ ...z, x0: z.x0 + dx, x1: z.x1 + dx, y0: z.y0 + dy, y1: z.y1 + dy, anchor: shift(z.anchor, dx, dy) });
      const mv = (t: Tile) => shift(t, dx, dy);
      const spots: Spots = { wander: p.spots.wander.map(mv), coffee: p.spots.coffee.map(mv), scrum: p.spots.scrum.map(mv) };
      const door = mv(p.door);
      for (const s of p.seats) {
        building.seats.push({ ...s, tile: mv(s.tile) });
        building.doors?.set(s.agentId, door);
        building.agentSpots?.set(s.agentId, spots);
      }
      const scrum = p.zones.find((z) => z.kind === "scrum");
      wings[i] = {
        project: w.project,
        name: w.name,
        x0: dx,
        x1: dx + p.W - 1,
        y0: dy,
        y1: dy + p.H - 1,
        agentIds: w.team.map((a) => a.id),
        door,
        spots,
        scrum: scrum ? { x0: scrum.x0 + dx, y0: scrum.y0 + dy, x1: scrum.x1 + dx, y1: scrum.y1 + dy } : null,
      };
      dx += p.W;
    });
  });
  building.wings = wings;

  // Walkways: in front of every row, the building's full width; the corridor east of the wings, top to hall.
  rows.forEach((_, r) => building.streets.push({ x0: 0, y0: r * (minH + ROW_GAP) + minH, x1: W - 1, y1: (r + 1) * (minH + ROW_GAP) - 1 }));
  if (rows.length) building.streets.push({ x0: wingsW, y0: 0, x1: W - 1, y1: hallY - 1 });
  for (const s of building.streets) grid.set(s.x0, s.y0, s.x1, s.y1, true);

  // The hall: openings in its glass back wall in front of each front-row door and the corridor.
  const lastRow = rows.length ? rows[rows.length - 1].map((i) => wings[i].door[0]) : [];
  const openings = [...new Set([...lastRow, ...(rows.length ? [wingsW] : [])])].filter((x) => x > 0 && x < W - 1);
  const hall = generateCommons(W, openings);
  const mv = (t: Tile) => shift(t, 0, hallY);
  for (let y = 0; y < HALL_D; y++) for (let x = 0; x < W; x++) if (hall.grid.ok(x, y)) grid.set(x, y + hallY, x, y + hallY, true);
  for (const it of hall.items) building.items.push({ ...it, y: it.y + hallY });
  for (const z of hall.zones) building.zones.push({ ...z, y0: z.y0 + hallY, y1: z.y1 + hallY, anchor: mv(z.anchor) });
  building.door = mv(hall.door);
  building.commons = { wander: hall.commons.wander.map(mv), coffee: hall.commons.coffee.map(mv), rest: hall.commons.rest.map(mv) };
  building.spots = { wander: building.commons.wander, coffee: building.commons.coffee, scrum: wings[0]?.spots.scrum ?? [] };
  return building;
}

/** Namespaced id for an agent of another project. */
export const remoteId = (project: string, agentId: string) => `${project}/${agentId}`;
export const splitRemoteId = (id: string): { project: string; agentId: string } | null => {
  const i = id.indexOf("/");
  return i > 0 ? { project: id.slice(0, i), agentId: id.slice(i + 1) } : null;
};
