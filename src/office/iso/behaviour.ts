// What each robot does, derived from its agent's live status: where it walks,
// where it stops, which way it faces. Pure (no Pixi) so scripts/office-test.ts
// can drive it. Positions are tile-space floats; a robot standing on tile
// (tx, ty) is at (tx + 0.5, ty + 0.5).

import type { AgentStatus } from "../../data/types";
import type { Tile } from "../engine/path";
import type { IsoLayout } from "./layout";

/** What the robot shows. Session state wins over the agent state (a stopped agent isn't "idle"). */
export type Mode = "working" | "cheer" | "idle" | "needs-input" | "alert" | "stopped" | "starting";

export function modeOf(st: AgentStatus | undefined, now = Date.now()): Mode {
  if (!st) return "stopped";
  const s = st.session.state;
  if (s === "stopped") return "stopped";
  if (s === "starting") return "starting";
  if (s === "failed") return "alert";
  if (st.limitedUntil && new Date(st.limitedUntil).getTime() > now) return "alert";
  if (st.state === "needs-input") return "needs-input";
  if (st.state === "idle") return "idle";
  if (st.state === "review-passed") return "cheer";
  return "working";
}

/** Screen direction the sprite faces. +x is down-right (se), +y is down-left (sw). */
export type Facing = "ne" | "nw" | "se" | "sw";
export type Errand = "seat" | "wander" | "coffee" | "visit" | "huddle" | null;

const SPEED = 2.4; // tiles per second

export class IsoBot {
  x: number;
  y: number;
  path: Tile[] = [];
  facing: Facing = "sw";
  errand: Errand = null;
  pause = 0;
  /** Lead only: agent it is walking over to (set by the scene, cleared on the way back). */
  visit: string | null = null;
  /** Scrum-board spot to gather at while the lead plans (set by the scene), and how long to stay. */
  huddle: Tile | null = null;
  huddleFor = 4;
  mode: Mode = "stopped";

  constructor(public id: string, public isLead: boolean, start: Tile) {
    this.x = start[0] + 0.5;
    this.y = start[1] + 0.5;
  }

  tile(): Tile {
    return [Math.floor(this.x), Math.floor(this.y)];
  }

  at([tx, ty]: Tile): boolean {
    const [x, y] = this.tile();
    return x === tx && y === ty && !this.path.length;
  }

  place([tx, ty]: Tile) {
    this.x = tx + 0.5;
    this.y = ty + 0.5;
    this.path = [];
  }

  /** True when there is a way there. */
  goTo(l: IsoLayout, target: Tile): boolean {
    const [sx, sy] = this.tile();
    this.path = l.grid.find(sx, sy, target[0], target[1]);
    return this.path.length > 0 || this.at(target);
  }

  get moving(): boolean {
    return this.path.length > 0;
  }
}

/** Only agents that are up and not waiting on someone join a huddle. */
export const canHuddle = (mode: Mode) => mode === "working" || mode === "idle" || mode === "cheer";

export const seatOf = (l: IsoLayout, id: string): Tile | undefined => l.seats.find((s) => s.agentId === id)?.tile;

/** A walkable tile beside an agent's seat, for the lead to stand on. */
export function besideSeat(l: IsoLayout, id: string): Tile | undefined {
  const seat = seatOf(l, id);
  if (!seat) return;
  const [x, y] = seat;
  return ([[x - 1, y], [x + 1, y], [x, y + 1]] as Tile[]).find((t) => l.grid.ok(...t));
}

/** Where a robot in `mode` wants to be. Idle workers pick a break spot; everyone else heads for their seat. */
export function targetFor(bot: IsoBot, l: IsoLayout, mode: Mode, rand: () => number): { tile: Tile; errand: Errand } | null {
  const seat = seatOf(l, bot.id);
  if (bot.isLead && bot.visit) {
    const t = besideSeat(l, bot.visit);
    if (t) return { tile: t, errand: "visit" };
  }
  if (bot.huddle && canHuddle(mode)) return { tile: bot.huddle, errand: "huddle" };
  if (mode === "idle" && !bot.isLead) {
    const { coffee, wander } = l.spots;
    if (rand() < 0.4 && coffee.length) return { tile: coffee[Math.floor(rand() * coffee.length)], errand: "coffee" };
    if (wander.length) return { tile: wander[Math.floor(rand() * wander.length)], errand: "wander" };
  }
  return seat ? { tile: seat, errand: "seat" } : null;
}

/**
 * One simulation step: decide, walk, arrive. With `still` (reduced motion) robots
 * jump to their seat and never wander. A stopped robot that is already seated does nothing.
 */
export function update(bot: IsoBot, l: IsoLayout, mode: Mode, dt: number, rand: () => number, still = false) {
  const wasMode = bot.mode;
  bot.mode = mode;
  // Starting agents come in through the lobby door.
  if (mode === "starting" && wasMode === "stopped") bot.place(l.door);
  if (mode !== "idle" && (bot.errand === "wander" || bot.errand === "coffee")) {
    bot.errand = null;
    bot.pause = 0;
  }
  if (bot.huddle && !canHuddle(mode)) {
    bot.huddle = null;
    if (bot.errand === "huddle") (bot.errand = null), (bot.pause = 0), (bot.path = []);
  }
  bot.pause = Math.max(0, bot.pause - dt);

  if (bot.moving) {
    const [nx, ny] = bot.path[0];
    const dx = nx + 0.5 - bot.x;
    const dy = ny + 0.5 - bot.y;
    if (Math.abs(dx) > Math.abs(dy)) bot.facing = dx > 0 ? "se" : "nw";
    else bot.facing = dy > 0 ? "sw" : "ne";
    const dist = Math.hypot(dx, dy);
    const step = still ? Infinity : SPEED * dt;
    if (dist <= step) {
      bot.x = nx + 0.5;
      bot.y = ny + 0.5;
      bot.path.shift();
    } else {
      bot.x += (dx / dist) * step;
      bot.y += (dy / dist) * step;
    }
    if (bot.moving) return;
    // Arrived.
    if (bot.errand === "visit") {
      bot.pause = 2.5;
      const target = bot.visit ? seatOf(l, bot.visit) : undefined;
      if (target) bot.facing = target[0] > bot.tile()[0] ? "se" : target[0] < bot.tile()[0] ? "nw" : "sw";
    } else if (bot.errand === "huddle") {
      bot.pause = still ? 0 : bot.huddleFor;
      bot.facing = "ne"; // facing the board
      if (still) (bot.huddle = null), (bot.errand = null);
    } else if (bot.errand === "wander" || bot.errand === "coffee") {
      bot.pause = (bot.errand === "coffee" ? 2 : 1.5) + rand() * 3;
      if (bot.errand === "coffee") bot.facing = "ne";
    } else if (bot.errand === "seat") {
      bot.facing = "ne";
      bot.errand = null;
    }
    return;
  }

  if (bot.pause > 0) return;
  if (bot.errand === "visit") bot.visit = null; // visit over: go home
  if (bot.errand === "huddle") bot.huddle = null; // huddle over: back to work
  if (bot.errand === "wander" || bot.errand === "coffee") bot.errand = null;

  const want = targetFor(bot, l, still && mode === "idle" ? "working" : mode, rand);
  if (!want) return;
  if (bot.at(want.tile)) {
    if (want.errand === "seat") bot.facing = "ne";
    if (want.errand === "wander" || want.errand === "coffee") bot.pause = 1 + rand() * 2; // same spot again: linger
    return;
  }
  if (bot.goTo(l, want.tile)) bot.errand = want.errand;
  else if (want.errand === "visit") bot.visit = null;
}
