import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { officeActions } from "../../store/office";
import { readTerminal, subscribeTerminal } from "../../store/terminal";
import { FONT_EVENT, savedFont, terminalFont, type FontStyle } from "../../theme/fonts";

const theme = {
  background: "#04060a",
  foreground: "#e6edf7",
  cursor: "#00ff66",
  cursorAccent: "#04060a",
  selectionBackground: "rgba(255, 23, 68, 0.32)",
  black: "#040508",
  red: "#ff1744",
  green: "#00ff66",
  yellow: "#00ff66",
  blue: "#00e5ff",
  magenta: "#c04dff",
  cyan: "#3ee0d0",
  white: "#e6edf7",
};

/** Opens a link from a terminal in a new tab. Only web links: a terminal's output is untrusted. */
function openLink(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  window.open(url.href, "_blank", "noopener,noreferrer");
}

/** A real xterm.js terminal fed by the agent's (mock) output stream. */
export function TerminalView({ agentId, autoFocus = true }: { agentId: string; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const font = terminalFont(savedFont());
    const term = new Terminal({
      theme,
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      cursorBlink: true,
      scrollback: 3000,
      convertEol: false,
      allowProposedApi: false,
      // Links a program marks as links (OSC 8), e.g. with FORCE_HYPERLINK set: the full URL, however it wraps.
      linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Plain URLs in the output, including ones the terminal wrapped onto the next line.
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
    let unsub = () => {};
    let ro: ResizeObserver | null = null;

    // Font style changed in Settings: switch once the new font is loaded, then re-measure.
    const onFont = (e: Event) => {
      const f = terminalFont((e as CustomEvent<FontStyle>).detail);
      void document.fonts.load(f.load).finally(() => {
        if (disposed) return;
        term.options.fontFamily = f.family;
        term.options.fontSize = f.size;
        term.options.lineHeight = f.lineHeight;
        try {
          fit.fit();
        } catch {
          /* not open yet */
        }
      });
    };
    window.addEventListener(FONT_EVENT, onFont);

    // Measure with the font loaded, or columns come out wrong.
    void document.fonts.load(font.load).finally(() => {
      if (disposed) return;
      term.open(el);
      fit.fit();
      // The server sizes the agent's tmux window to this terminal and redraws it.
      officeActions.resizeTerminal(agentId, term.cols, term.rows);
      term.onResize(({ cols, rows }) => officeActions.resizeTerminal(agentId, cols, rows));
      term.write(readTerminal(agentId));
      unsub = subscribeTerminal(agentId, (data) => term.write(data));
      term.onData((data) => officeActions.sendTerminalInput(agentId, data));
      // Shift+Enter: xterm.js sends a plain Enter (\r), which submits. Send Alt+Enter (ESC \r)
      // instead, which Claude Code and Codex read as "new line".
      term.attachCustomKeyEventHandler((e) => {
        if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return true;
        if (e.type === "keydown") officeActions.sendTerminalInput(agentId, "\x1b\r");
        e.preventDefault();
        return false;
      });
      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* element hidden mid-animation */
        }
      });
      ro.observe(el);
      if (autoFocus) term.focus();
    });

    return () => {
      disposed = true;
      window.removeEventListener(FONT_EVENT, onFont);
      unsub();
      ro?.disconnect();
      term.dispose();
    };
  }, [agentId, autoFocus]);

  return <div ref={host} className="h-full min-h-0 w-full bg-navy-2" />;
}
