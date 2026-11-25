import type { DecisionPayload, FormSpec, JsonValue, VisualDecision } from "../generated";
import type { AgentConfig } from "../types";

type RoleOption = { value: string; label: string };

function sideMd(heading: string, side: { label: string; authorId: string; summary: string; rationaleMarkdown: string; risks: string[] }, who: string): string {
  const parts = [`### ${heading}: ${side.label} (${who})`, side.summary];
  if (side.rationaleMarkdown.trim()) parts.push(side.rationaleMarkdown.trim());
  if (side.risks.length) {
    parts.push(["**Risks to watch:**", ...side.risks.map((r) => `- ${r}`)].join("\n"));
  }
  return parts.join("\n\n");
}

/** Synthesizes the same A2UI v1.0 FormSpec shape HQ produces for mock visual decisions. */
export function buildMockDecisionForm(
  payload: DecisionPayload,
  team: AgentConfig[] = [],
  roleOptions: RoleOption[] = [],
): FormSpec {
  const who = (id: string) => team.find((a) => a.id === id)?.name ?? id;

  if (payload.kind === "form") return payload.form;

  const components: Record<string, unknown>[] = [];
  const children: string[] = [];
  const data: { [key: string]: JsonValue } = {};
  let seq = 0;
  const add = (prefix: string, comp: Record<string, unknown>) => {
    const id = `${prefix}_${seq++}`;
    children.push(id);
    components.push({ id, ...comp });
  };

  switch (payload.kind) {
    case "permission": {
      const rows = [{ label: "Tool", value: payload.toolName }];
      if (payload.scopeHint) rows.push({ label: "Scope", value: payload.scopeHint });
      add("kv", { component: "KeyValue", rows });
      add("code", { component: "Code", code: payload.commandOrPath });
      if (payload.reason) add("text", { component: "Text", text: payload.reason });
      data.note = "";
      add("field", { component: "TextField", label: "Note", value: { "@path": "/note" }, placeholder: "Optional note…" });
      add("actions", {
        component: "ButtonRow",
        buttons: [
          { label: "Allow once", variant: "primary", action: { event: { name: "allow-once" } } },
          { label: "Allow for task", variant: "default", action: { event: { name: "allow-task" } } },
          { label: "Deny", variant: "default", action: { event: { name: "deny" } } },
        ],
      });
      break;
    }
    case "second-opinion":
    case "disagreement": {
      const rows: { label: string; value: string }[] = [];
      if (payload.recommendation) rows.push({ label: "Recommendation", value: payload.recommendation });
      if (payload.confidence) rows.push({ label: "Confidence", value: payload.confidence });
      if (payload.taskId) rows.push({ label: "Task", value: payload.taskId });
      if (payload.gateId) rows.push({ label: "Gate", value: payload.gateId });
      if (rows.length) add("kv", { component: "KeyValue", rows });
      add("md", { component: "Markdown", text: sideMd("Option A", payload.optionA, who(payload.optionA.authorId)) });
      add("md", { component: "Markdown", text: sideMd("Option B", payload.optionB, who(payload.optionB.authorId)) });
      data.note = "";
      add("field", {
        component: "TextField",
        label: "Note",
        value: { "@path": "/note" },
        placeholder: "Rationale or instructions for the team (optional)…",
      });
      const buttons = [
        { label: "Pick Option A", variant: "primary", action: { event: { name: "optionA" } } },
        { label: "Pick Option B", variant: "primary", action: { event: { name: "optionB" } } },
        { label: "Ask to Revise", variant: "default", action: { event: { name: "revise" } } },
      ];
      if (payload.canWaiveGate) buttons.push({ label: "Waive Gate", variant: "default", action: { event: { name: "waive" } } });
      add("actions", { component: "ButtonRow", buttons });
      break;
    }
    case "meeting-request": {
      const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const rows = [
        { label: "Kind", value: cap(payload.meetingKind) },
        { label: "Urgency", value: cap(payload.urgency) },
      ];
      if (payload.participantIds.length) {
        rows.push({ label: "Participants", value: payload.participantIds.map(who).join(", ") });
      }
      add("kv", { component: "KeyValue", rows });
      if (payload.agendaPreview.length) {
        add("md", { component: "Markdown", text: `### Agenda\n${payload.agendaPreview.map((x) => `- ${x}`).join("\n")}` });
      }
      add("actions", {
        component: "ButtonRow",
        buttons: [
          { label: "Join now", variant: "primary", action: { event: { name: "join" } } },
          { label: "Snooze", variant: "default", action: { event: { name: "snooze" } } },
          { label: "Decline", variant: "default", action: { event: { name: "decline" } } },
        ],
      });
      break;
    }
    case "question": {
      for (const q of payload.questions) {
        if (!q.options.length) continue;
        const recs = q.options.filter((o) => o.recommended).map((o) => o.id);
        const existing = payload.answers.find((a) => a.questionId === q.id);
        data[`q_${q.id}`] = existing
          ? existing.selectedOptionIds
          : recs.length
            ? q.multiSelect
              ? recs
              : [recs[0]]
            : [q.options[0].id];
        add("list", {
          component: "CheckList",
          label: q.prompt,
          multi: q.multiSelect,
          options: q.options.map((o) => ({
            value: o.id,
            label: o.recommended ? `${o.label} (Recommended)` : o.label,
            ...(o.description ? { description: o.description } : {}),
          })),
          values: { "@path": `/q_${q.id}` },
        });
        if (q.allowOther) {
          data[`other_${q.id}`] = existing?.otherText ?? "";
          add("field", {
            component: "TextField",
            label: "Other preference or constraint (optional)",
            value: { "@path": `/other_${q.id}` },
            placeholder: "Optional custom answer…",
          });
        }
      }
      data.note = "";
      add("field", { component: "TextField", label: "Note", value: { "@path": "/note" }, placeholder: "Optional note for the agent…" });
      add("actions", {
        component: "ButtonRow",
        buttons: [{ label: "Submit answer", variant: "primary", action: { event: { name: "submit" } } }],
      });
      break;
    }
    case "pack-review": {
      data.roles = payload.roles;
      if (roleOptions.length) {
        add("list", {
          component: "CheckList",
          label: "Roles that get its skills",
          multi: true,
          options: roleOptions.map((r) => ({ value: r.value, label: r.label })),
          values: { "@path": "/roles" },
        });
      }
      data.note = "";
      add("field", { component: "TextField", label: "Note", value: { "@path": "/note" }, placeholder: "Note for the agent (optional)…" });
      add("actions", {
        component: "ButtonRow",
        buttons: [
          { label: "Approve", variant: "primary", action: { event: { name: "approve" } } },
          { label: "Send back", variant: "default", action: { event: { name: "reject" } } },
        ],
      });
      break;
    }
    case "skill-scan": {
      add("kv", { component: "KeyValue", rows: [{ label: "Skill", value: payload.pack }] });
      if (payload.findings.length) {
        add("md", { component: "Markdown", text: `### Scan findings\n${payload.findings.map((f) => `- \`${f}\``).join("\n")}` });
      }
      data.note = "";
      add("field", { component: "TextField", label: "Note", value: { "@path": "/note" }, placeholder: "Note for the agent (optional)…" });
      add("actions", {
        component: "ButtonRow",
        buttons: [
          { label: "Approve", variant: "primary", action: { event: { name: "approve" } } },
          { label: "Send back", variant: "default", action: { event: { name: "reject" } } },
        ],
      });
      break;
    }
    case "memory-review":
    case "info": {
      if (payload.kind === "info" && payload.markdown.trim()) {
        add("md", { component: "Markdown", text: payload.markdown });
      }
      data.note = "";
      add("field", { component: "TextField", label: "Note", value: { "@path": "/note" }, placeholder: "Note for the agent (optional)…" });
      add("actions", {
        component: "ButtonRow",
        buttons: [
          { label: "Approve", variant: "primary", action: { event: { name: "approve" } } },
          { label: "Send back", variant: "default", action: { event: { name: "reject" } } },
        ],
      });
      break;
    }
  }

  return {
    components: [{ id: "root", component: "Column", children }, ...components] as JsonValue[],
    data,
  };
}

export function withMockForm(dec: VisualDecision, team: AgentConfig[] = []): VisualDecision {
  return {
    ...dec,
    form: dec.form ?? buildMockDecisionForm(dec.payload, team),
    answer: dec.answer ?? null,
  };
}
