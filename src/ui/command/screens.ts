// Plain-text screen previews for the command center's tiles: GET /api/projects/<id>/screens,
// polled while the view is visible. Read-only; the server masks stored secrets.

import { useEffect, useState } from "react";

export type Screens = Record<string, Record<string, string>>; // project → agent → text

function token(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

/** Polls the previews of `projects` every `ms` while the page is visible. */
export function useScreens(projects: string[], live: boolean, ms = 2000): Screens {
  const [screens, setScreens] = useState<Screens>({});
  const key = projects.join(",");
  useEffect(() => {
    if (!live || !key) return;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      const tok = token();
      const next: Screens = {};
      await Promise.all(
        key.split(",").map(async (p) => {
          try {
            const r = await fetch(`/api/projects/${encodeURIComponent(p)}/screens?lines=40${tok ? `&token=${encodeURIComponent(tok)}` : ""}`, { credentials: "same-origin" });
            if (r.ok) next[p] = ((await r.json()) as { screens: Record<string, string> }).screens;
          } catch {
            /* offline: keep the last preview */
          }
        }),
      );
      if (!stop) setScreens((prev) => ({ ...prev, ...next }));
    };
    void tick();
    const t = window.setInterval(() => void tick(), ms);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [key, live, ms]);
  return screens;
}
