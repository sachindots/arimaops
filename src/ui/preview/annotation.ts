// Shared Pointer Events annotation drawing engine and live preview/feedback HTTP helpers.

import type {
  ConsoleErrorEntry,
  ElementSelection,
  FeedbackRoute,
  PreviewTarget,
  VisualFeedback,
} from "../../data/generated";

export type DrawTool = "pen" | "arrow" | "box" | "callout";

export interface Stroke {
  tool: DrawTool;
  color: string;
  points: { x: number; y: number }[];
  calloutNum?: number;
}

export const INK_COLORS = [
  { id: "cyan", label: "Cyan", hex: "#0891b2" },
  { id: "red", label: "Red", hex: "#ef4444" },
  { id: "amber", label: "Amber", hex: "#f59e0b" },
  { id: "green", label: "Green", hex: "#10b981" },
] as const;

export const DRAW_TOOLS: { id: DrawTool; label: string; icon: string }[] = [
  { id: "pen", label: "Freehand", icon: "gesture" },
  { id: "arrow", label: "Arrow", icon: "north_east" },
  { id: "box", label: "Box", icon: "crop_square" },
  { id: "callout", label: "Callout #", icon: "pin_drop" },
];

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (s.tool === "pen") {
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x, s.points[i].y);
    }
    if (s.points.length === 1) {
      ctx.arc(s.points[0].x, s.points[0].y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.stroke();
    }
  } else if (s.tool === "box" && s.points.length >= 2) {
    const p0 = s.points[0];
    const p1 = s.points[s.points.length - 1];
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  } else if (s.tool === "arrow" && s.points.length >= 2) {
    const p0 = s.points[0];
    const p1 = s.points[s.points.length - 1];
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();

    const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const headLen = 14;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p1.x - headLen * Math.cos(angle - Math.PI / 6), p1.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(p1.x - headLen * Math.cos(angle + Math.PI / 6), p1.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else if (s.tool === "callout") {
    const p0 = s.points[0];
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(s.calloutNum ?? 1), p0.x, p0.y);
  }
  ctx.restore();
}

export function renderStrokes(
  canvas: HTMLCanvasElement,
  strokes: Stroke[],
  activeStroke: Stroke | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) drawStroke(ctx, s);
  if (activeStroke) drawStroke(ctx, activeStroke);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/**
 * Composites an optional snapshot/evidence image and all annotation strokes into a valid
 * `data:image/png;base64,...` data URL ready for `POST /api/projects/:id/feedback`.
 */
export async function compositeAnnotatedPng(opts: {
  width: number;
  height: number;
  backgroundUrl?: string | null;
  fallbackTitle?: string;
  fallbackSubtitle?: string;
  strokes: Stroke[];
}): Promise<string> {
  const w = Math.max(320, Math.round(opts.width));
  const h = Math.max(200, Math.round(opts.height));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  if (!ctx) return "";

  let drewBackground = false;
  if (opts.backgroundUrl) {
    try {
      const img = await loadImage(opts.backgroundUrl);
      ctx.fillStyle = "#0c1322";
      ctx.fillRect(0, 0, w, h);
      // Fit image preserving aspect ratio (cover top for web snapshots, contain for evidence).
      const scale = Math.min(w / Math.max(1, img.naturalWidth), h / Math.max(1, img.naturalHeight));
      const dw = Math.round(img.naturalWidth * scale);
      const dh = Math.round(img.naturalHeight * scale);
      const dx = Math.round((w - dw) / 2);
      const dy = Math.round((h - dh) / 2);
      ctx.drawImage(img, dx, dy, dw, dh);
      drewBackground = true;
    } catch {
      drewBackground = false;
    }
  }

  if (!drewBackground) {
    ctx.fillStyle = "#0c1322";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#131d31";
    ctx.fillRect(0, 0, w, 46);
    ctx.fillStyle = "#06b6d4";
    ctx.beginPath();
    ctx.arc(22, 23, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f1f5f9";
    ctx.font = "600 14px Inter, sans-serif";
    ctx.fillText(opts.fallbackTitle || "ArimaOps Live Preview", 38, 28);
    if (opts.fallbackSubtitle) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "400 12px Inter, sans-serif";
      ctx.fillText(opts.fallbackSubtitle.slice(0, 120), 22, 74);
    }
  }

  for (const s of opts.strokes) drawStroke(ctx, s);

  try {
    return off.toDataURL("image/png");
  } catch {
    // Tainted canvas fallback: re-render strokes onto a clean background.
    ctx.fillStyle = "#0c1322";
    ctx.fillRect(0, 0, w, h);
    for (const s of opts.strokes) drawStroke(ctx, s);
    return off.toDataURL("image/png");
  }
}

