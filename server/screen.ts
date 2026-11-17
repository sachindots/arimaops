// What an agent's terminal shows, read from its last lines. Hooks are the main signal; this is the fallback
// (a missed hook) and the check before typing a message. CLIs change their footers between versions, so
// every pattern here has sample screens in scripts/screen-test.ts: edit both together.

/** The footer while a turn runs. */
const BUSY = /esc to interrupt|esc to cancel/i;
/**
 * A question or permission prompt. "Enter to confirm": Claude Code's folder-trust prompt (Local mode, first
 * start in a folder). The last part is a numbered menu with its cursor on option 1.
 */
const DIALOG = /Enter to select|Enter to confirm|↑\/↓ to navigate|↑\/↓ Navigate|Run this command\?|Do you want to (proceed|make this edit|create)|Would you like to|^\s*[❯›>]\s*1\.\s/im;
/** Folder-trust questions of every CLI (Claude Code, Codex, Antigravity, Gemini). */
const TRUST = /Do you trust (the contents of )?this (folder|directory|project)|Is this a project you created or one you trust|trust this folder/i;
/** The input prompt is up. */
const READY = /⏵⏵|\? for shortcuts|Ask Codex to do anything|Type your message|Ask Gemini|Ask Antigravity|ctrl\+p commands/i;
/** The CLI has no login, so every message fails until you sign in. */
const NO_LOGIN = /Not logged in · Run \/login|Login expired|Please run \/login|Invalid API key/i;

export interface Screen {
  busy: boolean;
  dialog: boolean;
  trust: boolean;
  /** The normal input prompt is showing. */
  ready: boolean;
  noLogin: boolean;
}

export function readScreen(text: string): Screen {
  return { busy: BUSY.test(text), dialog: DIALOG.test(text), trust: TRUST.test(text), ready: READY.test(text), noLogin: NO_LOGIN.test(text) };
}

/** Nothing on screen waits for an answer and no turn is running, so a typed message lands in the prompt. */
export const canType = (text: string) => {
  const s = readScreen(text);
  return !!text && !s.dialog && !s.trust && !s.busy;
};
