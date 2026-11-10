// One building for every running project: each project's office is a wing,
// side by side along +x, all the same depth so the floor is one rectangle.
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
  /** Tile columns x0..x1 (inclusive). */
  x0: number;
  x1: number;
  agentIds: string[];
  door: Tile;
  spots: Spots;
  /** Scrum corner tile bounds, for huddles. */
  scrum: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface Building extends IsoLayout {
  wings: Wing[];
}

const shift = ([x, y]: Tile, dx: number): Tile => [x + dx, y];

export const buildingKey = (wings: WingInput[]) => JSON.stringify(wings.map((w) => [w.project, w.name, isoLayoutKey(w.team, w.type)]));

export function generateBuilding(inputs: WingInput[]): Building {
  const sign = (w: WingInput, i: number) => (inputs.length === 1 && i === 0 ? undefined : w.name);
  // Two passes: the deepest office sets the depth for all.
  const minH = Math.max(...inputs.map((w, i) => generateIsoLayout(w.team, w.type, { sign: sign(w, i) }).H));
  const parts = inputs.map((w, i) => generateIsoLayout(w.team, w.type, { minH, sign: sign(w, i) }));
  const W = parts.reduce((n, p) => n + p.W, 0);
  const H = minH;

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

  let dx = 0;
  parts.forEach((p, i) => {
    const w = inputs[i];
    for (let y = 0; y < H; y++) for (let x = 0; x < p.W; x++) grid.set(x + dx, y, x + dx, y, p.grid.ok(x, y));
    for (const it of p.items) {
      // Between wings the west wall is cut away, like the front walls, so the wing behind stays visible.
      const joint = i > 0 && it.kind === "wall" && it.x === 0 && it.y > 0;
      building.items.push({ ...it, x: it.x + dx, ...(joint ? { low: true } : {}) });
    }
    for (const z of p.zones) building.zones.push({ ...z, x0: z.x0 + dx, x1: z.x1 + dx, anchor: shift(z.anchor, dx) });
    const spots: Spots = { wander: p.spots.wander.map((t) => shift(t, dx)), coffee: p.spots.coffee.map((t) => shift(t, dx)), scrum: p.spots.scrum.map((t) => shift(t, dx)) };
    const door = shift(p.door, dx);
    for (const s of p.seats) {
      building.seats.push({ ...s, tile: shift(s.tile, dx) });
      building.doors?.set(s.agentId, door);
      building.agentSpots?.set(s.agentId, spots);
    }
    const scrum = p.zones.find((z) => z.kind === "scrum");
    building.wings.push({
      project: w.project,
      name: w.name,
      x0: dx,
      x1: dx + p.W - 1,
      agentIds: w.team.map((a) => a.id),
      door,
      spots,
      scrum: scrum ? { x0: scrum.x0 + dx, y0: scrum.y0, x1: scrum.x1 + dx, y1: scrum.y1 } : null,
    });
    dx += p.W;
  });
  if (parts.length) {
    building.door = building.wings[0].door;
    building.spots = building.wings[0].spots;
  }
  return building;
}

/** Namespaced id for an agent of another project. */
export const remoteId = (project: string, agentId: string) => `${project}/${agentId}`;
export const splitRemoteId = (id: string): { project: string; agentId: string } | null => {
  const i = id.indexOf("/");
  return i > 0 ? { project: id.slice(0, i), agentId: id.slice(i + 1) } : null;
};