// ---------------------------------------------------------------- Live Preview & Feedback HTTP API

function linkToken(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

export function withHqToken(url: string): string {
  const tok = linkToken();
  if (!tok) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(tok)}`;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const errMsg =
      typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

export async function fetchPreviewTargets(projectId: string): Promise<PreviewTarget[]> {
  const res = await fetch(withHqToken(`/api/projects/${encodeURIComponent(projectId)}/preview/targets`), {
    credentials: "same-origin",
  });
  const data = await readJson<{ targets?: PreviewTarget[] }>(res);
  return Array.isArray(data.targets) ? data.targets : [];
}

export interface PreviewTokenResult {
  token: string;
  previewUrl: string;
  exchangeUrl?: string;
  expiresAt?: string;
}

export async function requestPreviewToken(
  projectId: string,
  targetId: string,
  next?: string,
): Promise<PreviewTokenResult> {
  const res = await fetch(withHqToken(`/api/projects/${encodeURIComponent(projectId)}/preview/token`), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next ? { targetId, next } : { targetId }),
  });
  return readJson<PreviewTokenResult>(res);
}

/**
 * Resolves the isolated iframe URL (going through `/__arima_preview/exchange?token=...&next=...`
 * so the `:7421` proxy sets `arima_preview_sid`) and returns the strict `previewOrigin` for `postMessage`.
 */
export function resolvePreviewExchangeUrl(
  result: PreviewTokenResult,
  nextPath?: string,
): { iframeSrc: string; previewOrigin: string } {
  const raw = result.exchangeUrl || result.previewUrl;
  const parsed = new URL(raw, window.location.origin);
  const previewOrigin = parsed.origin;
  if (parsed.pathname.includes("/__arima_preview/exchange") && parsed.searchParams.get("token")) {
    if (nextPath && nextPath.startsWith("/")) {
      parsed.searchParams.set("next", nextPath);
    }
    return { iframeSrc: parsed.toString(), previewOrigin };
  }
  const next = nextPath && nextPath.startsWith("/") ? nextPath : `${parsed.pathname}${parsed.search}` || "/";
  if (result.token) {
    const exchange = new URL("/__arima_preview/exchange", previewOrigin);
    exchange.searchParams.set("token", result.token);
    exchange.searchParams.set("next", next);
    return { iframeSrc: exchange.toString(), previewOrigin };
  }
  return { iframeSrc: parsed.toString(), previewOrigin };
}

export interface PreviewSnapshotResult {
  imageDataUrl: string;
  fallback?: boolean;
}

export async function capturePreviewSnapshot(
  projectId: string,
  input: { targetId: string | null; pageUrl: string; viewportWidth: number; viewportHeight: number },
): Promise<PreviewSnapshotResult> {
  const res = await fetch(withHqToken(`/api/projects/${encodeURIComponent(projectId)}/preview/snapshot`), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<PreviewSnapshotResult>(res);
}

export interface PostFeedbackPayload {
  targetId: string | null;
  sourceKind: string;
  pageUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  note: string;
  selection: ElementSelection | null;
  consoleErrors: ConsoleErrorEntry[];
  route: FeedbackRoute;
  imageDataUrl: string;
}

export async function postVisualFeedback(projectId: string, payload: PostFeedbackPayload): Promise<VisualFeedback> {
  const res = await fetch(withHqToken(`/api/projects/${encodeURIComponent(projectId)}/feedback`), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJson<{ feedback?: VisualFeedback }>(res);
  if (!data.feedback) throw new Error("Server returned no feedback record.");
  return data.feedback;
}

export async function fetchVisualFeedback(projectId: string): Promise<VisualFeedback[]> {
  const res = await fetch(withHqToken(`/api/projects/${encodeURIComponent(projectId)}/feedback`), {
    credentials: "same-origin",
  });
  const data = await readJson<{ items?: VisualFeedback[]; feedback?: VisualFeedback[] }>(res);
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.feedback)) return data.feedback;
  return [];
}

export function feedbackImageUrl(projectId: string, feedbackId: string): string {
  return withHqToken(`/api/projects/${encodeURIComponent(projectId)}/feedback/${encodeURIComponent(feedbackId)}/image`);
}
