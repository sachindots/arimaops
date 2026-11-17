// One colour switch per project (docs/design/command-deck.md): the open project's type picks a theme, the theme sets
// <html data-theme>, and CSS variables in src/index.css carry the accent from there. Components use `accent` and
// `accent-2` and never ask which kind of project it is. The canvas orb can't read CSS, so it gets RGB numbers here.

import { useEffect } from "react";
import type { OfficeSnapshot } from "../../data/types";
import { projectMode } from "../hud/theme";

export type ThemeId = "build" | "redteam" | "blueteam" | "purpleteam";
export type Rgb = readonly [number, number, number];

export interface Theme {
  id: ThemeId;
  /** "Software", "Red team", …: the type chip beside the project name. */
  label: string;
  /** The footer ribbon's name for the flow. */
  pipeline: string;
  orb: { primary: Rgb; secondary: Rgb };
  /** Security work: the rail shows Findings instead of PRs. */
  security: boolean;
}

export const THEMES: Record<ThemeId, Theme> = {
  build: { id: "build", label: "Software", pipeline: "Software delivery", orb: { primary: [59, 130, 246], secondary: [226, 232, 240] }, security: false },
  redteam: { id: "redteam", label: "Red team", pipeline: "Red-team engagement", orb: { primary: [239, 68, 68], secondary: [226, 232, 240] }, security: true },
  blueteam: { id: "blueteam", label: "Blue team", pipeline: "Detection and response", orb: { primary: [14, 165, 233], secondary: [226, 232, 240] }, security: true },
  purpleteam: { id: "purpleteam", label: "Purple team", pipeline: "Attack and defence", orb: { primary: [168, 85, 247], secondary: [239, 68, 68] }, security: true },
};

/** The open project's theme (today's projectMode rules: the template first, then findings, then the team). */
export function projectTheme(snap: OfficeSnapshot | null): Theme {
  return THEMES[projectMode(snap)];
}

/** projectTheme, and keeps <html data-theme> on it so the CSS accent follows the project. */
export function useProjectTheme(snap: OfficeSnapshot | null): Theme {
  const theme = projectTheme(snap);
  useEffect(() => {
    document.documentElement.dataset.theme = theme.id;
  }, [theme.id]);
  return theme;
}
