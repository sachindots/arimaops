// Freeze & Draw evidence annotation modal: opened from Verifier PR evidence screenshots
// in TaskSheet and PrDrawer. Composites strokes onto the screenshot and submits as visual feedback.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { FeedbackRoute } from "../../data/generated";
import { officeActions, useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";
import { Select } from "../primitives/Select";
import {
  compositeAnnotatedPng,
  DRAW_TOOLS,
  INK_COLORS,
  postVisualFeedback,
  renderStrokes,
  type DrawTool,
  type Stroke,
} from "./annotation";

export interface AnnotateModalProps {
  imageUrl: string;
  title: string;
  sourceKind?: string;
  pageUrl?: string;
  taskId?: string;
  prNumber?: number;
  onClose: () => void;
}

export function AnnotateModal({
  imageUrl,
  title,
  sourceKind = "pr-evidence",
  pageUrl,
  taskId,
  prNumber,
  onClose,
}: AnnotateModalProps) {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const projectId = snap?.config.project.id ?? "";

  const [tool, setTool] = useState<DrawTool>("pen");
  const [color, setColor] = useState<string>(INK_COLORS[1].hex);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [dims, setDims] = useState({ width: 960, height: 600 });

  const [routeKind, setRouteKind] = useState<"create-task" | "send-to-chat">("create-task");
  const [note, setNote] = useState("");
  const [boardId, setBoardId] = useState(snap?.boards[0]?.id ?? "B1");
  const workers = (snap?.config.team ?? []).filter((a) => !a.isLead);
  const [agentId, setAgentId] = useState(workers[0]?.id ?? snap?.config.team[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedNote, setSubmittedNote] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<Stroke | null>(null);

  // Escape closes only this modal (capture phase stops TaskSheet and App underneath from closing too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[data-select-popover="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderStrokes(canvas, strokes, drawingRef.current);
  }, [strokes, dims]);

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
    if (!cur) return;
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

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const contextPrefix = prNumber ? `PR #${prNumber}` : taskId ? taskId : "Evidence";
      const cleanNote = note.trim() || `Annotated evidence feedback on ${contextPrefix}: ${title}`;
      const route: FeedbackRoute =
        routeKind === "create-task"
          ? { kind: "create-task", boardId, taskId: null, assignToAgentId: agentId || null }
          : { kind: "send-to-chat", toAgentId: agentId || (snap.config.team[0]?.id ?? "hq"), messageId: null };

      const imageDataUrl = await compositeAnnotatedPng({
        width: dims.width,
        height: dims.height,
        backgroundUrl: imageUrl,
        fallbackTitle: `${contextPrefix} · ${title}`,
        fallbackSubtitle: pageUrl ?? imageUrl,
        strokes,
      });

      const resolvedPageUrl = pageUrl ?? (imageUrl.startsWith("data:") ? `evidence://${taskId ?? "pr"}/${title}` : imageUrl);

      if (live && projectId) {
        const fb = await postVisualFeedback(projectId, {
          targetId: null,
          sourceKind,
          pageUrl: resolvedPageUrl,
          viewportWidth: dims.width,
          viewportHeight: dims.height,
          note: cleanNote,
          selection: null,
          consoleErrors: [],
          route,
          imageDataUrl,
        });
        officeActions.upsertVisualFeedback(fb);
        setSubmittedNote(`Saved ${fb.workspaceRelDir}/annotated.png`);
      } else {
        officeActions.submitVisualFeedback({
          targetId: null,
          sourceKind,
          pageUrl: resolvedPageUrl,
          viewportWidth: dims.width,
          viewportHeight: dims.height,
          note: cleanNote,
          selection: null,
          consoleErrors: [],
          route,
          imageDataUrl,
        });
        setSubmittedNote(routeKind === "create-task" ? "Created board task with annotated evidence." : "Sent annotated evidence to agent chat.");
      }
      setTimeout(onClose, 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      data-annotate-modal="true"
      aria-label={`Annotate evidence: ${title}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="hud-drawer flex max-h-[92dvh] w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)]">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-cream-2/50 px-5 py-3">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-[15px] font-semibold text-ink">
              Annotate Evidence · {title}
            </h2>
            <p className="m-0 text-[12px] text-muted">
              {prNumber ? `PR #${prNumber}` : null}
              {prNumber && taskId ? " · " : null}
              {taskId ? `Task ${taskId}` : null}
              {prNumber || taskId ? " · " : null}
              Draw directly over the verifier screenshot and route feedback to the team.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-cream-2 hover:text-ink"
            aria-label="Close annotation modal"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {/* Drawing Toolbar */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-card)] px-5 py-2"
          role="toolbar"
          aria-label="Annotation tools"
        >
          <div className="flex flex-wrap items-center gap-1.5">
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

            <div className="mx-1.5 flex items-center gap-1.5">
              {INK_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.hex)}
                  aria-label={`${c.label} ink`}
                  className={`h-5 w-5 cursor-pointer rounded-full border-2 transition-transform ${
                    color === c.hex ? "scale-110 border-ink" : "border-transparent"
                  }`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[12px] text-muted">
              {strokes.length} stroke{strokes.length === 1 ? "" : "s"}
            </span>
            <button type="button" className="btn px-2 py-1 text-[12px]" disabled={strokes.length === 0} onClick={undo}>
              <Icon name="undo" size={15} /> Undo
            </button>
            <button type="button" className="btn px-2 py-1 text-[12px]" disabled={redoStack.length === 0} onClick={redo}>
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
        </div>

        {/* Body: Image + Canvas on left, Routing Form on right */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          <div className="scroll-thin flex min-h-[260px] flex-1 items-center justify-center overflow-auto bg-[var(--color-grass)] p-4">
            <div className="relative inline-block max-w-full overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-card)] shadow-[var(--card-shadow)]">
              <img
                src={imageUrl}
                alt={title}
                onLoad={(e) => {
                  const nw = e.currentTarget.naturalWidth || 960;
                  const nh = e.currentTarget.naturalHeight || 600;
                  const maxW = 1280;
                  const scale = nw > maxW ? maxW / nw : 1;
                  setDims({
                    width: Math.max(320, Math.round(nw * scale)),
                    height: Math.max(200, Math.round(nh * scale)),
                  });
                }}
                className="pointer-events-none block max-h-[60dvh] max-w-full select-none object-contain"
              />
              <canvas
                ref={canvasRef}
                width={dims.width}
                height={dims.height}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                aria-label="Evidence annotation drawing canvas"
                className="absolute inset-0 h-full w-full cursor-crosshair"
                style={{ touchAction: "none" }}
              />
            </div>
          </div>

          <aside className="scroll-thin flex w-full shrink-0 flex-col gap-3.5 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--surface-card)] p-4 lg:w-[320px] lg:border-t-0 lg:border-l">
            <div className="flex gap-2">
              <button
                type="button"
                aria-pressed={routeKind === "create-task"}
                onClick={() => setRouteKind("create-task")}
                className="btn flex-1 px-2.5 py-2 text-[12px]"
              >
                <Icon name="add_task" size={16} /> Board Task
              </button>
              <button
                type="button"
                aria-pressed={routeKind === "send-to-chat"}
                onClick={() => setRouteKind("send-to-chat")}
                className="btn flex-1 px-2.5 py-2 text-[12px]"
              >
                <Icon name="chat" size={16} /> Agent Chat
              </button>
            </div>

            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
              What should change?
              <textarea
                className="field min-h-[100px] py-2 text-[13px]"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Describe what is wrong in the screenshot and how to fix it…"
              />
            </label>

            {routeKind === "create-task" && (
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-muted">Board</span>
                <Select
                  value={boardId}
                  onChange={setBoardId}
                  ariaLabel="Target board"
                  options={snap.boards.map((b) => ({ value: b.id, label: `${b.id} · ${b.title}` }))}
                />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-muted">
                {routeKind === "create-task" ? "Assign to agent" : "Send to agent"}
              </span>
              <Select
                value={agentId}
                onChange={setAgentId}
                ariaLabel={routeKind === "create-task" ? "Assign to agent" : "Send to agent"}
                options={snap.config.team.map((a) => ({ value: a.id, label: `${a.name} (${a.role})` }))}
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
                {error}
              </div>
            )}
            {submittedNote && (
              <div className="flex items-center gap-1.5 rounded-lg border border-green/40 bg-green/10 px-3 py-2 text-[12px] font-medium text-green" role="status">
                <Icon name="check_circle" size={16} />
                <span>{submittedNote}</span>
              </div>
            )}

            <div className="mt-auto flex items-center justify-end gap-2 pt-2">
              <button type="button" className="btn text-[13px]" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary text-[13px]"
                disabled={submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting
                  ? "Saving…"
                  : routeKind === "create-task"
                    ? "Create Task"
                    : "Send to Chat"}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
