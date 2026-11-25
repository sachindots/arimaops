import { useRef, useState } from "react";
import type { FormPayload, JsonValue, VisualDecision } from "../../data/generated";
import { isViewer, officeActions } from "../../store/office";
import { Icon } from "../deck/Icon";
import { FORM_CATALOG_ID, FormLocked, FormSurfaceView } from "./formCatalog";
import { extractCreateSurface, isPlainObject, resolveActionContext, setPointer } from "./formPointers";

/** The label of the button the owner pressed, read back from the form itself. */
function pressedLabel(payload: FormPayload): string | null {
  const a = payload.answer;
  if (!a) return null;
  const row = payload.form.components.find((c) => (c as { id?: unknown })?.id === a.componentId) as
    | { buttons?: { label?: string; action?: { event?: { name?: string } } }[] }
    | undefined;
  return row?.buttons?.find((b) => b.action?.event?.name === a.action)?.label ?? a.action;
}

/** An agent form: rendered with our own A2UI v1.0 surface renderer and command-deck catalog. */
export default function FormCard({ decision, payload }: { decision: VisualDecision; payload: FormPayload }) {
  const resolved = decision.status !== "open";
  const locked = resolved || isViewer;
  const sent = useRef(false);

  const initialEnvelope = {
    version: "1.0",
    createSurface: {
      surfaceId: decision.id,
      catalogId: FORM_CATALOG_ID,
      components: payload.form.components,
      dataModel: (payload.answer?.data ?? payload.form.data) as Record<string, unknown>,
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
      status: "resolved",
      formAnswer: {
        action: event.name,
        componentId,
        context: context as JsonValue,
        data: current as JsonValue,
      },
    });
  };

  const dismiss = () => {
    if (locked) return;
    officeActions.answerDecision(decision.id, { status: "dismissed" });
  };

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
      {!locked ? (
        <div className="flex">
          <button type="button" className="btn text-[13px]" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      ) : (
        resolved && (
          <div className="flex items-center gap-2 text-[12px] text-muted" role="status">
            <Icon name="check_circle" size={16} className="text-green" />
            <span>{decision.status === "resolved" ? `Answered${payload.answer ? `: ${pressedLabel(payload)}` : ""}` : "Dismissed"}</span>
          </div>
        )
      )}
    </div>
  );
}
