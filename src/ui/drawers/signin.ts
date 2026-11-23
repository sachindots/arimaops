// Is the agent's terminal waiting for you to sign in? Claude Code, Codex and Antigravity each print a link and then
// wait: for a pasted code, for a one-time code typed on a web page, or just for the browser to finish.

import { lastLink, plainText } from "./links";

export type SignIn = { link: string; step: "paste" | "device" | "browser"; code?: string };

const PASTE = /paste\s+(?:the\s+)?(?:code|url)|enter\s+(?:the\s+)?(?:authorization\s+)?code/i;
const DEVICE = /one-time code|device code|enter (?:this|the) code/i;
const DONE = /logged in|login successful|signed in|successfully (?:logged|authenticated|signed)|authentication successful/i;
const CUE = /sign in|log in|login|authenticate|authoriz/i;

export function signInPrompt(output: string): SignIn | null {
  const link = lastLink(output);
  if (!link) return null;
  const text = plainText(output.slice(-30_000));
  const at = text.lastIndexOf(link.slice(0, 30));
  const around = text.slice(Math.max(0, at - 600));
  if (DONE.test(text.slice(at))) return null;
  const device = DEVICE.test(around) ? /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/.exec(text.slice(at))?.[0] : undefined;
  if (device) return { link, step: "device", code: device };
  if (PASTE.test(text.slice(at))) return { link, step: "paste" };
  return CUE.test(around) ? { link, step: "browser" } : null;
}
