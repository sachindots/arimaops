// Run: npx tsx scripts/office-input-test.ts
import assert from "node:assert/strict";

Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2, innerWidth: 1000, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
Object.defineProperty(globalThis, "location", { value: { href: "http://localhost/" } });
const { Container } = await import("pixi.js");
const { Camera } = await import("../src/office/engine/camera");
const { attachInput } = await import("../src/office/sceneInput");
const { ui, useUi } = await import("../src/store/ui");

class Canvas extends EventTarget {
  style = { cursor: "", touchAction: "" };
  captured = new Set<number>();
  getBoundingClientRect() { return { left: 10, top: 20 }; }
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
}
const canvas = new Canvas();
const world = new Container();
const camera = new Camera(world, () => ({ w: 500, h: 400 }), () => ({ left: 0, top: 0, right: 0, bottom: 0 }), () => true);
camera.setWorldSize(2000, 2000);
camera.flyTo(500, 500, 1, false);
const hit = { hit: { kind: "agent", id: "fixture" }, rect: { x: 0, y: 0, w: 100, h: 100 } };
const stop = attachInput({ app: { canvas }, camera, hover: null, hitTest: () => hit } as never);
function pointer(type: string, id: number, x: number, y: number) {
  canvas.dispatchEvent(Object.assign(new Event(type), { pointerId: id, clientX: x + 10, clientY: y + 20, button: 0, pointerType: "touch" }));
}

pointer("pointerdown", 1, 100, 100);
pointer("pointerdown", 2, 200, 100);
pointer("pointermove", 2, 300, 100);
assert.equal(camera.zoom, 2, "spreading two fingers zooms in");
pointer("pointermove", 2, 200, 100);
assert.equal(camera.zoom, 1, "bringing fingers together zooms out");
pointer("pointercancel", 2, 200, 100);
pointer("pointerup", 1, 100, 100);
assert.equal(useUi.getState().drawer, null, "a pinch never selects the agent underneath it");
pointer("pointerdown", 3, 100, 100);
const x = camera.x;
pointer("pointermove", 3, 140, 100);
assert.ok(camera.x < x, "one finger still pans");
pointer("lostpointercapture", 3, 140, 100);
pointer("pointerup", 3, 140, 100);
assert.equal(useUi.getState().drawer, null, "cancellation never activates an agent");
pointer("pointerdown", 4, 100, 100);
pointer("pointerup", 4, 100, 100);
assert.deepEqual(useUi.getState().drawer, { kind: "agent", id: "fixture", tab: undefined });
ui.closeDrawer();

camera.flyTo(500, 500, 1, false);
const anchor = { x: 120, y: 90 };
const before = camera.screenToWorld(anchor.x, anchor.y);
camera.zoomBy(2, anchor);
const after = camera.screenToWorld(anchor.x, anchor.y);
assert.equal(after.x, before.x, "wheel zoom keeps its world anchor");
assert.equal(after.y, before.y);
camera.zoomTo(100);
assert.equal(camera.zoom, 6);
camera.zoomTo(0);
assert.equal(camera.zoom, 0.5);
camera.zoomTo(2);
canvas.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { clientX: 100, clientY: 100, deltaY: -80 }));
assert.equal(camera.zoom, 2.5, "mouse wheel zoom remains available");
stop();
assert.equal(canvas.style.touchAction, "");
const stopped = camera.zoom;
pointer("pointerdown", 1, 100, 100); pointer("pointerdown", 2, 200, 100); pointer("pointermove", 2, 400, 100);
assert.equal(camera.zoom, stopped, "unmount removes input listeners");
console.log("Office input checks passed: pinch, pan, tap, cancellation, wheel, zoom limits, anchor, and cleanup.");
