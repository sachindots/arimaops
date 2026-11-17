// The UI uses Inter, and JetBrains Mono for terminals and data. One look for everyone; the older font
// choices (pixel, mono) are gone.

export type FontStyle = "clean";

export const FONT_EVENT = "arimaops:font";

export function terminalFont(_font: FontStyle = "clean") {
  return { family: '"JetBrains Mono", ui-monospace, Menlo, monospace', size: 13, lineHeight: 1.2, load: '13px "JetBrains Mono"' };
}

export function savedFont(): FontStyle {
  return "clean";
}

/** Nothing to apply: the stylesheet sets the fonts. Kept so callers needn't change. */
export function applyFont(_font: FontStyle) {}
