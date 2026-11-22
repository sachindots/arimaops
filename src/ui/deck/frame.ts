/** The deck's fixed frame (px): 56px header, 68px labeled icon rail (164px expanded), 40px desktop footer, 60px compact bottom bar. */
export const DECK = { header: 56, rail: 68, railExpanded: 164, footer: 40, bottomNav: 60 } as const;

/** Width of each Home side column (Waiting on you, Today). */
export const HOME_SIDE = 340;

/**
 * Home's side columns for a window `w` wide and a team of `n`: Waiting on you (left) from 1240 px; Today (right) only
 * while the orbit keeps room for its cards (about 680 px for up to 4 agents, 960 px for more).
 */
export function homeSides(w: number, n: number) {
  const left = w >= 1240 ? HOME_SIDE : 0;
  const right = left && w - DECK.rail - 2 * HOME_SIDE >= (n > 4 ? 960 : 660) ? HOME_SIDE : 0;
  return { left, right };
}
