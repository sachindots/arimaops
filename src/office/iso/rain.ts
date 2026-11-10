// Digital rain behind the building: columns of green glyphs falling on black,
// drawn on its own 2D canvas under the (transparent) Pixi canvas. Cheap: one
// glyph per column per step, at ~20 fps, paused while the tab is hidden.
// Reduced motion: one still frame.

const GLYPHS = "அரிமாஓப்ஸ்0123456789ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜ:+=*<>";
const SIZE = 14; // px per glyph cell
const STEP_MS = 50;

/** Starts the rain inside `host` (behind its other children). Returns a stop function. */
export function startRain(host: HTMLElement, still: () => boolean): () => void {
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: "0", pointerEvents: "none" });
  canvas.setAttribute("aria-hidden", "true");
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.prepend(canvas);
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  const chars = [...GLYPHS];
  let drops: number[] = [];
  let speed: number[] = [];

  const resize = () => {
    canvas.width = Math.max(1, host.clientWidth);
    canvas.height = Math.max(1, host.clientHeight);
    const cols = Math.ceil(canvas.width / SIZE);
    drops = Array.from({ length: cols }, () => Math.floor((Math.random() * canvas.height) / SIZE));
    speed = Array.from({ length: cols }, () => (Math.random() < 0.7 ? 1 : 0.5));
    g.fillStyle = "#020603";
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (still()) for (let k = 0; k < 40; k++) step(); // a settled still frame
  };

  const step = () => {
    g.fillStyle = "rgba(2, 6, 3, 0.09)"; // fade the trails
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = `${SIZE - 2}px ui-monospace, monospace`;
    g.textBaseline = "top";
    for (let i = 0; i < drops.length; i++) {
      const y = Math.floor(drops[i]) * SIZE;
      const ch = chars[(Math.random() * chars.length) | 0];
      // Dim green trail, a bright head now and then.
      g.fillStyle = Math.random() < 0.06 ? "#c8ffd8" : i % 5 === 0 ? "#1f9d4a" : "#0f6b31";
      g.fillText(ch, i * SIZE, y);
      if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i] += speed[i];
    }
  };

  let last = 0;
  let raf = 0;
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    if (document.hidden || still() || t - last < STEP_MS) return;
    last = t;
    step();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    canvas.remove();
  };
}
