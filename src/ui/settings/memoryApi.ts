// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed HTTP helpers and realistic demo fixtures for FTS5 Team Memory (M4.2) & Encrypted Backups (M4.3).

export interface MemoryItem {
  id: string;
  projectId?: string;
  type: string;
  text: string;
  about: string[];
  status: "certified" | "pending" | "rejected";
  conflictId?: string | null;
  conflictText?: string | null;
  promotedToLesson?: boolean;
  createdAt: string;
  certifiedAt?: string | null;
  decayDaysLeft?: number | null;
}

export interface BackupArchive {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  includes: string[];
  encrypted?: boolean;
}

export interface BackupManifestResult {
  ok: boolean;
  integrityCheck: string;
  projects: number;
  users: number;
  evidenceFiles: number;
  feedbackFiles: number;
  memories?: number;
  archiveId: string;
  filename: string;
  message?: string;
}

function authToken(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const tok = authToken();
  return {
    ...(extra ?? {}),
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
  };
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err =
      typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data as T;
}

export function daysUntilDecay(createdAt: string, decayDaysLeft?: number | null): number {
  if (typeof decayDaysLeft === "number" && Number.isFinite(decayDaysLeft)) {
    return Math.max(0, Math.round(decayDaysLeft));
  }
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return 30;
  const ageDays = Math.floor((Date.now() - parsed) / 86_400_000);
  return Math.max(0, 30 - ageDays);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeMemoryRow(raw: Record<string, unknown>): MemoryItem {
  const rawStatus = String(raw.status ?? "pending").toLowerCase();
  const status: MemoryItem["status"] =
    rawStatus === "certified" || rawStatus === "approved"
      ? "certified"
      : rawStatus === "rejected"
        ? "rejected"
        : "pending";
  const about = Array.isArray(raw.about)
    ? raw.about.map(String).filter(Boolean)
    : typeof raw.about === "string" && raw.about.trim()
      ? raw.about.split(/[,\s]+/).filter(Boolean)
      : [];
  return {
    id: String(raw.id ?? ""),
    projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
    type: String(raw.type ?? raw.kind ?? "Lesson"),
    text: String(raw.text ?? raw.body ?? ""),
    about,
    status,
    conflictId: typeof raw.conflictId === "string" ? raw.conflictId : null,
    conflictText: typeof raw.conflictText === "string" ? raw.conflictText : null,
    promotedToLesson: Boolean(raw.promotedToLesson ?? raw.promoted),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    certifiedAt: typeof raw.certifiedAt === "string" ? raw.certifiedAt : null,
    decayDaysLeft: typeof raw.decayDaysLeft === "number" ? raw.decayDaysLeft : null,
  };
}

function normalizeBackupRow(raw: Record<string, unknown>): BackupArchive {
  const filename = String(raw.filename ?? raw.name ?? raw.id ?? "arima-backup.arimabak");
  const id = String(raw.id ?? filename.replace(/\.arimabak$/i, ""));
  const includes = Array.isArray(raw.includes)
    ? raw.includes.map(String)
    : ["arima.db", "vault", "evidence", "feedback"];
  return {
    id,
    filename,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
    includes,
    encrypted: raw.encrypted !== false,
  };
}

// ---------------------------------------------------------------- Live Memory API

export async function fetchProjectMemories(
  projectId: string,
  q: string,
  status: string,
): Promise<{ memories: MemoryItem[]; keepOut?: string[]; extraction?: { enabled: boolean; account: string } }> {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (status && status !== "all") params.set("status", status);
  const qs = params.toString();
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/memory${qs ? `?${qs}` : ""}`, {
    credentials: "same-origin",
    headers: authHeaders(),
  });
  const data = await parseJson<{
    memories?: Record<string, unknown>[];
    keepOut?: string[];
    extraction?: { enabled: boolean; account: string };
  }>(res);
  return {
    memories: Array.isArray(data.memories) ? data.memories.map(normalizeMemoryRow) : [],
    keepOut: data.keepOut,
    extraction: data.extraction,
  };
}

export async function triggerMemoryExtraction(projectId: string): Promise<{ extractedCount?: number; message?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/memory/extract`, {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({}),
  });
  return parseJson<{ extractedCount?: number; message?: string }>(res);
}

export async function certifyMemoryApi(projectId: string, memoryId: string, supersedeConflict: boolean): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(memoryId)}/certify`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ supersedeConflict }),
    },
  );
  await parseJson(res);
}

export async function promoteMemoryApi(projectId: string, memoryId: string): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(memoryId)}/promote`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    },
  );
  await parseJson(res);
}

export async function deleteMemoryApi(projectId: string, memoryId: string): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(memoryId)}`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: authHeaders(),
    },
  );
  await parseJson(res);
}

export async function saveMemorySettingsApi(
  projectId: string,
  payload: { enabled?: boolean; account?: string; keepOut?: string[] },
): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/memory/settings`, {
    method: "PUT",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  await parseJson(res);
}

// ---------------------------------------------------------------- Live Encrypted Backup API

export async function fetchBackupsApi(): Promise<BackupArchive[]> {
  const res = await fetch("/api/backups", {
    credentials: "same-origin",
    headers: authHeaders(),
  });
  const data = await parseJson<{ backups?: Record<string, unknown>[]; items?: Record<string, unknown>[] }>(res);
  const rows = Array.isArray(data.backups) ? data.backups : Array.isArray(data.items) ? data.items : [];
  return rows.map(normalizeBackupRow);
}

