// Builds the isometric office from the team: one open floor with a glass lead
// office, a scrum corner and (for security work) a walled SOC along the back,
// desks in the middle, lobby and break area at the front. Pure: same team in,
// same building out. Tile coordinates; see proj.ts for the screen mapping.
//
//        y=0 ──────────── back wall (full height) ────────────
//   x=0 │ lead office (glass) │ scrum corner │ SOC (security) │
//       │ corridor                                            │
//       │ desk rows (desk · seat · aisle, pitch 3)            │
//       │ lobby (door, reception)  │ break (sofa, coffee)     │
//        ────────────── front wall (low, cut away) ──────────

import { inferDepartmentForRole } from "../../data/roles";
import type { DepartmentId, ProjectType } from "../../data/types";
import { WalkGrid, type Tile } from "../engine/path";
import { HALF_H, HALF_W } from "./proj";

export interface TeamMember {
  id: string;
  role: string;
  isLead: boolean;
  department?: DepartmentId;
}

export type ZoneKind = "lobby" | "floor" | "lead" | "scrum" | "break" | "soc";

export interface Zone {
  kind: ZoneKind;
  x0: number; // inclusive tile bounds
  y0: number;
  x1: number;
  y1: number;
  anchor: Tile; // a walkable tile inside, for reachability
}

export type ItemKind = "wall" | "desk" | "chair" | "plant" | "sofa" | "coffee" | "table" | "counter" | "rack" | "mat" | "cabinet";

export interface Item {
  kind: ItemKind;
  x: number;
  y: number;
  /** Wall run direction(s); other items ignore it. */
  dir?: "x" | "y" | "xy";
  low?: boolean; // cut-away wall on the viewer's side
  glass?: boolean;
  dark?: boolean; // SOC styling
  lead?: boolean; // gold-trimmed desk
  decal?: "board" | "screen" | "sign";
  i?: number; // slice index for multi-tile decals
}

export interface Seat {
  agentId: string;
  tile: Tile;
  zone: ZoneKind;
}

export interface IsoLayout {
  key: string;
  W: number;
  H: number;
  /** Screen offset of tile (0, 0) inside the world canvas. */
  origin: { x: number; y: number };
  worldW: number;
  worldH: number;
  zones: Zone[];
  items: Item[];
  seats: Seat[];
  door: Tile;
  spots: { wander: Tile[]; coffee: Tile[]; scrum: Tile[] };
  grid: WalkGrid;
}

export const WALL_H = 40;
export const LOW_WALL_H = 8;
const PAD = 24;
const Y_WALL = 7; // back rooms span y = 1..6
const Y_DESK0 = 9; // y = 8 is the corridor
const LOBBY_D = 5;

export function isoLayoutKey(team: TeamMember[], type: ProjectType): string {
  return JSON.stringify([type, team.map((a) => [a.id, a.role, a.department ?? "", a.isLead])]);
}

export const hasSoc = (team: TeamMember[], type: ProjectType) => type === "security" || team.some((a) => dept(a) === "red-team");

const dept = (a: TeamMember) => inferDepartmentForRole(a.role, a.isLead, a.department);

