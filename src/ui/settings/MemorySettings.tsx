// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";
import { Field, SectionTitle } from "../kit";
import { Select } from "../primitives/Select";
import {
  certifyMemoryApi,
  createBackupApi,
  daysUntilDecay,
  deleteMemoryApi,
  downloadBackupApi,
  fetchBackupsApi,
  fetchProjectMemories,
  formatBytes,
  initialMockBackups,
  initialMockMemories,
  promoteMemoryApi,
  restoreBackupApi,
  saveMemorySettingsApi,
  triggerMemoryExtraction,
  verifyBackupApi,
  type BackupArchive,
  type BackupManifestResult,
  type MemoryItem,
} from "./memoryApi";

const LESSON_LABEL: Record<string, string> = {
  Lesson: "Lesson",
  Decision: "Decision",
  DeadEnd: "Dead end",
  Fact: "Fact",
};

/** FTS5 Team Memory Explorer, Extraction, Lessons, Keep-Out, and AES-256-GCM Encrypted Backups & Restore. */
export function MemorySettings() {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const state = snap?.memory;
  const projectId = snap?.config.project.id ?? "";
  const keys = (snap?.accounts?.list ?? []).filter((a) => a.provider === "anthropic");
  const [name, setName] = useState("");

  // Team Memory Explorer state
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "certified" | "pending">("all");
  const [memories, setMemories] = useState<MemoryItem[]>(() => (live ? [] : initialMockMemories()));
  const [memLoading, setMemLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [memStatus, setMemStatus] = useState<string | null>(null);
  const [memError, setMemError] = useState<string | null>(null);

  // Encrypted Backup & Restore state
  const [backups, setBackups] = useState<BackupArchive[]>(() => (live ? [] : initialMockBackups()));
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [verifiedManifest, setVerifiedManifest] = useState<BackupManifestResult | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupArchive | null>(null);

  const loadLiveMemories = useCallback(async () => {
    if (!live || !projectId) return;
    setMemLoading(true);
    setMemError(null);
    try {
      const res = await fetchProjectMemories(projectId, query, statusFilter);
      setMemories(res.memories);
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemLoading(false);
    }
  }, [live, projectId, query, statusFilter]);

  useEffect(() => {
    if (!live || !projectId) return;
    const t = window.setTimeout(() => void loadLiveMemories(), 140);
    return () => window.clearTimeout(t);
  }, [live, projectId, loadLiveMemories]);

  const loadLiveBackups = useCallback(async () => {
    if (!live) return;
    try {
      const list = await fetchBackupsApi();
      setBackups(list);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err));
    }
  }, [live]);

  useEffect(() => {
    if (live) void loadLiveBackups();
  }, [live, loadLiveBackups]);

  const visibleMemories = useMemo(() => {
    if (live) return memories;
    const tokens = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return memories.filter((m) => {
      if (statusFilter === "certified" && m.status !== "certified") return false;
      if (statusFilter === "pending" && m.status !== "pending") return false;
      if (!tokens.length) return true;
      const hay = `${m.id} ${m.type} ${m.text} ${m.about.join(" ")}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }, [live, memories, query, statusFilter]);

  if (!state) return <p className="m-0 text-[13px] text-muted">Memory settings aren't available from this server.</p>;

  // ---- Memory actions ----
  const handleRunExtraction = async () => {
    setMemError(null);
    setMemStatus(null);
    setExtracting(true);
    try {
      if (live && projectId) {
        const res = await triggerMemoryExtraction(projectId);
        await loadLiveMemories();
        setMemStatus(
          res.message ??
            `Extraction complete${typeof res.extractedCount === "number" ? ` (${res.extractedCount} proposed)` : ""}.`,
        );
      } else {
        const nextId = `M-${45 + memories.length}`;
        const fresh: MemoryItem = {
          id: nextId,
          type: "Lesson",
          text: "Validate resolved target IPs against private and link-local CIDR blocks before forwarding webhook previews.",
          about: ["src/webhooks/preview.ts", "security"],
          status: "pending",
          conflictId: null,
          conflictText: null,
          promotedToLesson: false,
          createdAt: new Date().toISOString(),
          certifiedAt: null,
          decayDaysLeft: 30,
        };
        setMemories((prev) => [fresh, ...prev]);
        setMemStatus(`Extracted 1 new memory (${nextId}) for review.`);
      }
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  const handleCertify = async (m: MemoryItem) => {
    setMemError(null);
    try {
      if (live && projectId) {
        await certifyMemoryApi(projectId, m.id, Boolean(m.conflictId));
        await loadLiveMemories();
      } else {
        setMemories((prev) =>
          prev
            .filter((x) => !m.conflictId || x.id !== m.conflictId)
            .map((x) =>
              x.id === m.id
                ? { ...x, status: "certified", conflictId: null, conflictText: null, certifiedAt: new Date().toISOString() }
                : x,
            ),
        );
      }
      setMemStatus(
        m.conflictId
          ? `Certified ${m.id} and superseded conflicting memory ${m.conflictId}.`
          : `Certified ${m.id} into team memory.`,
      );
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePromote = async (m: MemoryItem) => {
    setMemError(null);
    try {
      if (live && projectId) {
        await promoteMemoryApi(projectId, m.id);
        await loadLiveMemories();
      } else {
        setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, promotedToLesson: true, status: "certified" } : x)));
      }
      setMemStatus(`Promoted ${m.id} to template lessons.`);
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteMemory = async (m: MemoryItem) => {
    setMemError(null);
    try {
      if (live && projectId) {
        await deleteMemoryApi(projectId, m.id);
        await loadLiveMemories();
      } else {
        setMemories((prev) => prev.filter((x) => x.id !== m.id));
      }
      setMemStatus(`Deleted memory ${m.id}.`);
    } catch (err) {
      setMemError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- Backup actions ----
  const handleCreateBackup = async () => {
    setBackupError(null);
    setBackupNotice(null);
    setBackupBusy("create");
    try {
      if (live) {
        const created = await createBackupApi();
        setBackups((prev) => [created, ...prev.filter((b) => b.id !== created.id)]);
        setBackupNotice(`Created encrypted archive ${created.filename}.`);
      } else {
        const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
        const created: BackupArchive = {
          id: `bk-${Date.now()}`,
          filename: `arima-backup-${stamp}.arimabak`,
          createdAt: new Date().toISOString(),
          sizeBytes: 2_621_440 + Math.floor(Math.random() * 120_000),
          includes: ["arima.db", "vault", "evidence", "feedback"],
          encrypted: true,
        };
        setBackups((prev) => [created, ...prev]);
        setBackupNotice(`Created encrypted archive ${created.filename} (AES-256-GCM).`);
      }
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackupBusy(null);
    }
  };

  const handleDownloadBackup = async (b: BackupArchive) => {
    setBackupError(null);
    try {
      if (live) {
        await downloadBackupApi(b);
      } else {
        const stub = new Blob([`ARIMABK2\narchive=${b.filename}\nencrypted=AES-256-GCM\n`], {
          type: "application/octet-stream",
        });
        const url = URL.createObjectURL(stub);
        Object.assign(document.createElement("a"), { href: url, download: b.filename }).click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setBackupNotice(`Downloaded ${b.filename}.`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVerifyBackup = async (b: BackupArchive) => {
    setBackupError(null);
    setBackupBusy(`verify:${b.id}`);
    try {
      if (live) {
        const manifest = await verifyBackupApi(b);
        setVerifiedManifest(manifest);
      } else {
        setVerifiedManifest({
          ok: true,
          integrityCheck: "ok",
          projects: 1,
          users: 3,
          evidenceFiles: 4,
          feedbackFiles: Math.max(1, snap?.visualFeedback?.length ?? 1),
          memories: memories.length,
          archiveId: b.id,
          filename: b.filename,
        });
      }
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackupBusy(null);
    }
  };

  const handleRestoreBackup = async (b: BackupArchive) => {
    setBackupError(null);
    setBackupNotice(null);
    setBackupBusy(`restore:${b.id}`);
    try {
      if (live) {
        const res = await restoreBackupApi(b, "RESTORE");
        setBackupNotice(res.message ?? `Restored ${b.filename} cleanly (pre-restore snapshot saved).`);
        await loadLiveBackups();
      } else {
        setBackupNotice(`Pre-restore safety snapshot saved; restored ${b.filename} cleanly.`);
      }
      setRestoreTarget(null);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackupBusy(null);
    }
  };

  const pendingCount = memories.filter((m) => m.status === "pending").length;

  return (
    <div className="flex flex-col gap-6">
      {/* 1. SQLite FTS5 Team Memory Explorer */}
      <section className="panel flex flex-col gap-3.5 p-4 sm:p-5" aria-label="Team Memory Explorer">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <SectionTitle>Team Memory Explorer · FTS5</SectionTitle>
            <p className="m-0 text-[12px] text-muted">
              Full-text indexed decisions, lessons, and dead ends. Uncertified items decay after 30 days; contradictions are flagged before certification.
            </p>
          </div>
          {!isViewer && (
            <button
              type="button"
              className="btn text-[12px]"
              disabled={extracting}
              onClick={() => void handleRunExtraction()}
            >
              <Icon name="auto_awesome" size={16} />
              {extracting ? "Extracting…" : "Run extraction"}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <input
              className="field text-[13px]"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search decisions, lessons, files, or topics…"
              aria-label="Search team memory"
            />
          </div>
          <Select
            className="w-auto min-w-[160px]"
            size="sm"
            value={statusFilter}
            aria-label="Memory status filter"
            options={[
              { value: "all", label: `All (${memories.length})` },
              { value: "certified", label: `Certified (${memories.filter((m) => m.status === "certified").length})` },
              { value: "pending", label: `Pending review (${pendingCount})` },
            ]}
            onChange={(v) => setStatusFilter(v as "all" | "certified" | "pending")}
          />
        </div>

        {memError && (
          <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
            {memError}
          </div>
        )}
        {memStatus && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-green/40 bg-green/10 px-3 py-2 text-[12px] font-medium text-green" role="status">
            <span className="flex items-center gap-1.5">
              <Icon name="check_circle" size={15} />
              {memStatus}
            </span>
            <button type="button" className="cursor-pointer text-[12px] text-muted hover:text-ink" onClick={() => setMemStatus(null)}>
              Dismiss
            </button>
          </div>
        )}

        {memLoading ? (
          <p className="m-0 py-3 text-[13px] text-muted">Searching memory index…</p>
        ) : visibleMemories.length === 0 ? (
          <p className="m-0 rounded-lg border border-[var(--border-hairline)] bg-cream-2/30 px-4 py-6 text-center text-[13px] text-muted">
            No matching memories. Try another query or run extraction on recent work.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Memory entries">
            {visibleMemories.map((m) => {
              const decayLeft = m.status === "pending" ? daysUntilDecay(m.createdAt, m.decayDaysLeft) : null;
              return (
                <li
                  key={m.id}
                  className="flex flex-col gap-2 rounded-xl border border-[var(--border-hairline)] bg-cream-2/40 p-3.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-term text-[12px] font-semibold text-muted">{m.id}</span>
                    <span className="chip text-[12px]">{LESSON_LABEL[m.type] ?? m.type}</span>
                    <span
                      className="chip text-[12px]"
                      style={{
                        ["--c" as string]: m.status === "certified" ? "var(--color-green)" : "var(--color-amber)",
                      }}
                    >
                      {m.status === "certified" ? "Certified" : "Pending review"}
                    </span>
                    {m.promotedToLesson && (
                      <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--accent)" }}>
                        Promoted lesson
                      </span>
                    )}
                    {m.conflictId && (
                      <span
                        className="chip text-[12px] font-semibold"
                        style={{ ["--c" as string]: "var(--color-red)" }}
                        title={m.conflictText ?? `Conflicts with certified memory ${m.conflictId}`}
                      >
                        <Icon name="warning" size={14} /> Contradicts {m.conflictId}
                      </span>
                    )}
                    {decayLeft !== null && (
                      <span
                        className="chip ml-auto text-[12px]"
                        style={{ ["--c" as string]: decayLeft <= 7 ? "var(--color-red)" : "var(--color-amber)" }}
                        title="Uncertified memories decay automatically after 30 days"
                      >
                        Decays in {decayLeft}d
                      </span>
                    )}
                  </div>

                  <p className="m-0 text-[13px] leading-relaxed text-ink">{m.text}</p>

                  {m.conflictId && m.conflictText && (
                    <div className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-1.5 text-[12px] text-ink">
                      <span className="font-semibold">Conflicts with {m.conflictId}:</span> {m.conflictText}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {m.about.map((tag) => (
                        <code
                          key={tag}
                          className="rounded-md border border-[var(--border-hairline)] bg-[var(--surface-card)] px-1.5 py-0.5 font-term text-[12px] text-muted"
                        >
                          {tag}
                        </code>
                      ))}
                    </div>

                    {!isViewer && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {m.status !== "certified" && (
                          <button
                            type="button"
                            className="btn border-green/40 px-2.5 py-1 text-[12px] text-green"
                            onClick={() => void handleCertify(m)}
                          >
                            <Icon name="verified" size={15} />
                            Certify
                          </button>
                        )}
                        {!m.promotedToLesson && (
                          <button
                            type="button"
                            className="btn px-2.5 py-1 text-[12px]"
                            onClick={() => void handlePromote(m)}
                          >
                            <Icon name="school" size={15} />
                            Promote to Lesson
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn border-red/30 px-2.5 py-1 text-[12px] text-red"
                          onClick={() => void handleDeleteMemory(m)}
                          aria-label={`Delete memory ${m.id}`}
                        >
                          <Icon name="delete" size={15} />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 2. Encrypted Backup & Restore Card (M4.3) */}
      <section className="panel flex flex-col gap-3.5 p-4 sm:p-5" aria-label="Encrypted Backups and Restore">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <SectionTitle>Encrypted Backups &amp; Restore</SectionTitle>
              <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--color-green)" }}>
                <Icon name="lock" size={14} /> AES-256-GCM
              </span>
            </div>
            <p className="m-0 text-[12px] text-muted">
              Authenticated encrypted snapshots bundling SQLite <code>arima.db</code>, encrypted vault metadata, verifier evidence, and visual feedback archives.
            </p>
          </div>
          {!isViewer && (
            <button
              type="button"
              className="btn btn-primary text-[13px]"
              disabled={backupBusy === "create"}
              onClick={() => void handleCreateBackup()}
            >
              <Icon name="backup" size={16} />
              {backupBusy === "create" ? "Encrypting…" : "Create encrypted backup"}
            </button>
          )}
        </div>

        {backupError && (
          <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
            {backupError}
          </div>
        )}
        {backupNotice && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-green/40 bg-green/10 px-3 py-2 text-[12px] font-medium text-green" role="status">
            <span className="flex items-center gap-1.5">
              <Icon name="check_circle" size={16} />
              {backupNotice}
            </span>
            <button type="button" className="cursor-pointer text-[12px] text-muted hover:text-ink" onClick={() => setBackupNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        {verifiedManifest && (
          <div
            className="flex flex-col gap-2 rounded-xl border border-green/40 bg-green/10 p-3.5 text-[12px]"
            role="status"
            aria-label="Verified backup manifest"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-semibold text-ink">
                <Icon name="verified_user" size={16} className="text-green" />
                Archive Verified · Integrity {verifiedManifest.ok ? "OK" : "FAILED"} ({verifiedManifest.filename})
              </span>
              <button
                type="button"
                className="cursor-pointer text-[12px] text-muted hover:text-ink"
                onClick={() => setVerifiedManifest(null)}
              >
                Dismiss
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--color-green)" }}>
                Integrity: {verifiedManifest.integrityCheck}
              </span>
              <span className="chip text-[12px]">{verifiedManifest.projects} project{verifiedManifest.projects === 1 ? "" : "s"}</span>
              <span className="chip text-[12px]">{verifiedManifest.users} user{verifiedManifest.users === 1 ? "" : "s"}</span>
              <span className="chip text-[12px]">{verifiedManifest.evidenceFiles} evidence files</span>
              <span className="chip text-[12px]">{verifiedManifest.feedbackFiles} feedback files</span>
            </div>
          </div>
        )}

        {backups.length === 0 ? (
          <p className="m-0 rounded-lg border border-[var(--border-hairline)] bg-cream-2/30 px-4 py-5 text-center text-[13px] text-muted">
            No encrypted backups yet. Create one above or wait for the nightly 03:00 schedule.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Encrypted backup archives">
            {backups.map((b) => (
              <li
                key={b.id}
                className="flex flex-col gap-2 rounded-xl border border-[var(--border-hairline)] bg-cream-2/35 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="truncate font-term text-[13px] font-semibold text-ink">{b.filename}</code>
                    <span className="text-[12px] text-muted">{formatBytes(b.sizeBytes)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                    <span>{new Date(b.createdAt).toLocaleString()}</span>
                    {b.includes.map((inc) => (
                      <span key={inc} className="rounded bg-[var(--surface-card)] px-1.5 py-px font-term text-[12px] text-muted">
                        {inc}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="btn px-2.5 py-1 text-[12px]"
                    onClick={() => void handleDownloadBackup(b)}
                  >
                    <Icon name="download" size={15} />
                    Download
                  </button>
                  <button
                    type="button"
                    className="btn px-2.5 py-1 text-[12px]"
                    disabled={backupBusy === `verify:${b.id}`}
                    onClick={() => void handleVerifyBackup(b)}
                  >
                    <Icon name="verified_user" size={15} />
                    {backupBusy === `verify:${b.id}` ? "Verifying…" : "Verify archive"}
                  </button>
                  {!isViewer && (
                    <button
                      type="button"
                      className="btn border-amber/40 px-2.5 py-1 text-[12px] text-amber"
                      disabled={backupBusy === `restore:${b.id}`}
                      onClick={() => setRestoreTarget(b)}
                    >
                      <Icon name="restore" size={15} />
                      Restore backup
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Extraction Configuration */}
      <section className="flex max-w-[560px] flex-col gap-2">
        <SectionTitle>Extraction</SectionTitle>
        <p className="m-0 text-[13px] text-muted">
          When a task finishes, native memory extraction reads its summary and proposes decisions, lessons, and dead ends for review.
        </p>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={state.extraction.enabled}
            disabled={isViewer}
            onChange={(e) => {
              const enabled = e.target.checked;
              officeActions.setMemoryExtraction({ ...state.extraction, enabled });
              if (live && projectId) void saveMemorySettingsApi(projectId, { enabled, account: state.extraction.account }).catch(() => {});
            }}
          />
          Extract memories from finished tasks
        </label>
        <Field label="Account">
          <Select
            value={state.extraction.account}
            disabled={isViewer}
            aria-label="Memory extraction account"
            options={[
              { value: "default", label: "Claude Code sign-in (claude -p)" },
              ...keys.map((a) => ({ value: a.id, label: `${a.id} (Anthropic API key)` })),
            ]}
            onChange={(v) => {
              officeActions.setMemoryExtraction({ ...state.extraction, account: v });
              if (live && projectId) void saveMemorySettingsApi(projectId, { enabled: state.extraction.enabled, account: v }).catch(() => {});
            }}
          />
        </Field>
      </section>

      <LessonsSection extractionOn={state.extraction.enabled} />

      {/* 4. Keep Out List */}
      <section className="flex max-w-[560px] flex-col gap-2">
        <SectionTitle>Keep out of memory</SectionTitle>
        <p className="m-0 text-[13px] text-muted">
          People's names and handles this project's memory never keeps. Emails, phone numbers, and secrets are always stripped.
        </p>
        {state.keepOut.length > 0 && (
          <p className="m-0 flex flex-wrap gap-1.5">
            {state.keepOut.map((n) => (
              <span key={n} className="chip text-[12px]">
                {n}
              </span>
            ))}
          </p>
        )}
        {!isViewer && (
          <div className="flex gap-2">
            <input
              className="field min-w-0 flex-1"
              value={name}
              placeholder="A name or handle"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={name.trim().length < 2}
              onClick={() => {
                const clean = name.trim();
                officeActions.keepOutOfMemory(clean);
                if (live && projectId) {
                  void saveMemorySettingsApi(projectId, { keepOut: [...state.keepOut, clean] }).catch(() => {});
                }
                setName("");
              }}
            >
              Keep out
            </button>
          </div>
        )}
      </section>

      {restoreTarget && (
        <RestoreConfirmModal
          backup={restoreTarget}
          busy={backupBusy === `restore:${restoreTarget.id}`}
          onClose={() => setRestoreTarget(null)}
          onConfirm={() => void handleRestoreBackup(restoreTarget)}
        />
      )}
    </div>
  );
}

function RestoreConfirmModal({
  backup,
  busy,
  onClose,
  onConfirm,
}: {
  backup: BackupArchive;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const unlocked = confirmText.trim() === "RESTORE";

  return createPortal(
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      data-restore-modal="true"
      aria-label="Confirm encrypted backup restore"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="hud-drawer flex w-full max-w-[460px] flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)]">
        <header className="flex items-center justify-between border-b border-[var(--border-hairline)] bg-cream-2/50 px-5 py-3.5">
          <h2 className="m-0 text-[15px] font-semibold text-ink">Restore Encrypted Backup</h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-cream-2 hover:text-ink"
            aria-label="Close restore dialog"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="flex flex-col gap-3 p-5 text-[13px]">
          <p className="m-0 text-muted">
            Restoring <code className="font-term text-ink">{backup.filename}</code> verifies the encrypted archive, saves an automatic pre-restore safety snapshot, and atomically replaces the database, vault, evidence, and feedback directories.
          </p>
          <label className="flex flex-col gap-1.5 text-[12px] font-medium text-ink">
            Type <code>RESTORE</code> to confirm
            <input
              className="field font-term text-[13px]"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="RESTORE"
              aria-label="Type RESTORE to confirm"
              autoFocus
            />
          </label>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-5 py-3">
          <button type="button" className="btn text-[13px]" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn border-red/50 bg-red/15 text-[13px] font-semibold text-red"
            disabled={!unlocked || busy}
            onClick={onConfirm}
          >
            {busy ? "Restoring…" : "Confirm Restore"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Certified lessons offered to the project's template, and the ones already in it. */
function LessonsSection({ extractionOn }: { extractionOn: boolean }) {
  const lessons = useOffice((s) => s.snap?.lessons);
  const security = useOffice((s) => !!s.snap?.config.rules?.findings);
  if (!lessons?.templateId) return null;
  return (
    <section className="flex max-w-[560px] flex-col gap-2">
      <SectionTitle>Lessons for the template</SectionTitle>
      <p className="m-0 text-[13px] text-muted">
        Certified lessons, decisions and dead ends from this project, offered to its template (<b className="text-ink">{lessons.templateId}</b>) so new
        projects from it start with them in their briefs.
        {security && " Off by default here: a lesson from one engagement must never reach the next client's brief."}
      </p>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={lessons.enabled} disabled={isViewer} onChange={(e) => officeActions.setLessonPromotion(e.target.checked)} />
        Allow this project's lessons into its template
      </label>
      {!isViewer && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn px-3 text-[12px]" disabled={!lessons.enabled || !extractionOn || lessons.running} onClick={() => officeActions.promoteLessons()}>
            {lessons.running ? "Rewriting…" : "Offer lessons now"}
          </button>
          {!extractionOn && <span className="text-[12px] text-muted">Needs extraction on.</span>}
          {lessons.pending > 0 && <span className="text-[12px] text-muted">{lessons.pending} waiting for you in the Inbox</span>}
        </div>
      )}
      {lessons.last && <p className="m-0 text-[12px] text-muted" role="status">{lessons.last}</p>}
      {lessons.approved.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {lessons.approved.map((l) => (
            <li key={l.id} className="flex items-start gap-2 rounded-lg border border-[var(--border-hairline)] bg-cream-2/40 px-2.5 py-2 text-[13px]">
              <span className="chip shrink-0 text-[12px]">{LESSON_LABEL[l.type] ?? l.type}</span>
              <span className="min-w-0 flex-1 text-ink">{l.text}</span>
              {!isViewer && (
                <button type="button" className="btn shrink-0 px-2 text-[12px]" onClick={() => officeActions.removeLesson(l.id)} aria-label={`Remove lesson: ${l.text.slice(0, 40)}`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
