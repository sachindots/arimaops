// Isometric robot sprites, 16 px wide, drawn from character rows and recoloured
// per agent. Two drawn facings (se = front, ne = back); sw and nw are mirrors.
// The lead wears the mascot's crown and a gold mane ring around its face.
// Separate from draw/robots.ts, which the HUD portraits share.

import { shade } from "../../theme/tokens";
import { flipCanvas, spriteCanvas } from "../engine/pen";
import type { Facing } from "./behaviour";

export const ISO_ROBOT_W = 16;

// k ink · B body · b shade · h highlight · V visor · E eye · r alarmed eye · L chest light
// A antenna bulb · Y crown · M mane · m mane shade
const HAT_ANTENNA = ["......kAAk......", ".......kk.......", ".......kk......."];
const HAT_CROWN = ["...kYk.kYk.kYk..", "...kYYkYYYkYYk..", "...kYYYYYYYYYk.."];
const HEAD_FRONT = [
  "...kkkkkkkkkk...",
  "..khhhBBBBBBBk..",
  "..khBBBBBBBBBk..",
  "..kBBBkkkkkkkk..",
  "..kBBkVVVVVVVk..",
  "..kBBkVEEVEEVk..",
  "..kBBkVEEVEEVk..",
  "..kBBBkkkkkkkk..",
  "..kbbBBBBBBBbk..",
  "...kkkkkkkkkk...",
];
const HEAD_BACK = [
  "...kkkkkkkkkk...",
  "..khhhBBBBBBBk..",
  "..khBBBBBBBBBk..",
  "..kBBBBBBBBBBk..",
  "..kBBBkbbbkBBk..",
  "..kBBBkbbbkBBk..",
  "..kBBBBkkkBBBk..",
  "..kBBBBBBBBBBk..",
  "..kbbBBBBBBBbk..",
  "...kkkkkkkkkk...",
];
const BODY_FRONT = ["...kkkkkkkkkk...", ".kBkBBBLLBBBkBk.", ".kBkBBBBBBBBkBk.", ".kbkbBBBBBBbkbk.", ".kkkkbbbbbbbkkk.", "....kkkkkkkk...."];
const BODY_BACK = ["...kkkkkkkkkk...", ".kBkBBBBBBBBkBk.", ".kBkBbbbbbbBkBk.", ".kbkBbbbbbbBkbk.", ".kkkkBBBBBBBkkk.", "....kkkkkkkk...."];
// Typing: arms raised one row (the first row overlaps the head's bottom outline).
const BODY_TYPE = [".kkk........kkk.", ".kBkkkkkkkkkkBk.", ".kBkBBBBBBBBkBk.", ".kbkBbbbbbbBkbk.", ".kkkBbbbbbbBkkk.", "...kkBBBBBBBkk..", "....kkkkkkkk...."];
// Cheer: arms straight up (the first two rows overlap the head).
const BODY_CHEER = [".kkk........kkk.", ".kBk........kBk.", ".kBkkkkkkkkkkBk.", ".kBkBBBLLBBBkBk.", ".kbkBBBBBBBBkbk.", ".kkkbBBBBBBbkkk.", "...kbbbbbbbbk...", "....kkkkkkkk...."];
// Alert: arms out sideways.
const BODY_ALERT = ["...kkkkkkkkkk...", "kkkkBBBLLBBBkkkk", "kBBkBBBBBBBBkBBk", "kkkkbBBBBBBbkkkk", "....kbbbbbbbk...", "....kkkkkkkk...."];
const LEGS_STAND = ["....kBk..kBk....", "....kBk..kBk....", "....kbk..kbk....", "....kbk..kbk....", "...kkbbk.kbbkk..", "...kkkkk.kkkkk.."];
const LEGS_A = ["....kBk..kBk....", "....kBk..kBk....", "....kbk.kkbbk...", "....kbk.kkkkk...", "...kkbbk........", "...kkkkk........"];
const LEGS_B = ["....kBk..kBk....", "....kBk..kBk....", "...kkbbk.kbk....", "...kkkkk.kbk....", ".........kbbkk..", ".........kkkkk.."];
const LEGS_SIT = ["....kbk..kbk....", "....kkk..kkk...."];

export type Pose = "walk" | "stand" | "sit" | "cheer" | "alert";

/** Stacks parts; `overlap` rows of each next part are merged over the previous part's tail (non-'.' wins). */
function stack(parts: [rows: string[], overlap: number][]): string[] {
  const out: string[] = [];
  for (const [rows, overlap] of parts) {
    const base = out.length - overlap;
    rows.forEach((row, i) => {
      const j = base + i;
      if (j < out.length) out[j] = [...out[j]].map((ch, c) => (row[c] !== "." ? row[c] : ch)).join("");
      else out.push(row);
    });
  }
  return out;
}

