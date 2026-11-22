// One colour switch per project (docs/design/command-deck.md): the open project's type picks a theme, the theme sets
// <html data-theme>, and CSS variables in src/index.css carry the accent from there. Components use `accent` and
// `accent-2` and never ask which kind of project it is. The canvas orb can't read CSS, so it gets RGB numbers here.

import { useEffect } from "react";
import type { OfficeSnapshot } from "../../data/types";
import { useUi } from "../../store/ui";
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
  build: { id: "build", label: "Software", pipeline: "Software Delivery Pipeline", orb: { primary: [0, 240, 255], secondary: [245, 158, 11] }, security: false },
  redteam: { id: "redteam", label: "Red team", pipeline: "Red-Team Pipeline Stages", orb: { primary: [239, 68, 68], secondary: [245, 158, 11] }, security: true },
  blueteam: { id: "blueteam", label: "Blue team", pipeline: "Detection & Response Pipeline", orb: { primary: [14, 165, 233], secondary: [56, 189, 248] }, security: true },
  purpleteam: { id: "purpleteam", label: "Purple team", pipeline: "Attack & Defence Pipeline", orb: { primary: [168, 85, 247], secondary: [239, 68, 68] }, security: true },
};

/** The open project's theme (today's projectMode rules: the template first, then findings, then the team). */
export function projectTheme(snap: OfficeSnapshot | null): Theme {
  return THEMES[projectMode(snap)];
}

/** projectTheme, and keeps <html data-theme> and <html data-scheme> synced with the project and user choice. */
export function useProjectTheme(snap: OfficeSnapshot | null): Theme {
  const theme = projectTheme(snap);
  const scheme = useUi((s) => s.scheme);
  const schemePinned = useUi((s) => s.schemePinned);
  useEffect(() => {
    document.documentElement.dataset.theme = theme.id;
    if (!schemePinned) {
      const auto = "dark";
      document.documentElement.dataset.scheme = auto;
      useUi.setState({ scheme: auto });
    } else {
      document.documentElement.dataset.scheme = scheme;
    }
  }, [theme.id, theme.security, scheme, schemePinned]);
  return theme;
}
