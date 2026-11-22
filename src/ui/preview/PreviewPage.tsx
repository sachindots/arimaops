import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ConsoleErrorEntry, ElementSelection, FeedbackRoute } from "../../data/generated";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";
import { PageTitle } from "../drawers/Drawer";
import { Select } from "../primitives/Select";
import {
  capturePreviewSnapshot,
  compositeAnnotatedPng,
  DRAW_TOOLS,
  feedbackImageUrl,
  fetchPreviewTargets,
  fetchVisualFeedback,
  INK_COLORS,
  postVisualFeedback,
  renderStrokes,
  requestPreviewToken,
  resolvePreviewExchangeUrl,
  type DrawTool,
  type Stroke,
} from "./annotation";

type ViewportPreset = "desktop" | "tablet" | "phone";
type PreviewInteractMode = "browse" | "pick" | "draw";

const VIEWPORTS: Record<ViewportPreset, { label: string; icon: string; width: number; height: number }> = {
  desktop: { label: "Desktop", icon: "desktop_windows", width: 1280, height: 800 },
  tablet: { label: "Tablet", icon: "tablet_mac", width: 820, height: 640 },
  phone: { label: "Phone", icon: "smartphone", width: 390, height: 680 },
};

const DEMO_ELEMENTS: ElementSelection[] = [
  {
    cssSelector: "div.upload-dropzone[data-component='KnowledgeDropzone']",
    tagName: "DIV",
    ariaRole: "region",
    componentHint: "src/components/KnowledgeDropzone.tsx",
    textSnippet: "Drop PDF or Markdown files here (max 25 MB streamed)",
    outerHtmlSnippet: '<div class="upload-dropzone" data-component="KnowledgeDropzone">...</div>',
    bbox: { x: 48, y: 120, width: 520, height: 180 },
  },
  {
    cssSelector: "button.btn-upload-primary",
    tagName: "BUTTON",
    ariaRole: "button",
    componentHint: "src/components/KnowledgeDropzone.tsx:84",
    textSnippet: "Upload & Chunk Document",
    outerHtmlSnippet: '<button class="btn-upload-primary">Upload & Chunk Document</button>',
    bbox: { x: 64, y: 236, width: 210, height: 40 },
  },
  {
    cssSelector: "aside.rate-limit-banner[data-tier='edge-sliding-window']",
    tagName: "ASIDE",
    ariaRole: "status",
    componentHint: "src/ui/RateLimitBanner.tsx",
    textSnippet: "Edge Sliding-Window Active · 288 / 300 requests remaining",
    outerHtmlSnippet: '<aside class="rate-limit-banner" data-tier="edge-sliding-window">...</aside>',
    bbox: { x: 48, y: 330, width: 520, height: 72 },
  },
];

function isValidSelection(v: unknown): v is ElementSelection {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.cssSelector === "string" && typeof o.tagName === "string";
}

function isValidConsoleEntry(v: unknown): v is ConsoleErrorEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.level === "string" && typeof o.message === "string" && typeof o.at === "string";
}

