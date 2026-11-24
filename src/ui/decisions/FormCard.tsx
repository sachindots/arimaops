import { useRef, useState } from "react";
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react";
import { MessageProcessor, type ActionPayload, type SurfaceModel } from "@a2ui/web_core";
import type { FormPayload, JsonValue, VisualDecision } from "../../data/generated";
import { isViewer, officeActions } from "../../store/office";
import { Icon } from "../deck/Icon";
import { FORM_CATALOG_ID, FormLocked, formCatalog } from "./formCatalog";

/** The label of the button the owner pressed, read back from the form itself. */
function pressedLabel(payload: FormPayload): string | null {
  const a = payload.answer;
  if (!a) return null;
  const row = payload.form.components.find((c) => (c as { id?: unknown })?.id === a.componentId) as { buttons?: { label?: string; action?: { event?: { name?: string } } }[] } | undefined;
  return row?.buttons?.find((b) => b.action?.event?.name === a.action)?.label ?? a.action;
}

/** An agent form: the agent's checked components rendered with the agent-forms catalog. Lazy-loaded by VisualDecisionCard. */
export default function FormCard({ decision, payload }: { decision: VisualDecision; payload: FormPayload }) {
  const resolved = decision.status !== "open";
  const locked = resolved || isViewer;
  const sent = useRef(false);
  const [surface] = useState(() => {
    let model: SurfaceModel<ReactCatalogComponent> | undefined;
    const onAction = (a: ActionPayload) => {
      if (locked || sent.current || !model) return;
      sent.current = true;
      officeActions.answerDecision(decision.id, {
        status: "resolved",
        formAnswer: { action: a.name, componentId: a.sourceComponentId, context: a.context as JsonValue, data: model.dataModel.get("/") as JsonValue },
      });
    };
    try {
      const processor = new MessageProcessor<ReactCatalogComponent>([formCatalog], onAction);
      const data = payload.answer?.data ?? payload.form.data;
      processor.processMessages([
        { version: "1.0", createSurface: { surfaceId: decision.id, catalogId: FORM_CATALOG_ID, components: payload.form.components, dataModel: data } },
      ] as Parameters<typeof processor.processMessages>[0]);
      model = processor.model.surfacesMap.get(decision.id);
    } catch {
      model = undefined;
    }
    return model;
  });

  const dismiss = () => {
    if (locked) return;
    officeActions.answerDecision(decision.id, { status: "dismissed" });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/40 p-3">
        {surface ? (
          <FormLocked.Provider value={locked}>
            <A2uiSurface surface={surface} />
          </FormLocked.Provider>
        ) : (
          <p className="m-0 text-[13px] text-muted">This form can't be shown.</p>
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
