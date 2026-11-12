// SPDX-License-Identifier: AGPL-3.0-or-later
// The task brief (docs/core-model.md section 8): what an agent needs to start a task without
// re-exploring, in one text of about 4k tokens. One function builds every brief.
//
// Over budget, it cuts in this order: older handoffs, older ledger entries, memory, older repo
// facts, the spec, then the task description; and it says what it left out.

import { BRIEF_BUDGET, type BriefInput } from "../src/data/model";

/** About four characters per token: close enough for a budget, and free. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const cut = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1)).trimEnd()}…`);
const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, ...lines, ""] : []);

export interface Brief {
  text: string;
  tokens: number;
  /** What was left out to fit, e.g. "2 handoffs". */
  trimmed: string[];
}

export function buildBrief(input: BriefInput, budget = BRIEF_BUDGET): Brief {
  const s = {
    handoffs: [...input.handoffs],
    ledger: [...input.ledger],
    memory: input.memory.trim(),
    facts: [...input.facts],
    spec: input.spec.trim(),
    description: (input.task.description ?? "").trim(),
  };
  const dropped = { handoffs: 0, ledger: 0, facts: 0 };
  const shortened = new Set<string>();

  const render = () => {
    const t = input.task;
    const left = [
      ...(dropped.handoffs ? [`${dropped.handoffs} older handoff${dropped.handoffs === 1 ? "" : "s"}`] : []),
      ...(dropped.ledger ? [`${dropped.ledger} older ledger entr${dropped.ledger === 1 ? "y" : "ies"}`] : []),
      ...(dropped.facts ? [`${dropped.facts} older repo fact${dropped.facts === 1 ? "" : "s"}`] : []),
      ...[...shortened].map((x) => `part of the ${x}`),
    ];
    return [
      `# ${t.id}: ${t.title}`,
      "",
      ...(s.description ? [s.description, ""] : []),
      ...(t.files?.length ? [`Files you may edit: ${t.files.join(", ")}`] : []),
      ...(t.doneWhen?.trim() ? [`Done when: ${t.doneWhen.trim()}`] : []),
      "",
      ...section("Gates before done", input.gates.map((g) => `- ${g.id} (${g.kind}): ${g.needs}`)),
      ...section("Spec", s.spec ? [s.spec] : []),
      ...section("Handoffs", s.handoffs.map((h) => `- ${h.taskId}${h.by ? ` (${h.by})` : ""}: ${h.note}`)),
      ...section("Lead's ledger", s.ledger.map((e) => `- ${e.kind}: ${e.text}`)),
      ...section("Memory", s.memory ? [s.memory] : []),
      ...section("Repo facts", s.facts.map((f) => `- ${f}`)),
      ...section("Skills", input.skills.length ? [input.skills.join(", ")] : []),
      ...(left.length ? [`_Left out to fit the brief: ${left.join(", ")}. Ask the lead if you need them._`] : []),
    ]
      .join("\n")
      .trimEnd();
  };

  const over = () => estimateTokens(render()) > budget;
  const halve = (key: "memory" | "spec" | "description", label: string) => {
    s[key] = cut(s[key], Math.floor(s[key].length / 2));
    if (s[key].length < 40) s[key] = "";
    shortened.add(label);
  };
  // Each step makes the brief strictly shorter, so the loop ends.
  while (over()) {
    if (s.handoffs.length) (s.handoffs.shift(), dropped.handoffs++);
    else if (s.ledger.length) (s.ledger.shift(), dropped.ledger++);
    else if (s.memory) halve("memory", "memory");
    else if (s.facts.length) (s.facts.shift(), dropped.facts++);
    else if (s.spec) halve("spec", "spec");
    else if (s.description) halve("description", "task description");
    else break;
  }
  let text = render();
  // The fixed parts alone (a huge title or file list) can still be over: cut the text itself.
  if (estimateTokens(text) > budget) text = cut(text, budget * 4);
  return { text, tokens: estimateTokens(text), trimmed: [...Object.entries(dropped).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`), ...shortened] };
}
