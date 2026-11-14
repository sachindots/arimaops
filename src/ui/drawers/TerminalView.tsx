import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { officeActions } from "../../store/office";
import { readTerminal, subscribeTerminal } from "../../store/terminal";
import { FONT_EVENT, savedFont, terminalFont, type FontStyle } from "../../theme/fonts";
import { lastLink } from "./links";

const theme = {
  background: "#0b0c0f",
  foreground: "#e6e8eb",
  cursor: "#3fb950",
  cursorAccent: "#0b0c0f",
  selectionBackground: "rgba(255, 23, 68, 0.32)",
  black: "#0b0c0f",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#3fb950",
  blue: "#818cf8",
  magenta: "#a371f7",
  cyan: "#4fb3c4",
  white: "#e6e8eb",
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
/** Keys a phone/tablet keyboard lacks. Ctrl is sticky: it applies to the next letter typed. */
const KEYS: [string, string][] = [
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["Ctrl", ""],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
  ["^C", "\x03"],
  ["⏎", "\r"],
];
const touch = () => window.matchMedia("(pointer: coarse)").matches;

export function TerminalView({ agentId, autoFocus = true }: { agentId: string; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const ctrl = useRef(false);
  // tmux asks the terminal what it supports when it attaches; xterm.js answers through onData. Those
  // replies aren't typing, and from a remote device each one would ask for the 6-digit code. Send
  // input only once you've touched or typed into this terminal.
  const touched = useRef(false);
  const touch_ = () => void (touched.current = true);
  const [ctrlOn, setCtrlOn] = useState(false);
  const termRef = useRef<Terminal | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
      setLink(lastLink(readTerminal(agentId)));
      let linkTimer = 0;
      unsub = subscribeTerminal(agentId, (data) => {
        term.write(data);
        window.clearTimeout(linkTimer);
        linkTimer = window.setTimeout(() => !disposed && setLink(lastLink(readTerminal(agentId))), 200);
      });
      term.onData((data) => {
        if (!touched.current) return;
        // Sticky Ctrl from the touch key row: Ctrl+letter is the letter's control code.
        if (ctrl.current && data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
          ctrl.current = false;
          setCtrlOn(false);
        }
        officeActions.sendTerminalInput(agentId, data);
      });
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
      termRef.current = term;
      // On a touch screen, focusing pops the keyboard over the output: wait for a tap instead.
      if (autoFocus && !touch()) term.focus();
    });

    return () => {
      disposed = true;
      window.removeEventListener(FONT_EVENT, onFont);
      unsub();
      ro?.disconnect();
      termRef.current = null;
      term.dispose();
    };
  }, [agentId, autoFocus]);

  const linkBar = link && (
    <div className="flex shrink-0 items-center gap-2 border-b-2 border-white/[0.08] bg-navy px-2 py-1">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted" title={link}>
        {link}
      </span>
      <button className="btn shrink-0 border-green px-3 py-1 text-[13px] text-green" onClick={() => openLink(link)}>
        Open link ↗
      </button>
      <button
        className="btn shrink-0 px-3 py-1 text-[13px]"
        onClick={() =>
          void navigator.clipboard?.writeText(link).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
  if (!touch())
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-navy-2">
        {linkBar}
        <div ref={host} className="min-h-0 w-full flex-1" onPointerDown={touch_} onKeyDownCapture={touch_} />
      </div>
    );
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-navy-2">
      {linkBar}
      <div ref={host} className="min-h-0 w-full flex-1" onPointerDown={touch_} onKeyDownCapture={touch_} />
      <div className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-t-2 border-white/[0.08] p-1" aria-label="Terminal keys">
        {KEYS.map(([label, seq]) => (
          <button
            key={label}
            className="btn min-w-[44px] shrink-0 px-2 py-1.5 font-mono text-[14px]"
            aria-pressed={label === "Ctrl" ? ctrlOn : undefined}
            // Keep the terminal (and the on-screen keyboard) focused.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              touch_();
              if (label === "Ctrl") {
                ctrl.current = !ctrl.current;
                setCtrlOn(ctrl.current);
              } else officeActions.sendTerminalInput(agentId, seq);
              termRef.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
