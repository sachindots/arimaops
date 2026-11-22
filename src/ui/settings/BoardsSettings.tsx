import { useState } from "react";
import type { BoardStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { SectionTitle } from "../kit";
import { Select } from "../primitives/Select";
import { CommitInput } from "./controls";

export function BoardsSettings() {
  const snap = useOffice((s) => s.snap);
  const [title, setTitle] = useState("");
  if (!snap) return null;
  const boards = [...snap.boards].sort((a, b) => a.order - b.order);

  return (
    <div className="flex flex-col gap-5">
      <section>
        <SectionTitle>Boards · {boards.length}</SectionTitle>
        <p className="mb-3 text-[13px] text-muted">
          A project can have many boards: one per phase, or one per area. Agents pick work only from active boards. The lead tops up active boards when they run low.
        </p>
        <div className="flex flex-col gap-2">
          {boards.map((b) => {
            const tasks = snap.tasks.filter((t) => t.boardId === b.id);
            const done = tasks.filter((t) => t.status === "done").length;
            return (
              <div key={b.id} className="grid grid-cols-[60px_1fr_140px_120px] items-center gap-2.5 panel px-2.5 py-2">
                <span className="font-term text-[13px] text-muted">{b.id}</span>
                <CommitInput className="field" value={b.title} onCommit={(v) => v.trim() && officeActions.updateBoard(b.id, { title: v.trim() })} />
                <Select
                  value={b.status}
                  onChange={(v) => officeActions.updateBoard(b.id, { status: v as BoardStatus })}
                  ariaLabel={`${b.title} status`}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "planned", label: "Planned" },
                    { value: "done", label: "Done" },
                  ]}
                />
                <span className="text-right font-term text-[13px] text-muted">
                  {done}/{tasks.length} done
                </span>
              </div>
            );
          })}
        </div>
      </section>
      <form
        className="flex items-end gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          officeActions.createBoard(title);
          setTitle("");
        }}
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[13px] font-semibold">New board</span>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Phase 7 — Mobile" />
        </label>
        <button className="btn" type="submit" disabled={!title.trim()}>
          Create
        </button>
      </form>
    </div>
  );
}