export function generateIsoLayout(team: TeamMember[], type: ProjectType): IsoLayout {
  const leads = team.filter((a) => a.isLead);
  const workers = team.filter((a) => !a.isLead);
  const soc = hasSoc(team, type);
  const socWorkers = soc ? workers.filter((a) => dept(a) === "red-team") : [];
  const floorWorkers = workers.filter((a) => !socWorkers.includes(a));

  // ---------------------------------------------------------- widths
  const leadW = Math.max(7, 3 * Math.max(1, leads.length) + 1); // office interior x = 1..leadW
  const xGlass = leadW + 1;
  const scrumX0 = xGlass + 1;
  const scrumX1 = scrumX0 + 6;
  const xSoc = scrumX1 + 1; // SOC west wall column
  const socW = Math.max(9, 3 * socWorkers.length + 3);
  const backX1 = soc ? xSoc + socW : scrumX1;
  const cols = Math.max(1, Math.min(floorWorkers.length, Math.floor((backX1 - 1) / 3)));
  const rows = Math.max(1, Math.ceil(floorWorkers.length / cols));
  const yLobby = Y_DESK0 + 3 * rows + 1;
  const W = Math.max(backX1, 2 + 3 * cols, 15) + 2;
  const H = yLobby + LOBBY_D + 1;
  const door: Tile = [3, H - 1];

  const items: Item[] = [];
  const seats: Seat[] = [];
  const grid = new WalkGrid(W, H);
  grid.set(1, 1, W - 2, H - 2, true);
  grid.set(door[0], door[1], door[0], door[1], true);
  const block = (x: number, y: number) => grid.set(x, y, x, y, false);
  const put = (item: Item) => {
    items.push(item);
    if (item.kind !== "mat") block(item.x, item.y);
  };

  // ---------------------------------------------------------- walls
  // Walls are tiles; their run direction comes from their neighbours below.
  const walls = new Map<string, Omit<Item, "kind" | "x" | "y" | "dir">>();
  const wall = (x: number, y: number, w: Omit<Item, "kind" | "x" | "y" | "dir"> = {}) => walls.set(`${x},${y}`, { ...walls.get(`${x},${y}`), ...w });
  for (let x = 0; x < W; x++) (wall(x, 0), wall(x, H - 1, { low: true }));
  for (let y = 0; y < H; y++) (wall(0, y), wall(W - 1, y, { low: true }));
  for (let y = 1; y <= Y_WALL; y++) wall(xGlass, y, { glass: true });
  for (let x = 1; x <= xGlass; x++) wall(x, Y_WALL, { glass: true });
  for (let i = scrumX0; i <= scrumX1; i++) wall(i, 0, { decal: "board", i: i - scrumX0 });
  if (soc) {
    for (let y = 1; y <= Y_WALL; y++) wall(xSoc, y, { dark: true });
    for (let x = xSoc; x <= xSoc + socW; x++) wall(x, Y_WALL, { dark: true, low: true });
    for (let i = 1; i <= socW; i++) wall(xSoc + i, 0, { dark: true, decal: "screen", i: i - 1 });
    if (xSoc + socW === W - 1) for (let y = 1; y <= Y_WALL; y++) wall(W - 1, y, { dark: true, low: true });
  }
  const doors: Tile[] = [door, [2, Y_WALL], ...(soc ? [[xSoc + 2, Y_WALL] as Tile] : [])];
  for (const [x, y] of doors) walls.delete(`${x},${y}`);
  for (const [k, w] of walls) {
    const [x, y] = k.split(",").map(Number);
    const rx = walls.has(`${x - 1},${y}`) || walls.has(`${x + 1},${y}`);
    const ry = walls.has(`${x},${y - 1}`) || walls.has(`${x},${y + 1}`);
    put({ kind: "wall", x, y, dir: rx && ry ? "xy" : ry ? "y" : "x", ...w });
  }

  // ---------------------------------------------------------- back rooms
  const desk = (x: number, y: number, a: TeamMember, zone: ZoneKind, style: Partial<Item> = {}) => {
    put({ kind: "desk", x, y, i: 0, ...style });
    put({ kind: "desk", x: x + 1, y, i: 1, ...style });
    put({ kind: "chair", x, y: y + 1, ...style });
    seats.push({ agentId: a.id, tile: [x, y + 1], zone });
  };
  leads.forEach((a, i) => desk(2 + 3 * i, 2, a, "lead", { lead: true }));
  put({ kind: "cabinet", x: leadW, y: 1 });
  put({ kind: "plant", x: leadW, y: Y_WALL - 1 });
  put({ kind: "plant", x: scrumX1, y: 1 });
  put({ kind: "table", x: scrumX0 + 3, y: 4 });
  if (soc) {
    put({ kind: "rack", x: xSoc + 1, y: 1 });
    put({ kind: "rack", x: xSoc + 1, y: 2 });
    socWorkers.forEach((a, i) => desk(xSoc + 3 + 3 * i, 3, a, "soc", { dark: true }));
  }

  // ---------------------------------------------------------- work floor
  floorWorkers.forEach((a, i) => desk(2 + 3 * (i % cols), Y_DESK0 + 3 * Math.floor(i / cols), a, "floor"));
  put({ kind: "plant", x: W - 2, y: Y_DESK0 });

  // ---------------------------------------------------------- lobby + break
  put({ kind: "mat", x: door[0], y: H - 2 });
  for (let i = 0; i < 3; i++) put({ kind: "counter", x: 5 + i, y: yLobby + 1, decal: "sign", i });
  put({ kind: "plant", x: 1, y: yLobby });
  put({ kind: "plant", x: 8, y: H - 2 });
  put({ kind: "sofa", x: 10, y: yLobby + 1, i: 0 });
  put({ kind: "sofa", x: 11, y: yLobby + 1, i: 1 });
  put({ kind: "table", x: 11, y: yLobby + 3 });
  put({ kind: "counter", x: W - 4, y: yLobby });
  put({ kind: "coffee", x: W - 3, y: yLobby });
  put({ kind: "plant", x: W - 2, y: H - 2 });

  const zones: Zone[] = [
    { kind: "lead", x0: 1, y0: 1, x1: leadW, y1: Y_WALL - 1, anchor: [3, 5] },
    { kind: "scrum", x0: scrumX0, y0: 1, x1: scrumX1, y1: Y_WALL, anchor: [scrumX0 + 2, 2] },
    { kind: "floor", x0: 1, y0: Y_WALL + 1, x1: W - 2, y1: yLobby - 1, anchor: [1, Y_DESK0 - 1] },
    { kind: "lobby", x0: 1, y0: yLobby, x1: 8, y1: H - 2, anchor: [3, H - 2] },
    { kind: "break", x0: 9, y0: yLobby, x1: W - 2, y1: H - 2, anchor: [10, yLobby + 2] },
  ];
  if (soc) zones.push({ kind: "soc", x0: xSoc + 1, y0: 1, x1: xSoc + socW, y1: Y_WALL - 1, anchor: [xSoc + 2, 5] });

  const wander: Tile[] = [[1, Y_DESK0 + 1], [W - 3, Y_DESK0 + 1], [9, yLobby + 3], [W - 2, yLobby + 3], [scrumX0 + 1, 5]];
  const scrum: Tile[] = [scrumX0 + 1, scrumX0 + 2, scrumX0 + 4, scrumX0 + 5].map((x) => [x, 2] as Tile);
  const coffee: Tile[] = [[W - 3, yLobby + 1], [W - 4, yLobby + 1]];

  const origin = { x: H * HALF_W + PAD, y: PAD + WALL_H + 24 };
  return {
    key: isoLayoutKey(team, type),
    W,
    H,
    origin,
    worldW: (W + H) * HALF_W + 2 * PAD,
    worldH: (W + H) * HALF_H + origin.y + PAD + 12,
    zones,
    items,
    seats,
    door,
    spots: { wander: wander.filter(([x, y]) => grid.ok(x, y)), coffee, scrum },
    grid,
  };
}

/** The zone a tile belongs to (rooms along the back win over the floor). */
export function zoneAt(l: IsoLayout, x: number, y: number): Zone | undefined {
  return l.zones.find((z) => z.kind !== "floor" && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) ?? l.zones.find((z) => z.kind === "floor");
}
