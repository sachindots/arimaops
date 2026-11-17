// Live snapshots of the OTHER running projects, for the one-building office.
// Read-only: one extra socket per project (same /ws?project= protocol), never
// sends a command. Running = loaded in this HQ and not paused (GET /api/projects).

import { create } from "zustand";
import { createWsSource } from "../data/ws/wsSource";
import type { OfficeSnapshot, ProjectOverview } from "../data/types";
import { reduce, useOffice } from "./office";

export interface OtherProject {
  id: string;
  name: string;
  snap: OfficeSnapshot | null;
}

interface BuildingState {
  others: Record<string, OtherProject>;
}

export const useBuilding = create<BuildingState>(() => ({ others: {} }));

const POLL_MS = 30_000;

function token(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

/** Running projects other than `current`. */
export const othersToShow = (list: ProjectOverview[], current: string) => list.filter((p) => p.online && !p.paused && p.id !== current);

/** Starts following the other running projects; returns a stop function. Does nothing on the demo mock. */
export function followBuilding(): () => void {
  if (!useOffice.getState().live && !localStorageLive()) return () => {};
  const sockets = new Map<string, () => void>();
  let stopped = false;

  const set = (id: string, patch: Partial<OtherProject> | null) =>
    useBuilding.setState((s) => {
      const others = { ...s.others };
      if (patch === null) delete others[id];
      else others[id] = { ...(others[id] ?? { id, name: id, snap: null }), ...patch };
      return { others };
    });

  const poll = async () => {
    const current = useOffice.getState().snap?.config.project.id;
    if (!current) return;
    let list: ProjectOverview[];
    try {
      const tok = token();
      const res = await fetch(`/api/projects${tok ? `?token=${encodeURIComponent(tok)}` : ""}`, { credentials: "same-origin" });
      if (!res.ok) return;
      list = ((await res.json()) as { projects: ProjectOverview[] }).projects;
    } catch {
      return;
    }
    if (stopped) return;
    const want = othersToShow(list, current);
    for (const [id, close] of sockets) {
      if (want.some((p) => p.id === id)) continue;
      close();
      sockets.delete(id);
      set(id, null);
    }
    for (const p of want) {
      set(p.id, { name: p.name });
      if (sockets.has(p.id)) continue;
      const src = createWsSource(token(), p.id, { watch: true });
      sockets.set(
        p.id,
        src.connect((e) => {
          if (e.type === "terminal.output" || e.type === "workspace.info" || e.type === "remote.stepup" || e.type === "template.file" || e.type === "template.imported") return;
          useBuilding.setState((s) => {
            const o = s.others[p.id];
            if (!o) return {};
            const snap = e.type === "snapshot" ? e.snapshot : o.snap ? reduce(o.snap, e) : null;
            return snap === o.snap ? {} : { others: { ...s.others, [p.id]: { ...o, snap } } };
          });
        }),
      );
    }
  };

  void poll();
  const timer = window.setInterval(() => void poll(), POLL_MS);
  // The current project is known only after its first snapshot.
  const unsub = useOffice.subscribe((s, prev) => {
    if (s.snap?.config.project.id !== prev.snap?.config.project.id) void poll();
  });
  return () => {
    stopped = true;
    window.clearInterval(timer);
    unsub();
    for (const close of sockets.values()) close();
    sockets.clear();
    useBuilding.setState({ others: {} });
  };
}

function localStorageLive(): boolean {
  try {
    return localStorage.getItem("hq-live") === "1";
  } catch {
    return false;
  }
}
