// Pointer input for the office: drag to pan, pinch/wheel to zoom, hover + click on things.

import { officeLabel } from "../data/names";
import type { Application } from "pixi.js";
import { useBuilding } from "../store/building";
import { useOffice } from "../store/office";
import type { OfficeSnapshot } from "../data/types";
import { ui } from "../store/ui";
import { sessionLabel, stateStyle } from "../theme/tokens";
import type { Camera } from "./engine/camera";
import type { Hit, PxRect } from "./types";

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
  if (hit.kind === "wing") {
    const mine = useOffice.getState().snap;
    const snap = mine?.config.project.id === hit.id ? mine : useBuilding.getState().others[hit.id]?.snap;
    if (!snap) return { title: hit.id };
    const up = snap.agents.filter((a) => a.session.state === "running").length;
    const p = snap.config.project;
    return { title: officeLabel(p), sub: `${snap.config.team.length} agents · ${up} running · tap to fly there` };
  }
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
  return { title: hit.id };
}

function activate(hit: Hit) {
  const r = hit.kind === "agent" ? remote(hit.id) : null;
  if (hit.kind === "wing") ui.focus({ kind: "wing", project: hit.id });
  else if (r) {
    // Another project's agent: open that project with this agent's drawer.
    const url = new URL(location.href);
    url.searchParams.set("project", r.project);
    url.searchParams.set("open", `agent:${r.agentId}`);
    location.assign(url.toString());
  } else ui.openAgent(hit.id);
}

export function attachInput(s: InputHost): () => void {
  const el = s.app.canvas;
  let down: { x: number; y: number; lastX: number; lastY: number; dragging: boolean } | null = null;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; zoom: number; x: number; y: number } | null = null;
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const startPinch = () => {
    pinch = { ...pair(), zoom: s.camera.zoom };
    down = null;
    s.hover = null;
    ui.setHover(null);
  };

  const updateHover = (e: PointerEvent) => {
    const p = local(e);
    const target = s.hitTest(p.x, p.y);
    s.hover = target ? { rect: target.rect, agentId: target.hit.kind === "agent" ? target.hit.id : null } : null;
    el.style.cursor = down?.dragging ? "grabbing" : target ? "pointer" : "grab";
    ui.setHover(target ? { ...describe(target.hit), x: e.clientX, y: e.clientY } : null);
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    el.setPointerCapture(e.pointerId);
    if (pointers.size > 1) startPinch();
    else down = { x: p.x, y: p.y, lastX: p.x, lastY: p.y, dragging: false };
  };
  const onMove = (e: PointerEvent) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size > 1) {
      const next = pair();
      s.camera.panBy(next.x - pinch.x, next.y - pinch.y);
      s.camera.zoomTo(pinch.zoom * next.distance / pinch.distance, next);
      pinch.x = next.x;
      pinch.y = next.y;
      return;
    }
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
    if (!pointers.delete(e.pointerId)) return;
    const wasDrag = down?.dragging;
    down = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (pinch) {
      if (pointers.size > 1) startPinch();
      else {
        pinch = null;
        const remaining = pointers.values().next().value;
        if (remaining) down = { ...remaining, lastX: remaining.x, lastY: remaining.y, dragging: true };
      }
      return;
    }
    if (e.type !== "pointerup") return onLeave();
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
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("lostpointercapture", onUp);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.style.cursor = "grab";
  const previousTouchAction = el.style.touchAction;
  el.style.touchAction = "none";
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("lostpointercapture", onUp);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("wheel", onWheel);
    el.style.touchAction = previousTouchAction;
  };
}
