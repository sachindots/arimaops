// Pointer input for the office: drag to pan, wheel to zoom, hover + click on things.

import type { Application } from "pixi.js";
import { useBuilding } from "../store/building";
import { reviewToolLabel, useOffice } from "../store/office";
import type { OfficeSnapshot } from "../data/types";
import { ui, useUi } from "../store/ui";
import { sessionLabel, stateStyle } from "../theme/tokens";
import type { Camera } from "./engine/camera";
import type { Hit, PxRect } from "./layout/layout";

export type Target = { hit: Hit; rect: PxRect };

/** What a scene must offer for pointer input (the top-down and the iso office both do). */
export interface InputHost {
  app: Application;
  camera: Camera;
  hover: { rect: PxRect; agentId: string | null } | null;
  hitTest(sx: number, sy: number): Target | null;
}

export const inside = (r: PxRect, x: number, y: number) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;

/** "<project>/<agent>" ids are robots of another project in the one-building office. */
function remote(id: string): { project: string; agentId: string; name: string; snap: OfficeSnapshot } | null {
  const i = id.indexOf("/");
  if (i <= 0) return null;
  const o = useBuilding.getState().others[id.slice(0, i)];
  return o?.snap ? { project: o.id, agentId: id.slice(i + 1), name: o.name, snap: o.snap } : null;
}

function describe(hit: Hit): { title: string; sub?: string } {
  const r = hit.kind === "agent" ? remote(hit.id) : null;
  const snap = r?.snap ?? useOffice.getState().snap;
  if (!snap) return { title: "" };
  if (hit.kind === "agent") {
    const id = r?.agentId ?? hit.id;
    const a = snap.config.team.find((x) => x.id === id);
    const st = snap.agents.find((x) => x.agentId === id);
    const task = st?.currentTaskId ? snap.tasks.find((t) => t.id === st.currentTaskId) : null;
    return {
      title: `${a?.name ?? id} · ${r ? r.name : (a?.role ?? "")}`,
      sub: [st ? (st.session.state === "running" ? stateStyle[st.state].label : sessionLabel[st.session.state]) : "", task ? `${task.id} ${task.title}` : st?.note ?? ""].filter(Boolean).join(" — "),
    };
  }
  if (hit.kind === "plan") {
    const active = snap.boards.filter((b) => b.status === "active");
    return { title: "Plan wall", sub: `${snap.boards.length} boards · ${active.length} active` };
  }
  if (hit.kind === "gate" || hit.kind === "prs") {
    const open = snap.pullRequests.filter((p) => !p.merged && !p.closed);
    const reviewing = open.filter((p) => p.review === "reviewing").length;
    const label = reviewToolLabel[snap.config.workflow.review.tool];
    return { title: hit.kind === "gate" ? `${label} review gate` : "Pull requests", sub: `${open.length} open · ${reviewing} reviewing` };
  }
  const env = snap.environments.find((e) => e.name === hit.id);
  return { title: `Environment: ${hit.id}`, sub: env ? `${env.status} · ${env.url}` : undefined };
}

function activate(hit: Hit) {
  const r = hit.kind === "agent" ? remote(hit.id) : null;
  if (r) {
    // Another project's agent: open that project with this agent's drawer.
    const url = new URL(location.href);
    url.searchParams.set("project", r.project);
    url.searchParams.set("open", `agent:${r.agentId}`);
    location.assign(url.toString());
  } else if (hit.kind === "agent") ui.openAgent(hit.id);
  else if (hit.kind === "plan") ui.openBoards(useUi.getState().planBoardId ?? undefined);
  else if (hit.kind === "gate" || hit.kind === "prs") ui.openPrs();
  else ui.openEnv(hit.id);
}

export function attachInput(s: InputHost): () => void {
  const el = s.app.canvas;
  let down: { x: number; y: number; lastX: number; lastY: number; dragging: boolean } | null = null;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const updateHover = (e: PointerEvent) => {
    const p = local(e);
    const target = s.hitTest(p.x, p.y);
    s.hover = target ? { rect: target.rect, agentId: target.hit.kind === "agent" ? target.hit.id : null } : null;
    el.style.cursor = down?.dragging ? "grabbing" : target ? "pointer" : "grab";
    ui.setHover(target ? { ...describe(target.hit), x: e.clientX, y: e.clientY } : null);
  };

  const onDown = (e: PointerEvent) => {
    const p = local(e);
    down = { x: p.x, y: p.y, lastX: p.x, lastY: p.y, dragging: false };
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (down) {
      const p = local(e);
      if (!down.dragging && Math.hypot(p.x - down.x, p.y - down.y) > 4) down.dragging = true;
      if (down.dragging) {
        s.camera.panBy(p.x - down.lastX, p.y - down.lastY);
        down.lastX = p.x;
        down.lastY = p.y;
        el.style.cursor = "grabbing";
        ui.setHover(null);
        return;
      }
    }
    updateHover(e);
  };
  const onUp = (e: PointerEvent) => {
    const wasDrag = down?.dragging;
    down = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (wasDrag) return updateHover(e);
    const p = local(e);
    const target = s.hitTest(p.x, p.y);
    if (target) activate(target.hit);
  };
  const onLeave = () => {
    s.hover = null;
    ui.setHover(null);
  };
  let wheelAcc = 0;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Integer zoom: step once per ~80px of scroll so trackpads don't race.
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 80) return;
    s.camera.zoomBy(wheelAcc < 0 ? 1 : -1, local(e));
    wheelAcc = 0;
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.style.cursor = "grab";
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("wheel", onWheel);
  };
}
