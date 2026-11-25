import { useRef, useState } from "react";
import type { FormAnswer, FormSpec, JsonValue, VisualDecision } from "../../data/generated";
import { useAuth } from "../../store/auth";
import { isViewer, officeActions } from "../../store/office";
import { Icon } from "../deck/Icon";
import { FORM_CATALOG_ID, FormLocked, FormSurfaceView } from "./formCatalog";
import { extractCreateSurface, isPlainObject, resolveActionContext, setPointer } from "./formPointers";

/** The label of the button the owner pressed, read back from the form itself. */
function pressedLabel(form: FormSpec, answer: FormAnswer | null): string | null {
  if (!answer) return null;
  const row = form.components.find((c) => (c as { id?: unknown })?.id === answer.componentId) as
    | { buttons?: { label?: string; action?: { event?: { name?: string } } }[] }
    | undefined;
  return row?.buttons?.find((b) => b.action?.event?.name === answer.action)?.label ?? answer.action;
}

const DISMISS_ACTIONS = new Set(["deny", "decline", "revise", "reject"]);

/** Unified card body: renders every Inbox and inline Chat decision with our A2UI v1.0 surface renderer. */
export default function FormCard({
  decision,
  form,
  answer = null,
  onAfterAction,
}: {
  decision: VisualDecision;
  form: FormSpec;
  answer?: FormAnswer | null;
  compact?: boolean;
  onAfterAction?: (action: string) => void;
}) {
  const isOwner = useAuth((s) => s.role === "owner" || s.status === "none");
  const resolved = decision.status !== "open";
  const locked = resolved || isViewer || (decision.ownerOnly && !isOwner);
  const sent = useRef(false);

  const initialEnvelope = {
    version: "1.0",
    createSurface: {
      surfaceId: decision.id,
      catalogId: FORM_CATALOG_ID,
      components: form.components,
      dataModel: (answer?.data ?? form.data) as Record<string, unknown>,
    },
  };
  const surface = extractCreateSurface(initialEnvelope, decision.id);

  const [data, setData] = useState<Record<string, unknown>>(() => surface?.dataModel ?? {});
  const dataRef = useRef(data);

  const onBindChange = (pointer: string, nextValue: unknown) => {
    if (locked) return;
    const nextData = setPointer(dataRef.current, pointer, nextValue);
    dataRef.current = nextData;
    setData(nextData);
  };

  const onButtonAction = (componentId: string, action: Record<string, unknown>) => {
    if (locked || sent.current) return;
    const event = isPlainObject(action.event) ? action.event : null;
    if (!event || typeof event.name !== "string") return;
    sent.current = true;
    const current = dataRef.current;
    const context = resolveActionContext(event.context, current);
    officeActions.answerDecision(decision.id, {
      status: DISMISS_ACTIONS.has(event.name) ? "dismissed" : "resolved",
      formAnswer: {
        action: event.name,
        componentId,
        context: context as JsonValue,
        data: current as JsonValue,
      },
    });
    onAfterAction?.(event.name);
  };

  const dismiss = () => {
    if (locked || sent.current) return;
    sent.current = true;
    officeActions.answerDecision(decision.id, { status: "dismissed" });
  };

  const showDismiss = !locked && (decision.payload.kind === "form" || decision.payload.kind === "question");

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/40 p-3">
        {surface ? (
          <FormLocked.Provider value={locked}>
            <FormSurfaceView
              components={surface.components}
              data={data}
              locked={locked}
              onBindChange={onBindChange}
              onButtonAction={onButtonAction}
            />
          </FormLocked.Provider>
        ) : (
          <p className="m-0 text-[13px] text-muted">This form can&apos;t be shown.</p>
        )}
      </div>
      {showDismiss && (
        <div className="flex">
          <button type="button" className="btn text-[13px]" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}
      {locked && decision.payload.kind === "meeting-request" && (
        <div className="flex">
          <button type="button" className="btn btn-primary flex items-center gap-1.5 text-[13px]" onClick={() => onAfterAction?.("join")}>
            <Icon name="forum" size={16} /> Join now
          </button>
        </div>
      )}
      {resolved && (
        <div className="flex items-center gap-2 text-[12px] text-muted" role="status">
          <Icon name="check_circle" size={16} className="text-green" />
          <span>
            {decision.status === "resolved" ? `Answered${answer ? `: ${pressedLabel(form, answer)}` : ""}` : "Dismissed"}
            {decision.note ? ` · “${decision.note}”` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
