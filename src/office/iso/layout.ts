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

import { WalkGrid, type Tile } from "../engine/path";
import { HALF_H, HALF_W } from "./proj";

export interface TeamMember {
  id: string;
  role: string;
  isLead: boolean;
  roleId?: string;
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

export type ItemKind =
  | "wall" | "desk" | "chair" | "plant" | "sofa" | "coffee" | "table" | "counter" | "rack" | "mat" | "cabinet" | "rug" | "shelf" | "whiteboard" | "cooler"
  | "vending" | "arcade" | "pingpong" | "beanbag" | "lamp" | "printer" | "tv";

export interface Item {
  kind: ItemKind;
  x: number;
  y: number;
  /** Wall run direction(s); other items ignore it. */
  dir?: "x" | "y" | "xy";
  /** Which run(s) end at this tile on the viewer's side, so the end face is drawn once per run. */
  cap?: "x" | "y" | "xy";
  low?: boolean; // cut-away wall on the viewer's side
  glass?: boolean;
  dark?: boolean; // SOC styling
  lead?: boolean; // gold-trimmed desk
  screen?: "off" | "glow"; // desk monitor: dark when the agent is stopped, bright when working (default: on)
  decal?: "board" | "screen" | "sign" | "window" | "poster";
  label?: string; // lobby sign text (default: the product name)
  i?: number; // slice index for multi-tile decals and two-part furniture
  n?: number; // slice count
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
  spots: Spots;
  grid: WalkGrid;
  /** Building of several projects: each agent's own wing door and spots (missing → `door` / `spots`). */
  doors?: Map<string, Tile>;
  agentSpots?: Map<string, Spots>;
  /** The HQ hall's spots: agents with no work go here instead of their own wing. */
  commons?: Commons;
}

export interface Spots {
  wander: Tile[];
  coffee: Tile[];
  scrum: Tile[];
}

export interface IsoOptions {
  /** Make the office at least this deep, so wings of one building line up. */
  minH?: number;
  /** Text on the lobby sign. */
  sign?: string;
}

export const doorOf = (l: IsoLayout, id: string): Tile => l.doors?.get(id) ?? l.door;
export const spotsOf = (l: IsoLayout, id: string): Spots => l.agentSpots?.get(id) ?? l.spots;

export const WALL_H = 40;
export const LOW_WALL_H = 8;
export const PAD = 24;
const Y_WALL = 6; // back rooms span y = 1..5
const Y_DESK0 = 8; // y = 7 is the corridor
const LOBBY_D = 4;

export function isoLayoutKey(team: TeamMember[], secure: boolean): string {
  return JSON.stringify([secure, team.map((a) => [a.id, a.role, a.roleId ?? "", a.isLead])]);
}

type WallStyle = Omit<Item, "kind" | "x" | "y" | "dir">;

/** Night-city windows in pairs along the back wall, a poster between; tiles that already carry a board or screen keep it. */
function dressBackWall(walls: Map<string, WallStyle>, W: number) {
  for (let x = 1; x < W - 1; x++) {
    const k = `${x},0`;
    const w = walls.get(k);
    if (!w || w.decal || w.dark || w.glass) continue;
    const m = x % 5;
    if (m === 1 || m === 2) walls.set(k, { ...w, decal: "window", i: x });
    else if (m === 4) walls.set(k, { ...w, decal: "poster", i: x });
  }
}

/** Turns wall tiles into items: each one's run direction and end caps come from its neighbours. */
function placeWalls(walls: Map<string, WallStyle>, put: (it: Item) => void) {
  for (const [k, w] of walls) {
    const [x, y] = k.split(",").map(Number);
    const rx = walls.has(`${x - 1},${y}`) || walls.has(`${x + 1},${y}`);
    const ry = walls.has(`${x},${y - 1}`) || walls.has(`${x},${y + 1}`);
    const dir = rx && ry ? "xy" : ry ? "y" : "x";
    const cx = dir !== "y" && !walls.has(`${x + 1},${y}`);
    const cy = dir !== "x" && !walls.has(`${x},${y + 1}`);
    put({ kind: "wall", x, y, dir, ...(cx || cy ? { cap: cx && cy ? "xy" : cy ? "y" : "x" } : {}), ...w });
  }
}

/** Where agents with no work go: lounges, a coffee bar and the reception, shared by every project. */
export interface Commons {
  wander: Tile[];
  coffee: Tile[];
  /** Sofa-side spots for stopped agents: one each, they stay put. */
  rest: Tile[];
}

export const HALL_D = 9;

/**
 * The HQ hall: a W × HALL_D room every project's agents share. Its back wall is glass with
 * `openings` (x) onto the street in front of the wings; the main door is in the front wall.
 */
export function generateCommons(W: number, openings: number[]): { items: Item[]; zones: Zone[]; grid: WalkGrid; door: Tile; commons: Commons } {
  const D = HALL_D;
  const items: Item[] = [];
  const grid = new WalkGrid(W, D);
  grid.set(1, 1, W - 2, D - 2, true);
  const door: Tile = [Math.floor(W / 2), D - 1];
  grid.set(door[0], door[1], door[0], door[1], true);
  for (const x of openings) grid.set(x, 0, x, 0, true);
  const put = (it: Item) => {
    items.push(it);
    if (it.kind !== "mat" && it.kind !== "rug") grid.set(it.x, it.y, it.x, it.y, false);
  };
  const walls = new Map<string, WallStyle>();
  for (let x = 0; x < W; x++) (walls.set(`${x},0`, { glass: true }), walls.set(`${x},${D - 1}`, { low: true }));
  for (let y = 0; y < D; y++) (walls.set(`0,${y}`, {}), walls.set(`${W - 1},${y}`, { low: true }));
  for (const x of [...openings, door[0]]) (walls.delete(`${x},0`), walls.delete(`${x},${D - 1}`));
  placeWalls(walls, put);

  // Reception with the big sign, facing the main door.
  const sx = Math.max(2, door[0] - 2);
  for (let i = 0; i < 5; i++) put({ kind: "counter", x: sx + i, y: 3, decal: "sign", i, n: 5 });
  put({ kind: "mat", x: door[0], y: D - 2 });
  const wander: Tile[] = [];
  const rest: Tile[] = [];
  // Lounges every 9 tiles either side of the reception: rug, sofa, table.
  for (let x0 = 2; x0 + 4 < W - 1; x0 += 9) {
    if (x0 + 4 >= sx - 1 && x0 <= sx + 5) continue;
    for (let y = 4; y <= 6; y++) for (let x = x0; x <= x0 + 2; x++) put({ kind: "rug", x, y, i: x - x0 + 3 * (y - 4), n: 3 });
    put({ kind: "sofa", x: x0, y: 4, i: 0 });
    put({ kind: "sofa", x: x0 + 1, y: 4, i: 1 });
    put({ kind: "table", x: x0 + 1, y: 6 });
    put({ kind: "plant", x: x0 + 3, y: 2 });
    rest.push([x0, 5], [x0 + 2, 5], [x0 + 2, 4], [x0, 6], [x0 + 2, 6]);
    wander.push([x0 + 3, 5], [x0 + 1, 7]);
  }
  // Extras only where nothing stands yet (narrow halls skip some).
  const free = (x: number, y: number) => grid.ok(x, y) && !items.some((it) => it.x === x && it.y === y);
  const extra = (...its: Item[]) => {
    if (its.every((it) => free(it.x, it.y))) for (const it of its) put(it);
  };
  // Games corner west of the reception: arcade cabinets and a ping-pong table; a TV and bean bags east.
  extra({ kind: "arcade", x: 1, y: 3 });
  extra({ kind: "arcade", x: 1, y: 4 });
  extra({ kind: "pingpong", x: sx - 4, y: 6, i: 0 }, { kind: "pingpong", x: sx - 3, y: 6, i: 1 });
  extra({ kind: "tv", x: sx + 6, y: 1 });
  extra({ kind: "beanbag", x: sx + 6, y: 3 }, { kind: "beanbag", x: sx + 8, y: 3 });
  extra({ kind: "vending", x: W - 5, y: 1 });
  extra({ kind: "lamp", x: sx - 1, y: 1 });
  extra({ kind: "lamp", x: W - 2, y: 6 });
  // Coffee bar along the east wall.
  put({ kind: "counter", x: W - 4, y: 1 });
  put({ kind: "coffee", x: W - 3, y: 1 });
  put({ kind: "cooler", x: W - 2, y: 3 });
  put({ kind: "plant", x: 1, y: 1 });
  put({ kind: "plant", x: W - 2, y: D - 2 });
  put({ kind: "shelf", x: 1, y: D - 3, i: 0 });
  const coffee: Tile[] = [[W - 3, 2], [W - 4, 2]];
  wander.push([door[0], D - 3], [sx - 1, 2], [sx + 5, 2], [W - 3, 5]);
  if (!rest.length) rest.push([door[0] - 2, 6], [door[0] + 2, 6], [door[0] - 1, 6], [door[0] + 1, 6]);
  const ok = (t: Tile) => grid.ok(t[0], t[1]);
  const zones: Zone[] = [
    { kind: "lobby", x0: sx - 1, y0: 1, x1: sx + 5, y1: D - 2, anchor: [door[0], D - 2] },
    { kind: "break", x0: 1, y0: 1, x1: W - 2, y1: D - 2, anchor: [door[0], D - 3] },
  ];
  return { items, zones, grid, door, commons: { wander: wander.filter(ok), coffee: coffee.filter(ok), rest: rest.filter(ok) } };
}

/** `secure`: security work; its workers sit in the SOC (rooms per flow stage come in Phase 5). */
export function generateIsoLayout(team: TeamMember[], secure: boolean, opts: IsoOptions = {}): IsoLayout {
  const leads = team.filter((a) => a.isLead);
  const workers = team.filter((a) => !a.isLead);
  const soc = secure;
  const socWorkers = soc ? workers : [];
  const floorWorkers = workers.filter((a) => !socWorkers.includes(a));

  // ---------------------------------------------------------- widths
  const leadW = Math.max(5, 3 * Math.max(1, leads.length) + 1); // office interior x = 1..leadW
  const xGlass = leadW + 1;
  const scrumX0 = xGlass + 1;
  const scrumX1 = scrumX0 + 4;
  const xSoc = scrumX1 + 1; // SOC west wall column
  const socW = Math.max(9, 3 * socWorkers.length + 3); // the screen wall's world map needs 8 tiles plus a margin
  const backX1 = soc ? xSoc + socW : scrumX1;
  const cols = Math.max(1, Math.min(floorWorkers.length, Math.floor((backX1 - 1) / 3)));
  const rows = Math.ceil(floorWorkers.length / cols); // 0 when everyone sits in the back rooms
  const yLobby = Y_DESK0 + 3 * rows + 1;
  const W = Math.max(backX1, 2 + 3 * cols, 13) + 2;
  const H = Math.max(yLobby + LOBBY_D + 1, opts.minH ?? 0);
  const door: Tile = [3, H - 1];

  const items: Item[] = [];
  const seats: Seat[] = [];
  const grid = new WalkGrid(W, H);
  grid.set(1, 1, W - 2, H - 2, true);
  grid.set(door[0], door[1], door[0], door[1], true);
  const block = (x: number, y: number) => grid.set(x, y, x, y, false);
  const put = (item: Item) => {
    items.push(item);
    if (item.kind !== "mat" && item.kind !== "rug") block(item.x, item.y);
  };

  // ---------------------------------------------------------- walls
  // Walls are tiles; their run direction comes from their neighbours below.
  const walls = new Map<string, Omit<Item, "kind" | "x" | "y" | "dir">>();
  const wall = (x: number, y: number, w: Omit<Item, "kind" | "x" | "y" | "dir"> = {}) => walls.set(`${x},${y}`, { ...walls.get(`${x},${y}`), ...w });
  for (let x = 0; x < W; x++) (wall(x, 0), wall(x, H - 1, { low: true }));
  for (let y = 0; y < H; y++) (wall(0, y), wall(W - 1, y, { low: true }));
  for (let y = 1; y <= Y_WALL; y++) wall(xGlass, y, { glass: true });
  for (let x = 1; x <= xGlass; x++) wall(x, Y_WALL, { glass: true });
  for (let i = scrumX0; i <= scrumX1; i++) wall(i, 0, { decal: "board", i: i - scrumX0, n: 5 });
  if (soc) {
    for (let y = 1; y <= Y_WALL; y++) wall(xSoc, y, { dark: true });
    for (let x = xSoc; x <= xSoc + socW; x++) wall(x, Y_WALL, { dark: true, low: true });
    for (let i = 1; i <= socW; i++) wall(xSoc + i, 0, { dark: true, decal: "screen", i: i - 1, n: socW });
    if (xSoc + socW === W - 1) for (let y = 1; y <= Y_WALL; y++) wall(W - 1, y, { dark: true, low: true });
  }
  dressBackWall(walls, W);
  const doors: Tile[] = [door, [2, Y_WALL], ...(soc ? [[xSoc + 2, Y_WALL] as Tile] : [])];
  for (const [x, y] of doors) walls.delete(`${x},${y}`);
  placeWalls(walls, put);

  // ---------------------------------------------------------- back rooms
  const desk = (x: number, y: number, a: TeamMember, zone: ZoneKind, style: Partial<Item> = {}) => {
    put({ kind: "desk", x, y, i: 0, ...style });
    put({ kind: "desk", x: x + 1, y, i: 1, ...style });
    put({ kind: "chair", x, y: y + 1, ...style });
    seats.push({ agentId: a.id, tile: [x, y + 1], zone });
  };
  leads.forEach((a, i) => desk(2 + 3 * i, 2, a, "lead", { lead: true }));
  put({ kind: "cabinet", x: leadW, y: 1 });
  put({ kind: "plant", x: 1, y: Y_WALL - 1 });
  put({ kind: "plant", x: scrumX1, y: 1 });
  put({ kind: "table", x: scrumX0 + 2, y: 4 });
  if (soc) {
    put({ kind: "rack", x: xSoc + 1, y: 1 });
    put({ kind: "rack", x: xSoc + 1, y: 2 });
    socWorkers.forEach((a, i) => desk(xSoc + 3 + 3 * i, 3, a, "soc", { dark: true }));
  }

  // ---------------------------------------------------------- work floor
  floorWorkers.forEach((a, i) => desk(2 + 3 * (i % cols), Y_DESK0 + 3 * Math.floor(i / cols), a, "floor"));
  // East end: a bookcase along the corridor wall, a whiteboard and a plant by the east wall.
  put({ kind: "shelf", x: W - 3, y: Y_WALL + 1, i: 0 });
  put({ kind: "shelf", x: W - 2, y: Y_WALL + 1, i: 1 });
  put({ kind: "whiteboard", x: W - 2, y: Y_DESK0 });
  if (rows) put({ kind: "plant", x: W - 2, y: yLobby - 1 });

  // ---------------------------------------------------------- lobby + break
  put({ kind: "mat", x: door[0], y: H - 2 });
  for (let i = 0; i < 5; i++) put({ kind: "counter", x: 4 + i, y: yLobby + 1, decal: "sign", i, n: 5, ...(opts.sign ? { label: opts.sign } : {}) });
  put({ kind: "plant", x: 1, y: yLobby });
  put({ kind: "plant", x: 8, y: H - 2 });
  for (let y = yLobby + 1; y <= yLobby + 3; y++) for (let x = 10; x <= 12; x++) put({ kind: "rug", x, y, i: x - 10 + 3 * (y - yLobby - 1), n: 3 });
  put({ kind: "sofa", x: 10, y: yLobby + 1, i: 0 });
  put({ kind: "sofa", x: 11, y: yLobby + 1, i: 1 });
  put({ kind: "table", x: 11, y: yLobby + 3 });
  put({ kind: "counter", x: W - 4, y: yLobby });
  put({ kind: "coffee", x: W - 3, y: yLobby });
  put({ kind: "vending", x: W - 5, y: yLobby });
  put({ kind: "lamp", x: 9, y: yLobby + 1 });
  put({ kind: "printer", x: W - 4, y: Y_WALL + 1 });
  put({ kind: "tv", x: leadW - 1, y: 1 });
  put({ kind: "cooler", x: W - 2, y: yLobby + 2 });
  put({ kind: "plant", x: W - 2, y: H - 2 });

  const zones: Zone[] = [
    { kind: "lead", x0: 1, y0: 1, x1: leadW, y1: Y_WALL - 1, anchor: [3, 5] },
    { kind: "scrum", x0: scrumX0, y0: 1, x1: scrumX1, y1: Y_WALL, anchor: [scrumX0 + 2, 2] },
    { kind: "floor", x0: 1, y0: Y_WALL + 1, x1: W - 2, y1: yLobby - 1, anchor: [1, Y_DESK0 - 1] },
    { kind: "lobby", x0: 1, y0: yLobby, x1: 8, y1: H - 2, anchor: [3, H - 2] },
    { kind: "break", x0: 9, y0: yLobby, x1: W - 2, y1: H - 2, anchor: [10, yLobby + 2] },
  ];
  if (soc) zones.push({ kind: "soc", x0: xSoc + 1, y0: 1, x1: xSoc + socW, y1: Y_WALL - 1, anchor: [xSoc + 2, 5] });

  const wander: Tile[] = [[1, Y_DESK0 + 1], [W - 3, Y_DESK0], [9, yLobby + 3], [W - 3, yLobby + 3], [scrumX0 + 1, 5]];
  const scrum: Tile[] = [[scrumX0 + 1, 3], [scrumX0 + 3, 3], [scrumX0 + 1, 5], [scrumX0 + 3, 5]];
  const coffee: Tile[] = [[W - 3, yLobby + 1], [W - 2, yLobby + 1]];

  const origin = { x: H * HALF_W + PAD, y: PAD + WALL_H + 24 };
  return {
    key: isoLayoutKey(team, secure),
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
