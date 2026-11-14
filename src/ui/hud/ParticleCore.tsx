import { useEffect, useRef } from "react";
import { useOffice } from "../../store/office";
import { hudFrame } from "./AgentOrbit";

interface Particle {
  theta: number;
  phi: number;
  radiusScale: number;
  size: number;
  speed: number;
  layer: 0 | 1 | 2; // 0 = inner core, 1 = main shell, 2 = outer halo
}

interface ParticleCoreProps {
  workingCount: number;
  attentionCount: number;
  /** A red-team project's core is red and steel; a build project's cyan and gold. */
  redTeam: boolean;
  /** Inside a page (phones, tablets): fill the parent instead of the window. */
  compact?: boolean;
}

const PARTICLE_COUNT = 1350;

function makeParticles(): Particle[] {
  const pts: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const layer: 0 | 1 | 2 = i < 280 ? 0 : i < 1050 ? 1 : 2;
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const radiusScale = layer === 0 ? 0.56 + Math.random() * 0.08 : layer === 1 ? 0.94 + Math.random() * 0.1 : 1.18 + Math.random() * 0.12;
    pts.push({
      theta,
      phi,
      radiusScale,
      size: layer === 0 ? 1.5 : layer === 1 ? 1.2 + Math.random() * 0.9 : 1.0,
      speed: (layer === 0 ? 0.45 : layer === 1 ? 0.22 : -0.14) * (0.8 + Math.random() * 0.4),
      layer,
    });
  }
  return pts;
}

/**
 * Interactive 60fps 3D-projected particle core.
 * Cyan/gold (build) or red/steel (red team); it spins faster with more agents working and pulses while something needs you.
 */
export function ParticleCore({ workingCount, attentionCount, redTeam, compact = false }: ParticleCoreProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strip = useOffice((s) => (s.snap?.config.template?.flow.stages.length ?? 0) > 1);
  const stateRef = useRef({ workingCount, attentionCount, redTeam, strip });
  stateRef.current = { workingCount, attentionCount, redTeam, strip };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const particles = makeParticles();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let pointerX = 0;
    let pointerY = 0;
    let smoothX = 0;
    let smoothY = 0;
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;

    const onMove = (e: PointerEvent) => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      pointerX = (e.clientX / w - 0.5) * 2;
      pointerY = (e.clientY / h - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduced) elapsed += dt;

      const cur = stateRef.current;
      smoothX += (pointerX - smoothX) * Math.min(1, dt * 4);
      smoothY += (pointerY - smoothY) * Math.min(1, dt * 4);

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      const f = hudFrame(w, h, compact, cur.strip);
      const cx = f.cx + smoothX * 6;
      const cy = f.cy + smoothY * 4;
      const baseR = f.r;
      const activityBoost = 1 + Math.min(cur.workingCount, 6) * 0.14;
      const pulse = 1 + Math.sin(elapsed * (cur.attentionCount > 0 ? 4.2 : 1.8)) * (cur.attentionCount > 0 ? 0.035 : 0.018);
      const R = baseR * pulse;

      // Ambient core glow
      const glow = ctx.createRadialGradient(cx, cy, R * 0.08, cx, cy, R * 1.45);
      const [pR, pG, pB] = cur.redTeam ? [255, 42, 75] : [0, 240, 255];
      const [sR, sG, sB] = cur.redTeam ? [148, 163, 184] : [255, 176, 32];

      glow.addColorStop(0, `rgba(${pR}, ${pG}, ${pB}, 0.18)`);
      glow.addColorStop(0.55, `rgba(${sR}, ${sG}, ${sB}, 0.06)`);
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.45, 0, Math.PI * 2);
      ctx.fill();

      // Subtle concentric orbital HUD rings
      ctx.save();
      ctx.translate(cx, cy);
      for (let ring = 0; ring < 3; ring++) {
        const rr = R * (1.28 + ring * 0.22);
        const tilt = 0.28 + ring * 0.16 + smoothY * 0.06;
        const rot = elapsed * (ring % 2 === 0 ? 0.12 : -0.09) + ring * 0.8;
        ctx.save();
        ctx.rotate(rot);
        ctx.scale(1, tilt);
        ctx.strokeStyle = `rgba(${pR}, ${pG}, ${pB}, ${0.14 - ring * 0.03})`;
        ctx.lineWidth = 1;
        ctx.setLineDash(ring === 2 ? [4, 8] : []);
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();

      // 3D particle projection with additive blending
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const tiltX = 0.25 + smoothY * 0.22;
      const rotY = elapsed * 0.22 * activityBoost + smoothX * 0.35;
      const cosX = Math.cos(tiltX);
      const sinX = Math.sin(tiltX);
      const focal = R * 3.2;

      for (let i = 0; i < particles.length; i++) {
        const pt = particles[i];
        const a = pt.theta + elapsed * pt.speed * activityBoost + rotY;
        const sinPhi = Math.sin(pt.phi);
        const r = R * pt.radiusScale;

        const x0 = r * sinPhi * Math.cos(a);
        const y0 = r * Math.cos(pt.phi);
        const z0 = r * sinPhi * Math.sin(a);

        // Tilt around X
        const y1 = y0 * cosX - z0 * sinX;
        const z1 = y0 * sinX + z0 * cosX;

        const scale = focal / (focal + z1);
        const sx = cx + x0 * scale;
        const sy = cy + y1 * scale;
        const depth = Math.max(0.15, Math.min(1, (z1 + R * 1.4) / (R * 2.8)));

        const useSecondary = pt.layer === 0 || (pt.layer === 1 && i % 5 === 0);
        const cr = useSecondary ? sR : pR;
        const cg = useSecondary ? sG : pG;
        const cb = useSecondary ? sB : pB;
        const alpha = (0.18 + depth * 0.68) * (pt.layer === 2 ? 0.55 : 0.95);

        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, pt.size * scale * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", resize);
    };
  }, [compact]);

  return <canvas ref={canvasRef} className={`pointer-events-none inset-0 h-full w-full ${compact ? "absolute" : "fixed"}`} aria-hidden="true" />;
}
