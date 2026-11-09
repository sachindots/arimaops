// Hover-robot sprites, recoloured per agent. The lead wears a crown.

// No Pixi at runtime here: HUD portraits use these canvases, and the office (Pixi) loads only when shown.
import { shade } from "../../theme/tokens";
import { C } from "../engine/palette";
import { flipCanvas, spriteCanvas } from "../engine/pen";

// 14×17 robots: 3 rows of antenna/crown, then head (visor rows 6–7, where overlay.drawFace paints the
// eyes) and body. Eyes and the antenna bulb are drawn live so they show the agent's state; portraits bake them.
// k outline · B body · b shade · h highlight · V visor · L chest light · G gold · j hover jet
const HEAD_ANTENNA = ["......kk......", ".....k..k.....", "......kk......"];
const HEAD_CROWN = ["..k...kk...k..", "..kGk.GG.kGk..", "..kGGGGGGGGk.."];
const HEAD_FRONT = ["...kkkkkkkk...", "..khhhBBBBBk..", ".khBBBBBBBBBk.", "kBkVVVVVVVVkBk", "kBkVVVVVVVVkBk", ".kbBBBBBBBBbk.", "..kkkkkkkkkk.."];
const HEAD_BACK = ["...kkkkkkkk...", "..khhhBBBBBk..", ".khBBBBBBBBBk.", "kBkBBBBBBBBkBk", "kBkBBkbbkBBkBk", ".kbBBBBBBBBbk.", "..kkkkkkkkkk.."];
const HEAD_SIDE = ["...kkkkkkkk...", "..khhhBBBBBk..", ".khBBBBBBBBBk.", "kBkBBBBBVVVVk.", "kBkBBBBBVVVVk.", ".kbBBBBBBBBbk.", "..kkkkkkkkkk.."];
const BODY_FRONT = [".kkBBBBBBBBkk.", "kBkBBLLLLBBkBk", "kBkBBBBBBBBkBk", "khkbBBBBBBbkhk", "kkk.kbbbbk.kkk", "....kkkkkk....", ".....kjjk....."];
const BODY_BACK = [".kkBBBBBBBBkk.", "kBkBBBBBBBBkBk", "kBkBbbbbbbBkBk", "khkbBBBBBBbkhk", "kkk.kbbbbk.kkk", "....kkkkkk....", ".....kjjk....."];
// Typing: the back view with both arms raised one pixel (subtle, so it doesn't read as flicker).
const BODY_TYPE = ["kBkBBBBBBBBkBk", "kBkBBBBBBBBkBk", "khkBbbbbbbBkhk", "kkkbBBBBBBbkkk", "....kbbbbk....", "....kkkkkk....", ".....kjjk....."];
const BODY_SIDE = ["...kBBBBBBk...", "...kBBBBBLk...", "...kBkBBBBk...", "...kBkbBBbk...", "...kkkbbbk....", "....kkkkkk....", ".....kjjk....."];
const GOLD = "#ffd23f"; // the palette's C.gold is the neon green accent

export type Facing = "front" | "back" | "type" | "side" | "sideL";

const canvasCache = new Map<string, Record<Facing, HTMLCanvasElement>>();

/** Robot size in pixels (every facing). */
export const ROBOT_W = 14;
export const ROBOT_H = 17;

/** Plain canvases for each facing (no Pixi) — also used by HUD portraits. */
export function robotCanvases(color: string, lead: boolean): Record<Facing, HTMLCanvasElement> {
  const key = `${color}|${lead}`;
  const hit = canvasCache.get(key);
  if (hit) return hit;
  const pal = { k: C.ink, B: color, b: shade(color, -0.3), h: shade(color, 0.6), V: "#16213f", G: GOLD, L: shade(color, 0.75), j: "#ff9f1c" };
  const head = lead ? HEAD_CROWN : HEAD_ANTENNA;
  const side = spriteCanvas([...head, ...HEAD_SIDE, ...BODY_SIDE], pal);
  const canvases: Record<Facing, HTMLCanvasElement> = {
    front: spriteCanvas([...head, ...HEAD_FRONT, ...BODY_FRONT], pal),
    back: spriteCanvas([...head, ...HEAD_BACK, ...BODY_BACK], pal),
    type: spriteCanvas([...head, ...HEAD_BACK, ...BODY_TYPE], pal),
    side,
    sideL: flipCanvas(side),
  };
  canvasCache.set(key, canvases);
  return canvases;
}


/** A HUD portrait: the front sprite with eyes and a lit antenna baked in (in the office they're drawn live). */
export function robotPortrait(color: string, lead: boolean): HTMLCanvasElement {
  const key = `${color}|${lead}|portrait`;
  const hit = portraitCache.get(key);
  if (hit) return hit;
  const src = robotCanvases(color, lead).front;
  const c = document.createElement("canvas");
  c.width = ROBOT_W;
  c.height = ROBOT_H;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.drawImage(src, 0, 0);
  g.fillStyle = "#bff6ff";
  g.fillRect(5, 6, 1, 2);
  g.fillRect(8, 6, 1, 2);
  if (!lead) {
    g.fillStyle = color;
    g.fillRect(6, 1, 2, 1);
  }
  portraitCache.set(key, c);
  return c;
}
const portraitCache = new Map<string, HTMLCanvasElement>();

export const RABBIT = [
  "..k...k..", ".kOk.kOk.", ".kPk.kPk.", ".kPk.kPk.", ".kOkkkOk.", "kOOOOOOOk",
  "kOkOOOkOk", "kOOOpOOOk", ".kOWWWOk.", "kOOWWWOOk", "kOOWWWOOk", ".kkkkkkk.",
];
export const RABBIT_BLINK = [
  "..k...k..", ".kOk.kOk.", ".kPk.kPk.", ".kPk.kPk.", ".kOkkkOk.", "kOOOOOOOk",
  "kOOOOOOOk", "kkkOpOkkk", ".kOWWWOk.", "kOOWWWOOk", "kOOWWWOOk", ".kkkkkkk.",
];
export const RABBIT_PAL = { k: C.ink, O: C.rabbit, P: C.pink, p: "#ff5c86", W: C.white };

/** A small scanner eye used for review tools other than CodeRabbit. */
export const SCANNER = ["..kkkkk..", ".kMMMMMk.", "kMWWWWWMk", "kMWkkkWMk", "kMWWWWWMk", ".kMMMMMk.", "..kkkkk..", "....k....", "...kkk..."];
export const SCANNER_PAL = { k: C.ink, M: C.metal, W: C.white };