/** Gold ring around the face for the lead, matching the mascot's mane. */
const mane = (head: string[]) =>
  head.map((row, r) => [...row].map((ch, c) => ((r <= 2 || r >= 8 || c <= 4 || c >= 11) && "Bhb".includes(ch) ? (ch === "b" ? "m" : "M") : ch)).join(""));

const cache = new Map<string, Record<string, HTMLCanvasElement>>();

/** Every frame for one look, keyed `${facing}.${pose}${index}`; walk has 3 frames, sit 2, the rest 1. */
export function isoRobotFrames(color: string, lead: boolean): Record<string, HTMLCanvasElement> {
  const key = `${color}|${lead}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pal: Record<string, string> = {
    k: "#05060b", B: color, b: shade(color, -0.35), h: shade(color, 0.55), V: "#101a30", E: "#7df3ff", r: "#ff3b3b",
    L: shade(color, 0.75), A: shade(color, 0.5), Y: "#FFD166", M: "#E8B339", m: "#B9791C",
  };
  const hat = lead ? HAT_CROWN : HAT_ANTENNA;
  const front = lead ? mane(HEAD_FRONT) : HEAD_FRONT;
  const back = lead ? mane(HEAD_BACK) : HEAD_BACK;
  const alarmed = front.map((r) => r.replace(/E/g, "r"));
  const out: Record<string, HTMLCanvasElement> = {};
  const add = (name: string, rows: string[]) => {
    const c = spriteCanvas(rows, pal);
    const f = flipCanvas(c);
    const [a, b] = name.startsWith("se") ? ["se", "sw"] : ["ne", "nw"];
    out[name.replace(/^../, a)] = c;
    out[name.replace(/^../, b)] = f;
  };
  for (const [facing, head, body] of [["se", front, BODY_FRONT], ["ne", back, BODY_BACK]] as const) {
    [LEGS_STAND, LEGS_A, LEGS_B].forEach((legs, i) => add(`${facing}.walk${i}`, stack([[hat, 0], [head, 0], [body, 0], [legs, 0]])));
    add(`${facing}.stand0`, stack([[hat, 0], [head, 0], [body, 0], [LEGS_STAND, 0]]));
    add(`${facing}.sit0`, stack([[hat, 0], [head, 0], [body, 0], [LEGS_SIT, 0]]));
    add(`${facing}.sit1`, stack([[hat, 0], [head, 0], [BODY_TYPE, 1], [LEGS_SIT, 0]]));
    add(`${facing}.cheer0`, stack([[hat, 0], [head, 0], [BODY_CHEER, 2], [LEGS_STAND, 0]]));
    add(`${facing}.alert0`, stack([[hat, 0], [facing === "se" ? alarmed : head, 0], [BODY_ALERT, 0], [LEGS_STAND, 0]]));
  }
  cache.set(key, out);
  return out;
}

/** The frame to show now. */
export function frameKey(facing: Facing, pose: Pose, t: number, seed = 0): string {
  if (pose === "walk") return `${facing}.walk${[0, 1, 0, 2][Math.floor(t * 7 + seed) % 4]}`;
  if (pose === "sit") return `${facing}.sit${Math.floor(t * 4 + seed) % 2}`;
  return `${facing}.${pose}0`;
}

/** Speech bubble with a glyph: "?" (needs input) or "!" (alert). */
export function bubbleCanvas(glyph: "?" | "!"): HTMLCanvasElement {
  const red = glyph === "!";
  const rows = red
    ? [".kkkkkkkkk.", "kWWWWWWWWWk", "kWWWWrWWWWk", "kWWWWrWWWWk", "kWWWWrWWWWk", "kWWWWrWWWWk", "kWWWWWWWWWk", "kWWWWrWWWWk", ".kkkkkkkkk.", "....kWk....", ".....k....."]
    : [".kkkkkkkkk.", "kWWWWWWWWWk", "kWWWqqqWWWk", "kWWWWWWqWWk", "kWWWWWqWWWk", "kWWWWWqWWWk", "kWWWWWWWWWk", "kWWWWWqWWWk", ".kkkkkkkkk.", "....kWk....", ".....k....."];
  return spriteCanvas(rows, { k: "#05060b", W: red ? "#ff3b3b" : "#F3EDE0", r: "#fff3f3", q: "#0B1220" });
}
