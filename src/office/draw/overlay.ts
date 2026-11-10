// Selection corners around whatever the pointer is over.

import type { Pen } from "../engine/pen";
import type { PxRect } from "../types";

export function drawSelection(p: Pen, r: PxRect, t: number) {
  if (Math.floor(t * 3) % 3 === 0) return;
  const { x, y, w, h } = r;
  const L = 4;
  const c = "#E8B339"; // lion gold
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
    p.rect(sx > 0 ? cx - 1 : cx - L + 1, sy > 0 ? cy - 1 : cy, L, 1, c);
    p.rect(sx > 0 ? cx - 1 : cx, sy > 0 ? cy - 1 : cy - L + 1, 1, L, c);
  }
}
