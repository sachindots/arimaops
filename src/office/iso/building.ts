// One building for every running project: each project's office is a wing.
// Wings sit side by side along +x in rows; rows stack along +y with a walkway
// between them (a row's full-height back wall would otherwise hide the lobby of
// the row behind). The grid is chosen to keep W + H, and so the on-screen size,
// small: 20 projects is a 5×4 block, not a 20-wing strip.
// Agents from other projects carry namespaced ids ("<project>/<agent>"), so a
// building is just a bigger IsoLayout plus where each wing is. Pure.

import type { ProjectType } from "../../data/types";
import { WalkGrid, type Tile } from "../engine/path";
import { generateIsoLayout, isoLayoutKey, PAD, WALL_H, type IsoLayout, type Spots, type TeamMember } from "./layout";
import { HALF_H, HALF_W } from "./proj";

export interface WingInput {
  project: string;
  name: string;
  type: ProjectType;
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
}

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

export const buildingKey = (wings: WingInput[]) => JSON.stringify(wings.map((w) => [w.project, w.name, isoLayoutKey(w.team, w.type)]));

export function generateBuilding(inputs: WingInput[]): Building {
  const sign = (w: WingInput, i: number) => (inputs.length === 1 && i === 0 ? undefined : w.name);
  // Two passes: the deepest office sets the depth for all.
  const minH = Math.max(...inputs.map((w, i) => generateIsoLayout(w.team, w.type, { sign: sign(w, i) }).H));
  const parts = inputs.map((w, i) => generateIsoLayout(w.team, w.type, { minH, sign: sign(w, i) }));
  const rows = arrange(parts.map((p) => p.W), minH);
  const W = Math.max(...rows.map((r) => r.reduce((t, i) => t + parts[i].W, 0)));
  const H = rows.length * minH + (rows.length - 1) * ROW_GAP;

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
    door: parts[0].door,
    spots: parts[0].spots,
    grid,
    doors: new Map(),
    agentSpots: new Map(),
    wings: [],
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
  if (parts.length) {
    building.door = wings[0].door;
    building.spots = wings[0].spots;
  }
  return building;
}

/** Namespaced id for an agent of another project. */
export const remoteId = (project: string, agentId: string) => `${project}/${agentId}`;
export const splitRemoteId = (id: string): { project: string; agentId: string } | null => {
  const i = id.indexOf("/");
  return i > 0 ? { project: id.slice(0, i), agentId: id.slice(i + 1) } : null;
};