export async function createBackupApi(): Promise<BackupArchive> {
  const res = await fetch("/api/backups", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({}),
  });
  const data = await parseJson<{ backup?: Record<string, unknown> } & Record<string, unknown>>(res);
  return normalizeBackupRow((data.backup as Record<string, unknown> | undefined) ?? data);
}

export async function downloadBackupApi(backup: BackupArchive): Promise<void> {
  const res = await fetch(`/api/backups/${encodeURIComponent(backup.id)}/download`, {
    credentials: "same-origin",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: backup.filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function verifyBackupApi(backup: BackupArchive): Promise<BackupManifestResult> {
  const res = await fetch("/api/backups/verify", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: backup.id, filename: backup.filename }),
  });
  const data = await parseJson<Record<string, unknown>>(res);
  const manifest = (data.manifest as Record<string, unknown> | undefined) ?? data;
  const counts = (manifest.counts as Record<string, unknown> | undefined) ?? manifest;
  return {
    ok: data.ok !== false && manifest.ok !== false,
    integrityCheck: String(data.integrityCheck ?? manifest.integrityCheck ?? "ok"),
    projects: Number(counts.projects ?? counts.projectCount ?? 0),
    users: Number(counts.users ?? counts.userCount ?? 0),
    evidenceFiles: Number(counts.evidenceFiles ?? counts.evidence ?? 0),
    feedbackFiles: Number(counts.feedbackFiles ?? counts.feedback ?? 0),
    memories: typeof counts.memories === "number" ? counts.memories : undefined,
    archiveId: backup.id,
    filename: backup.filename,
    message: typeof data.message === "string" ? data.message : undefined,
  };
}

export async function restoreBackupApi(backup: BackupArchive, confirm: string): Promise<{ message?: string }> {
  const res = await fetch("/api/backups/restore", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: backup.id, filename: backup.filename, confirm }),
  });
  return parseJson<{ message?: string }>(res);
}

// ---------------------------------------------------------------- Mock Seed Fixtures (?mock=1)

export function initialMockMemories(): MemoryItem[] {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  return [
    {
      id: "M-42",
      type: "Decision",
      text: "Rate limits live in edge middleware before auth, so anonymous floods never reach Postgres.",
      about: ["middleware.ts", "rate-limit"],
      status: "pending",
      conflictId: "M-17",
      conflictText: "Rate limits run per route handler so each route sets its own budget.",
      promotedToLesson: false,
      createdAt: daysAgo(5),
      certifiedAt: null,
      decayDaysLeft: 25,
    },
    {
      id: "M-41",
      type: "DeadEnd",
      text: "Polling Clerk's session endpoint for sign-out missed revoked sessions; the webhook is the only reliable signal.",
      about: ["app/api/webhooks/clerk/route.ts", "auth"],
      status: "pending",
      conflictId: null,
      conflictText: null,
      promotedToLesson: false,
      createdAt: daysAgo(12),
      certifiedAt: null,
      decayDaysLeft: 18,
    },
    {
      id: "M-44",
      type: "Decision",
      text: "Cap single-file knowledge uploads at 25 MB with 4 MB streaming buffers and preserve GFM tables across chunk boundaries.",
      about: ["src/knowledge/parse.ts", "upload"],
      status: "certified",
      conflictId: null,
      conflictText: null,
      promotedToLesson: false,
      createdAt: daysAgo(1),
      certifiedAt: daysAgo(1),
    },
    {
      id: "M-43",
      type: "Lesson",
      text: "Supabase row-level security must be enabled before seeding, or the seed script writes rows nobody can read back.",
      about: ["supabase/seed.sql", "postgres"],
      status: "certified",
      conflictId: null,
      conflictText: null,
      promotedToLesson: true,
      createdAt: daysAgo(14),
      certifiedAt: daysAgo(13),
    },
    {
      id: "M-17",
      type: "Decision",
      text: "Rate limits run per route handler so each route sets its own budget.",
      about: ["middleware.ts", "routes"],
      status: "certified",
      conflictId: null,
      conflictText: null,
      promotedToLesson: false,
      createdAt: daysAgo(27),
      certifiedAt: daysAgo(26),
    },
  ];
}

export function initialMockBackups(): BackupArchive[] {
  const now = Date.now();
  const fmtIso = (ms: number) => new Date(ms).toISOString();
  const fmtStamp = (ms: number) => fmtIso(ms).slice(0, 19).replaceAll(":", "-");
  return [
    {
      id: "bk-nightly-1",
      filename: `arima-backup-${fmtStamp(now - 6 * 3_600_000)}.arimabak`,
      createdAt: fmtIso(now - 6 * 3_600_000),
      sizeBytes: 2_486_272,
      includes: ["arima.db", "vault", "evidence", "feedback"],
      encrypted: true,
    },
    {
      id: "bk-nightly-2",
      filename: `arima-backup-${fmtStamp(now - 30 * 3_600_000)}.arimabak`,
      createdAt: fmtIso(now - 30 * 3_600_000),
      sizeBytes: 2_314_880,
      includes: ["arima.db", "vault", "evidence", "feedback"],
      encrypted: true,
    },
  ];
}