export function PreviewPage() {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const projectId = snap?.config.project.id ?? "";
  const targets = snap?.previewTargets ?? [];

  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? "");
  const activeTarget = targets.find((t) => t.id === targetId) ?? targets[0] ?? null;

  const [urlInput, setUrlInput] = useState<string>(activeTarget?.previewUrl ?? "http://localhost:3000/knowledge/upload");
  const [viewport, setViewport] = useState<ViewportPreset>("desktop");
  const [mode, setMode] = useState<PreviewInteractMode>("browse");
  const [tool, setTool] = useState<DrawTool>("pen");
  const [color, setColor] = useState<string>(INK_COLORS[0].hex);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [pickedElement, setPickedElement] = useState<ElementSelection | null>(null);
  const [hoveredElement, setHoveredElement] = useState<ElementSelection | null>(null);
  const [consoleErrors, setConsoleErrors] = useState<ConsoleErrorEntry[]>([]);
  const [submitOpen, setSubmitOpen] = useState(false);

  // Live preview origin-isolated session state
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [expectedOrigin, setExpectedOrigin] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [frozenSnapshotUrl, setFrozenSnapshotUrl] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotFallbackUsed, setSnapshotFallbackUsed] = useState(false);
  const [refreshingTargets, setRefreshingTargets] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<Stroke | null>(null);
  const modeRef = useRef<PreviewInteractMode>(mode);
  modeRef.current = mode;

  // Keep targetId aligned when targets arrive from live HQ.
  useEffect(() => {
    if (targets.length > 0 && !targets.some((t) => t.id === targetId)) {
      setTargetId(targets[0].id);
    }
  }, [targets, targetId]);

  useEffect(() => {
    if (activeTarget?.previewUrl) setUrlInput(activeTarget.previewUrl);
  }, [activeTarget?.id, activeTarget?.previewUrl]);

  const postToBridge = useCallback(
    (payload: Record<string, unknown>) => {
      if (!expectedOrigin || !iframeRef.current?.contentWindow) return;
      // Strict origin target (never wildcard "*").
      iframeRef.current.contentWindow.postMessage(payload, expectedOrigin);
    },
    [expectedOrigin],
  );

  // Fetch live preview targets & recent visual feedback from HQ.
  const refreshLiveState = useCallback(async () => {
    if (!live || !projectId) return;
    setRefreshingTargets(true);
    try {
      const [fetchedTargets, fetchedFeedback] = await Promise.all([
        fetchPreviewTargets(projectId).catch(() => null),
        fetchVisualFeedback(projectId).catch(() => null),
      ]);
      if (fetchedTargets) officeActions.setPreviewTargetsList(fetchedTargets);
      if (fetchedFeedback) officeActions.setVisualFeedbackList(fetchedFeedback);
    } finally {
      setRefreshingTargets(false);
    }
  }, [live, projectId]);

  useEffect(() => {
    if (!live || !projectId) return;
    void refreshLiveState();
  }, [live, projectId, refreshLiveState]);

  // Exchange preview token whenever live target changes.
  const exchangePreviewSession = useCallback(
    async (tid: string, nextPath?: string) => {
      if (!live || !projectId || !tid) return;
      setTokenLoading(true);
      setTokenError(null);
      setBridgeReady(false);
      setFrozenSnapshotUrl(null);
      try {
        const res = await requestPreviewToken(projectId, tid, nextPath);
        const { iframeSrc: src, previewOrigin } = resolvePreviewExchangeUrl(res, nextPath);
        setExpectedOrigin(previewOrigin);
        setIframeSrc(src);
      } catch (err) {
        setTokenError(err instanceof Error ? err.message : String(err));
        setIframeSrc(null);
        setExpectedOrigin(null);
      } finally {
        setTokenLoading(false);
      }
    },
    [live, projectId],
  );

  useEffect(() => {
    if (!live || !projectId || !activeTarget?.id) {
      setIframeSrc(null);
      setExpectedOrigin(null);
      setBridgeReady(false);
      return;
    }
    void exchangePreviewSession(activeTarget.id);
  }, [live, projectId, activeTarget?.id, exchangePreviewSession]);

  // Strict origin-validated listener for ArimaBridge postMessage events.
  useEffect(() => {
    if (!live || !expectedOrigin) return;
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== expectedOrigin) return;
      if (iframeRef.current?.contentWindow && ev.source !== iframeRef.current.contentWindow) return;
      const data = ev.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;

      switch (data.type) {
        case "arima:ready": {
          setBridgeReady(true);
          if (typeof data.pageUrl === "string" && data.pageUrl) {
            setUrlInput(data.pageUrl);
          }
          iframeRef.current?.contentWindow?.postMessage({ type: "arima:mode", mode: modeRef.current }, expectedOrigin);
          iframeRef.current?.contentWindow?.postMessage({ type: "arima:get-errors" }, expectedOrigin);
          break;
        }
        case "arima:hover": {
          if (isValidSelection(data.selection)) setHoveredElement(data.selection);
          break;
        }
        case "arima:pick": {
          if (isValidSelection(data.selection)) {
            setPickedElement(data.selection);
            setHoveredElement(null);
          }
          break;
        }
        case "arima:console-error": {
          if (isValidConsoleEntry(data.entry)) {
            setConsoleErrors((prev) => [...prev, data.entry as ConsoleErrorEntry].slice(-50));
          }
          break;
        }
        case "arima:console-errors": {
          if (Array.isArray(data.entries)) {
            setConsoleErrors(data.entries.filter(isValidConsoleEntry).slice(-50));
          }
          break;
        }
        case "arima:snapshot-fallback": {
          if (typeof data.imageDataUrl === "string" && data.imageDataUrl.startsWith("data:image/")) {
            setFrozenSnapshotUrl(data.imageDataUrl);
            setSnapshotFallbackUsed(true);
            setSnapshotLoading(false);
          }
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [live, expectedOrigin]);

  // Sync mode changes into ArimaBridge.
  useEffect(() => {
    if (!live || !expectedOrigin) return;
    postToBridge({ type: "arima:mode", mode });
    if (mode !== "pick") setHoveredElement(null);
  }, [live, expectedOrigin, mode, postToBridge]);

  const vp = VIEWPORTS[viewport];
  const frameHeight = Math.min(640, vp.height);

  // Capture a frozen snapshot when entering Freeze & Draw in live mode.
  const triggerFreezeSnapshot = useCallback(async () => {
    if (!live || !projectId || !activeTarget) return;
    setSnapshotLoading(true);
    setSnapshotFallbackUsed(false);
    try {
      const res = await capturePreviewSnapshot(projectId, {
        targetId: activeTarget.id,
        pageUrl: urlInput,
        viewportWidth: vp.width,
        viewportHeight: frameHeight,
      });
      if (res.imageDataUrl && res.imageDataUrl.startsWith("data:image/")) {
        setFrozenSnapshotUrl(res.imageDataUrl);
      }
      if (res.fallback || !res.imageDataUrl) {
        setSnapshotFallbackUsed(true);
        postToBridge({ type: "arima:request-snapshot" });
      }
    } catch {
      setSnapshotFallbackUsed(true);
      postToBridge({ type: "arima:request-snapshot" });
    } finally {
      setSnapshotLoading(false);
    }
  }, [live, projectId, activeTarget, urlInput, vp.width, frameHeight, postToBridge]);

  const handleModeSwitch = (nextMode: PreviewInteractMode) => {
    setMode(nextMode);
    if (nextMode === "draw" && live && activeTarget) {
      void triggerFreezeSnapshot();
    } else if (nextMode !== "draw") {
      setFrozenSnapshotUrl(null);
    }
  };

  // Redraw annotation strokes whenever strokes or viewport change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderStrokes(canvas, strokes, drawingRef.current);
  }, [strokes, viewport, mode]);

  if (!snap) return null;

  const getCoords = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width / Math.max(1, rect.width);
    const scaleY = e.currentTarget.height / Math.max(1, rect.height);
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (mode !== "draw") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getCoords(e);
    if (tool === "callout") {
      const nextNum = strokes.filter((s) => s.tool === "callout").length + 1;
      setStrokes((prev) => [...prev, { tool: "callout", color, points: [pt], calloutNum: nextNum }]);
      setRedoStack([]);
      return;
    }
    drawingRef.current = { tool, color, points: [pt] };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const cur = drawingRef.current;
    if (!cur || mode !== "draw") return;
    cur.points.push(getCoords(e));
    if (canvasRef.current) {
      renderStrokes(canvasRef.current, strokes, cur);
    }
  };

  const onPointerUp = () => {
    if (!drawingRef.current) return;
    const finished = drawingRef.current;
    drawingRef.current = null;
    setStrokes((prev) => [...prev, finished]);
    setRedoStack([]);
  };

  const undo = () => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [last, ...r]);
      return prev.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const [first, ...rest] = prev;
      setStrokes((s) => [...s, first]);
      return rest;
    });
  };

  const handleUrlNavigate = () => {
    if (!live || !activeTarget) return;
    const raw = urlInput.trim();
    if (!raw) return;
    let nextPath = "/";
    if (raw.startsWith("/")) {
      nextPath = raw;
    } else {
      try {
        const parsed = new URL(raw);
        nextPath = `${parsed.pathname}${parsed.search}` || "/";
      } catch {
        nextPath = "/";
      }
    }
    void exchangePreviewSession(activeTarget.id, nextPath);
  };

  const recentFeedback = snap.visualFeedback ?? [];
  const targetOptions =
    targets.length > 0
      ? targets.map((t) => ({ value: t.id, label: `${t.label} (${t.mode} · ${t.status})` }))
      : [{ value: "", label: live ? "No running preview targets detected" : "Local Dev Server (:3000)" }];

  const originPortLabel = (() => {
    if (expectedOrigin) {
      try {
        const u = new URL(expectedOrigin);
        return u.port ? `:${u.port}` : u.host;
      } catch {
        return expectedOrigin;
      }
    }
    return ":7421";
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top Toolbar */}
      <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[var(--border-hairline)] bg-cream-2/50 px-4 py-2.5 md:px-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <PageTitle
            title="Live Preview"
            context={
              <>
                <span className="hidden sm:inline">
                  Isolated preview ({originPortLabel}) · DOM element picker &amp; Freeze &amp; Draw annotations
                </span>
                <span className="sm:hidden">Isolated ({originPortLabel})</span>
              </>
            }
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Target Selector */}
          <Select
            className="w-auto min-w-[160px] max-w-[260px]"
            size="sm"
            value={activeTarget?.id ?? ""}
            ariaLabel="Preview target"
            onChange={(v) => setTargetId(v)}
            options={targetOptions}
          />

          {live && (
            <button
              type="button"
              className="btn px-2.5 py-1 text-[12px]"
              disabled={refreshingTargets}
              onClick={() => void refreshLiveState()}
              title="Discover running dev servers and refresh preview targets"
            >
              <Icon name="refresh" size={15} />
              {refreshingTargets ? "Scanning…" : "Refresh"}
            </button>
          )}

          {/* Viewport Switcher */}
          <div className="flex rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-0.5" role="group" aria-label="Viewport size">
            {(Object.keys(VIEWPORTS) as ViewportPreset[]).map((k) => {
              const v = VIEWPORTS[k];
              const on = viewport === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setViewport(k)}
                  className={`flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    on ? "bg-cream-2 text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  <Icon name={v.icon} size={16} />
                  <span>{v.label}</span>
                </button>
              );
            })}
          </div>

          {/* Mode Switcher: Browse / Pick Element / Freeze & Draw */}
          <div className="flex rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-0.5" role="group" aria-label="Preview interaction mode">
            {(
              [
                { id: "browse", label: "Browse", icon: "ads_click" },
                { id: "pick", label: "Pick Element", icon: "select_all" },
                { id: "draw", label: "Freeze & Draw", icon: "draw" },
              ] as const
            ).map((m) => {
              const on = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => handleModeSwitch(m.id)}
                  className={`flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    on
                      ? "bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] font-semibold text-ink"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  <Icon name={m.icon} size={16} className={on ? "text-accent" : ""} />
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>

          {!isViewer && (
            <button
              type="button"
              onClick={() => setSubmitOpen(true)}
              className="btn btn-primary flex items-center gap-1.5 text-[13px]"
            >
              <Icon name="bug_report" size={16} />
              Send Feedback
              {(strokes.length > 0 || pickedElement) && (
                <span className="rounded-full bg-white/20 px-1.5 text-[12px]">
                  {strokes.length + (pickedElement ? 1 : 0)}
                </span>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Secondary Bar: URL Bar + Draw Tools when in Draw mode */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-card)] px-4 py-2 md:px-5">
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleUrlNavigate();
          }}
        >
          <span
            className="chip text-[12px]"
            style={{ ["--c" as string]: bridgeReady || !live ? "var(--color-green)" : "var(--color-amber)" }}
            title={expectedOrigin ? `Origin-isolated session on ${expectedOrigin}` : "Origin-isolated preview proxy"}
          >
            <Icon name="lock" size={14} /> Isolated {originPortLabel}
          </span>
          <input
            className="field max-w-[460px] text-[12px]"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            aria-label="Preview URL"
          />
          {live && activeTarget && (
            <button type="submit" className="btn px-2.5 py-1 text-[12px]" disabled={tokenLoading}>
              Go
            </button>
          )}
          <span className="shrink-0 whitespace-nowrap text-[12px] text-muted">
            {vp.width} × {frameHeight}
          </span>
        </form>

        {mode === "draw" && (
          <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Annotation tools">
            {DRAW_TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tool === t.id}
                onClick={() => setTool(t.id)}
                className="btn flex items-center gap-1 px-2.5 py-1 text-[12px]"
              >
                <Icon name={t.icon} size={15} />
                {t.label}
              </button>
            ))}

            <div className="mx-1 flex items-center gap-1">
              {INK_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.hex)}
                  aria-label={`${c.label} ink`}
                  className={`h-5 w-5 cursor-pointer rounded-full border-2 ${
                    color === c.hex ? "scale-110 border-ink" : "border-transparent"
                  }`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>

            {live && activeTarget && (
              <button
                type="button"
                className="btn px-2 py-1 text-[12px]"
                disabled={snapshotLoading}
                onClick={() => void triggerFreezeSnapshot()}
                title="Capture a fresh snapshot from the running app"
              >
                <Icon name="photo_camera" size={15} />
                {snapshotLoading ? "Capturing…" : "Recapture"}
              </button>
            )}

            <button
              type="button"
              className="btn px-2 py-1 text-[12px]"
              disabled={strokes.length === 0}
              onClick={undo}
              title="Undo stroke"
            >
              <Icon name="undo" size={15} /> Undo
            </button>
            <button
              type="button"
              className="btn px-2 py-1 text-[12px]"
              disabled={redoStack.length === 0}
              onClick={redo}
              title="Redo stroke"
            >
              <Icon name="redo" size={15} /> Redo
            </button>
            <button
              type="button"
              className="btn px-2 py-1 text-[12px]"
              disabled={strokes.length === 0}
              onClick={() => {
                setStrokes([]);
                setRedoStack([]);
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Main Workspace: Viewport Frame + Inspector / Recent Feedback Sidebar */}
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="scroll-thin flex min-h-[380px] shrink-0 items-start justify-center overflow-auto bg-[var(--color-grass)] p-3 sm:p-4 lg:min-h-0 lg:flex-1 lg:shrink">
          <div
            className="relative overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-card)] shadow-[var(--card-shadow-hover)] transition-all"
            style={{
              width: `min(100%, ${vp.width}px)`,
              height: `${frameHeight}px`,
            }}
          >
            {/* Live Preview Iframe (stays mounted across Browse, Pick, and underneath Freeze & Draw) */}
            {live ? (
              iframeSrc ? (
                <iframe
                  ref={iframeRef}
                  src={iframeSrc}
                  title={activeTarget?.label ?? "Live Preview"}
                  className="h-full w-full border-0 bg-white"
                  sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                  onLoad={() => {
                    postToBridge({ type: "arima:mode", mode: modeRef.current });
                  }}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-xl border border-[var(--border-hairline)] bg-cream-2 text-muted">
                    <Icon name={tokenError ? "warning" : "web_asset"} size={24} />
                  </div>
                  <div className="text-[15px] font-semibold text-ink">
                    {tokenLoading
                      ? "Connecting to isolated preview…"
                      : tokenError
                        ? "Could not start preview session"
                        : "No running app preview detected"}
                  </div>
                  <p className="m-0 max-w-[420px] text-[13px] text-muted">
                    {tokenError
                      ? tokenError
                      : "Start a local, container, or sandbox dev server (e.g. port 3000, 5173, or 4173) and click Refresh to load it inside the origin-isolated preview proxy."}
                  </p>
                  <button
                    type="button"
                    className="btn text-[13px]"
                    onClick={() => {
                      if (activeTarget?.id) void exchangePreviewSession(activeTarget.id);
                      else void refreshLiveState();
                    }}
                  >
                    <Icon name="refresh" size={16} />
                    {activeTarget ? "Retry Session" : "Scan for Preview Targets"}
                  </button>
                </div>
              )
            ) : (
              /* Interactive Demo Surface for ?mock=1 */
              <div className="scroll-thin flex h-full select-none flex-col overflow-y-auto bg-[var(--surface-card)] p-4 text-ink sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-full bg-accent" />
                    <span className="truncate text-[15px] font-semibold">{snap.config.project.name} · Knowledge Portal</span>
                  </div>
                  <span className="max-w-full truncate rounded-full bg-cream-2 px-2.5 py-0.5 text-[12px] text-muted">
                    {urlInput}
                  </span>
                </div>

                <div className="mt-4 flex flex-col gap-3 sm:mt-5 sm:gap-4">
                  {DEMO_ELEMENTS.map((el) => {
                    const isPicked = pickedElement?.cssSelector === el.cssSelector;
                    return (
                      <div
                        key={el.cssSelector}
                        onClick={() => {
                          if (mode === "pick") setPickedElement(el);
                        }}
                        className={`rounded-xl border p-3 transition-all sm:p-4 ${
                          mode === "pick" ? "cursor-crosshair hover:border-[var(--accent)]" : ""
                        } ${
                          isPicked
                            ? "border-2 border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
                            : "border-[var(--border-hairline)] bg-cream-2/40"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <span className="text-[13px] font-semibold text-ink">{el.textSnippet}</span>
                          <code className="max-w-full truncate rounded bg-[var(--surface-card)] px-1.5 py-0.5 text-[12px] text-accent">
                            {el.componentHint}
                          </code>
                        </div>
                        <div className="mt-1 break-all text-[12px] text-muted">
                          Selector: <code>{el.cssSelector}</code>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Frozen Snapshot Overlay when in Live Freeze & Draw */}
            {mode === "draw" && frozenSnapshotUrl && (
              <img
                src={frozenSnapshotUrl}
                alt="Frozen preview snapshot"
                className="pointer-events-none absolute inset-0 z-[5] h-full w-full select-none object-cover object-top"
              />
            )}

            {mode === "draw" && live && (snapshotLoading || frozenSnapshotUrl) && (
              <div className="pointer-events-none absolute right-3 top-3 z-[15] flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface-card)]/90 px-2.5 py-1 text-[12px] font-medium text-ink shadow-sm">
                <span className="h-2 w-2 rounded-full bg-accent" />
                {snapshotLoading
                  ? "Freezing frame…"
                  : snapshotFallbackUsed
                    ? "Frozen (DOM fallback)"
                    : "Frozen snapshot"}
              </div>
            )}

            {/* Freeze & Draw Pointer Events Canvas Overlay */}
            <canvas
              ref={canvasRef}
              width={vp.width}
              height={frameHeight}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              aria-label="Annotation drawing canvas"
              className={`absolute inset-0 z-[10] h-full w-full ${
                mode === "draw" ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"
              }`}
              style={{ touchAction: "none" }}
            />
          </div>
        </div>

        {/* Right Inspector & Submitted Feedback Sidebar */}
        <aside className="scroll-thin flex w-full shrink-0 flex-col gap-4 border-t border-[var(--border-hairline)] bg-cream-2/30 p-4 lg:w-[320px] lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <div>
            <h3 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
              Picked DOM Element
            </h3>
            {pickedElement ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--accent)] bg-[var(--surface-card)] p-3 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-ink">{pickedElement.tagName.toUpperCase()}</span>
                  <button
                    type="button"
                    className="cursor-pointer text-[12px] text-muted hover:text-ink"
                    onClick={() => setPickedElement(null)}
                  >
                    Clear
                  </button>
                </div>
                <code className="break-all text-[12px] text-accent">{pickedElement.cssSelector}</code>
                {pickedElement.componentHint && (
                  <span className="text-muted">Component: {pickedElement.componentHint}</span>
                )}
                {pickedElement.textSnippet && (
                  <span className="text-muted">“{pickedElement.textSnippet}”</span>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3 text-[12px] text-muted">
                {hoveredElement ? (
                  <div className="flex flex-col gap-1">
                    <span className="font-semibold text-ink">Hovering {hoveredElement.tagName.toUpperCase()}</span>
                    <code className="break-all text-accent">{hoveredElement.cssSelector}</code>
                    <span>Click in the preview to select this element.</span>
                  </div>
                ) : (
                  <>
                    Switch to <strong className="font-semibold text-ink">Pick Element</strong> and click any component in the preview
                    {!live ? ", or pick one below:" : "."}
                    {!live && (
                      <div className="mt-2 flex flex-col gap-1.5">
                        {DEMO_ELEMENTS.map((el) => (
                          <button
                            key={el.cssSelector}
                            type="button"
                            onClick={() => setPickedElement(el)}
                            className="btn w-full justify-start overflow-hidden px-2.5 py-1.5 text-left text-[12px]"
                            title={el.componentHint ?? el.cssSelector}
                          >
                            <span className="min-w-0 truncate">{el.componentHint}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {consoleErrors.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="m-0 text-[12px] font-semibold uppercase tracking-wide text-red">
                  Console &amp; Network Errors · {consoleErrors.length}
                </h3>
                <button
                  type="button"
                  className="cursor-pointer text-[12px] text-muted hover:text-ink"
                  onClick={() => setConsoleErrors([])}
                >
                  Clear
                </button>
              </div>
              <ul className="m-0 flex max-h-[160px] list-none flex-col gap-1.5 overflow-y-auto p-0">
                {consoleErrors.map((err, i) => (
                  <li
                    key={`${err.at}-${i}`}
                    className="rounded-lg border border-red/30 bg-red/10 px-2.5 py-1.5 text-[12px]"
                  >
                    <div className="font-medium text-ink">{err.message}</div>
                    {err.source && <div className="truncate text-muted">{err.source}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
              Annotations · {strokes.length} stroke{strokes.length === 1 ? "" : "s"}
            </h3>
            <p className="m-0 text-[12px] text-muted">
              Switch to <strong className="font-semibold text-ink">Freeze &amp; Draw</strong> to capture a snapshot and sketch freehand ink, arrows, boxes, or numbered callouts.
            </p>
          </div>

          <div>
            <h3 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
              Recent Visual Feedback · {recentFeedback.length}
            </h3>
            {recentFeedback.length === 0 ? (
              <p className="m-0 text-[12px] text-muted">
                Submitted annotations sync to <code>.arima/feedback/&lt;id&gt;/</code> in the target agent's workspace.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {recentFeedback.map((fb) => (
                  <li
                    key={fb.id}
                    className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-2.5 text-[12px]"
                  >
                    {live && projectId && (
                      <img
                        src={feedbackImageUrl(projectId, fb.id)}
                        alt={fb.note}
                        loading="lazy"
                        className="aspect-[16/10] w-full rounded border border-[var(--border-hairline)] bg-cream-2 object-cover object-top"
                      />
                    )}
                    <span className="font-semibold text-ink">{fb.note}</span>
                    <code className="truncate text-accent">{fb.workspaceRelDir}/annotated.png</code>
                    <span className="text-muted">
                      {fb.route.kind === "create-task"
                        ? `Created task ${fb.route.taskId ?? ""}`
                        : `Sent to ${fb.route.toAgentId}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {submitOpen && (
        <SubmitFeedbackModal
          targetId={activeTarget?.id ?? null}
          targetLabel={activeTarget?.label ?? snap.config.project.name}
          pageUrl={urlInput}
          viewportWidth={vp.width}
          viewportHeight={frameHeight}
          selection={pickedElement}
          consoleErrors={consoleErrors}
          strokes={strokes}
          frozenSnapshotUrl={frozenSnapshotUrl}
          onClose={() => setSubmitOpen(false)}
          onSubmitted={() => {
            setSubmitOpen(false);
            setStrokes([]);
            setRedoStack([]);
          }}
        />
      )}
    </div>
  );
}

function SubmitFeedbackModal({
  targetId,
  targetLabel,
  pageUrl,
  viewportWidth,
  viewportHeight,
  selection,
  consoleErrors,
  strokes,
  frozenSnapshotUrl,
  onClose,
  onSubmitted,
}: {
  targetId: string | null;
  targetLabel: string;
  pageUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  selection: ElementSelection | null;
  consoleErrors: ConsoleErrorEntry[];
  strokes: Stroke[];
  frozenSnapshotUrl: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const snap = useOffice((s) => s.snap)!;
  const live = useOffice((s) => s.live);
  const projectId = snap.config.project.id;

  const [routeKind, setRouteKind] = useState<"create-task" | "send-to-chat">("create-task");
  const [note, setNote] = useState("");
  const [boardId, setBoardId] = useState(snap.boards[0]?.id ?? "B1");
  const workers = snap.config.team.filter((a) => !a.isLead);
  const [agentId, setAgentId] = useState(workers[0]?.id ?? snap.config.team[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const cleanNote =
        note.trim() ||
        (selection
          ? `Fix layout/behavior on ${selection.componentHint ?? selection.cssSelector}`
          : "Visual polish from Live Preview");
      const route: FeedbackRoute =
        routeKind === "create-task"
          ? { kind: "create-task", boardId, taskId: null, assignToAgentId: agentId || null }
          : { kind: "send-to-chat", toAgentId: agentId || (snap.config.team[0]?.id ?? "hq"), messageId: null };

      const imageDataUrl = await compositeAnnotatedPng({
        width: viewportWidth,
        height: viewportHeight,
        backgroundUrl: frozenSnapshotUrl,
        fallbackTitle: targetLabel,
        fallbackSubtitle: selection ? `${pageUrl} · ${selection.cssSelector}` : pageUrl,
        strokes,
      });

      if (live && projectId) {
        const fb = await postVisualFeedback(projectId, {
          targetId,
          sourceKind: "live-preview",
          pageUrl,
          viewportWidth,
          viewportHeight,
          note: cleanNote,
          selection,
          consoleErrors,
          route,
          imageDataUrl,
        });
        officeActions.upsertVisualFeedback(fb);
      } else {
        officeActions.submitVisualFeedback({
          targetId,
          sourceKind: "live-preview",
          pageUrl,
          viewportWidth,
          viewportHeight,
          note: cleanNote,
          selection,
          consoleErrors,
          route,
          imageDataUrl,
        });
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Send Visual Feedback"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="hud-drawer flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)]">
        <header className="flex items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
          <h2 className="m-0 text-[20px] font-semibold text-ink">Route Visual Feedback</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-cream-2 hover:text-ink"
            aria-label="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="flex flex-col gap-3 p-5">
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={routeKind === "create-task"}
              onClick={() => setRouteKind("create-task")}
              className="btn flex-1 py-2 text-[13px]"
            >
              <Icon name="add_task" size={16} /> Create Board Task
            </button>
            <button
              type="button"
              aria-pressed={routeKind === "send-to-chat"}
              onClick={() => setRouteKind("send-to-chat")}
              className="btn flex-1 py-2 text-[13px]"
            >
              <Icon name="chat" size={16} /> Send to Agent Chat
            </button>
          </div>

          {selection && (
            <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 px-3 py-2 text-[12px]">
              <span className="font-semibold text-ink">Selected: </span>
              <code className="text-accent">{selection.cssSelector}</code>
            </div>
          )}

          {consoleErrors.length > 0 && (
            <div className="rounded-lg border border-red/30 bg-red/10 px-3 py-1.5 text-[12px] text-ink">
              Includes <strong className="font-semibold">{consoleErrors.length}</strong> captured console/network error
              {consoleErrors.length === 1 ? "" : "s"}.
            </div>
          )}

          <label className="flex flex-col gap-1 text-[12px] text-muted">
            What should change?
            <textarea
              className="field min-h-[84px] py-2 text-[13px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Describe the UI bug, spacing issue, or behavior to fix…"
            />
          </label>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {routeKind === "create-task" && (
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-muted">Board</span>
                <Select
                  value={boardId}
                  onChange={setBoardId}
                  ariaLabel="Target board"
                  options={snap.boards.map((b) => ({ value: b.id, label: `${b.id} · ${b.title}` }))}
                />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-muted">
                {routeKind === "create-task" ? "Assign to agent" : "Send to agent"}
              </span>
              <Select
                value={agentId}
                onChange={setAgentId}
                ariaLabel={routeKind === "create-task" ? "Assign to agent" : "Send to agent"}
                options={snap.config.team.map((a) => ({ value: a.id, label: `${a.name} (${a.role})` }))}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-5 py-3">
          <button type="button" className="btn text-[13px]" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary text-[13px]"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting
              ? "Sending…"
              : routeKind === "create-task"
                ? "Create Task with Screenshot"
                : "Send to Agent Chat"}
          </button>
        </footer>
      </div>
    </div>
  );
}
