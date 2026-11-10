// Isometric projection: classic 2:1 diamond, one tile = 32×16 art pixels.
// Tile (x, y) is the floor cell; z is height in art pixels. Screen x grows
// with +x (down-right) and shrinks with +y (down-left); the viewer looks from
// the +x+y corner, so the visible side faces of a box are its +x and +y faces.

export const HALF_W = 16;
export const HALF_H = 8;

export const toScreen = (x: number, y: number, z = 0) => ({ x: (x - y) * HALF_W, y: (x + y) * HALF_H - z });

/** Floor point (z = 0) under a screen position. */
export const toTile = (sx: number, sy: number) => {
  const a = sx / HALF_W;
  const b = sy / HALF_H;
  return { x: (a + b) / 2, y: (b - a) / 2 };
};

/** Painter's order: larger values are nearer the viewer. Tile items use their centre (x + 0.5, y + 0.5). */
export const depth = (x: number, y: number, z = 0) => x + y + z / 1000;
