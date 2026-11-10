// Shared office types: world-pixel rects and what a pointer can hit.

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** agent: a robot (id = agent id, or "<project>/<agent>" in another wing); wing: a project's banner (id = project). */
export type HitKind = "agent" | "wing";

export interface Hit {
  kind: HitKind;
  id: string;
  rect: PxRect;
}
