/** The deck's fixed frame (px): 56px header (h-14), 56px micro icon rail (w-14), 40px bottom stage ribbon. */
export const DECK = { header: 56, rail: 56, footer: 40 } as const;

/** Width of each Home side column (Needs you, Today). */
export const HOME_SIDE = 312;

/**
 * Home's side columns for a window `w` wide and a team of `n`: Needs you (left) from 1320 px; Today (right) only
 * while the orbit keeps room for its cards (about 700 px for up to 4 agents, 1000 px for more).
 */
export function homeSides(w: number, n: number) {
  const left = w >= 1320 ? HOME_SIDE : 0;
  const right = left && w - DECK.rail - 2 * HOME_SIDE >= (n > 4 ? 1000 : 700) ? HOME_SIDE : 0;
  return { left, right };
}
