// SPDX-License-Identifier: AGPL-3.0-or-later
// Vaulted Tool Connections (GET/POST/DELETE /api/connections) + Owner-only `propose_send` Inbox bridge.

import { useCallback, useEffect, useState } from "react";
import type { VisualDecision } from "../../data/generated";
import { useAuth } from "../../store/auth";
import { useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { Field, SectionTitle } from "../kit";
import { Select } from "../primitives/Select";

export interface VaultedConnection {
  id: string;
  kind: string;
  label: string;
  endpoint: string;
  hasSecret: boolean;
  createdAt: string;
}

const CONNECTION_KINDS = [
  { value: "mcp", label: "MCP Server" },
  { value: "webhook", label: "Webhook / HTTP" },
  { value: "slack", label: "Slack" },
  { value: "email", label: "Email / SMTP" },
  { value: "github", label: "GitHub API" },
  { value: "crm", label: "CRM / Support" },
];

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  let tok = "";
  try {
    tok = sessionStorage.getItem("hq-token") ?? "";
  } catch {
    /* ignore */
  }
  return { ...(extra ?? {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
}

function initialMockConnections(): VaultedConnection[] {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  return [
    {
      id: "slack-releases",
      kind: "slack",
      label: "Slack #releases Bot",
      endpoint: "https://slack.com/api/chat.postMessage",
      hasSecret: true,
      createdAt: daysAgo(9),
    },
    {
      id: "linear-sync",
      kind: "mcp",
      label: "Linear Issue Sync",
      endpoint: "https://mcp.linear.app/sse",
      hasSecret: true,
      createdAt: daysAgo(4),
    },
  ];
}

export function ConnectionsSettings() {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const owner = useAuth((s) => s.role === "owner" || s.status === "none");

  const [connections, setConnections] = useState<VaultedConnection[]>(() =>
    live ? [] : initialMockConnections(),
  );
  const [livePendingSends, setLivePendingSends] = useState<VisualDecision[]>([]);
  const [form, setForm] = useState({ id: "", kind: "mcp", label: "", endpoint: "", secret: "" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLiveConnections = useCallback(async () => {
    if (!live) return;
    setError(null);
    try {
      const res = await fetch("/api/connections", {
        credentials: "same-origin",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        connections?: VaultedConnection[];
        pendingSends?: VisualDecision[];
      };
      if (Array.isArray(data.connections)) setConnections(data.connections);
      if (Array.isArray(data.pendingSends)) setLivePendingSends(data.pendingSends);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [live]);

  useEffect(() => {
    if (live) void loadLiveConnections();
  }, [live, loadLiveConnections]);

  const snapPendingSends =
    (snap?.visualDecisions ?? []).filter((d) => d.status === "open" && d.payload.kind === "send-proposal").length +
    (snap?.actionItems ?? []).filter((i) => i.status === "open" && i.kind === "send").length;
  const pendingSendCount = live ? Math.max(livePendingSends.length, snapPendingSends) : snapPendingSends;

  const cleanId = form.id.trim().toLowerCase();
  const valid = /^[a-z0-9][a-z0-9_-]{0,47}$/.test(cleanId) && form.endpoint.trim().length > 0;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !owner) return;
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const payload = {
        id: cleanId,
        kind: form.kind,
        label: form.label.trim() || cleanId,
        endpoint: form.endpoint.trim(),
        ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
      };
      if (live) {
        const res = await fetch("/api/connections", {
          method: "POST",
          credentials: "same-origin",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        await loadLiveConnections();
      } else {
        const next: VaultedConnection = {
          id: payload.id,
          kind: payload.kind,
          label: payload.label,
          endpoint: payload.endpoint,
          hasSecret: Boolean(form.secret.trim()),
          createdAt: new Date().toISOString(),
        };
        setConnections((prev) => [next, ...prev.filter((c) => c.id !== next.id)]);
      }
      setForm({ id: "", kind: "mcp", label: "", endpoint: "", secret: "" });
      setStatus(`Saved connection "${payload.label}"${payload.secret ? " with vaulted secret" : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (c: VaultedConnection) => {
    if (!owner) return;
    setError(null);
    setStatus(null);
    try {
      if (live) {
        const res = await fetch(`/api/connections/${encodeURIComponent(c.id)}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: authHeaders(),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        await loadLiveConnections();
      } else {
        setConnections((prev) => prev.filter((x) => x.id !== c.id));
      }
      setStatus(`Removed connection "${c.label}" and purged its vaulted secret.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section
      className="mt-5 flex flex-col gap-3.5 border-t border-[var(--border-hairline)] pt-5"
      aria-label="Tool connections through HQ"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <SectionTitle>Connections through HQ</SectionTitle>
          <p className="m-0 text-[13px] text-muted">
            Secrets stay encrypted inside HQ's vault and are never echoed to agents or the browser. External sends via{" "}
            <code>propose_send</code> always wait for explicit Owner approval in Inbox.
          </p>
        </div>
        <button
          type="button"
          className="btn text-[12px]"
          onClick={() => ui.openActions()}
        >
          <Icon name="inbox" size={16} />
          Pending sends ({pendingSendCount})
        </button>
      </div>

      {!owner && <p className="m-0 text-[13px] text-muted">Only the owner can add or remove vaulted connections.</p>}

      {error && (
        <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
          {error}
        </div>
      )}
      {status && (
        <div
          className="flex items-center justify-between gap-2 rounded-lg border border-green/40 bg-green/10 px-3 py-2 text-[12px] font-medium text-green"
          role="status"
        >
          <span className="flex items-center gap-1.5">
            <Icon name="check_circle" size={15} />
            {status}
          </span>
          <button
            type="button"
            className="cursor-pointer text-[12px] text-muted hover:text-ink"
            onClick={() => setStatus(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {connections.length === 0 ? (
        <p className="m-0 rounded-lg border border-[var(--border-hairline)] bg-cream-2/30 px-4 py-4 text-[13px] text-muted">
          No vaulted tool connections configured yet.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Configured tool connections">
          {connections.map((c) => (
            <li
              key={c.id}
              className="panel flex flex-col gap-2 p-3.5 text-[13px] sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-ink">{c.label}</b>
                  <code className="font-term text-[12px] text-muted">{c.id}</code>
                  <span className="chip text-[12px] uppercase">{c.kind}</span>
                  <span
                    className="chip text-[12px]"
                    style={{ ["--c" as string]: c.hasSecret ? "var(--color-green)" : "var(--color-muted)" }}
                  >
                    <Icon name={c.hasSecret ? "lock" : "lock_open"} size={13} />
                    {c.hasSecret ? "Vaulted secret" : "No secret"}
                  </span>
                </div>
                <div className="mt-1 truncate font-term text-[12px] text-muted">{c.endpoint}</div>
              </div>
              {owner && (
                <button
                  type="button"
                  className="btn border-red/30 px-2.5 py-1 text-[12px] text-red"
                  aria-label={`Remove connection ${c.id}`}
                  onClick={() => void handleDelete(c)}
                >
                  <Icon name="delete" size={15} />
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {owner && (
        <form
          className="panel grid grid-cols-1 gap-3 p-4 sm:grid-cols-2"
          onSubmit={(e) => void handleAdd(e)}
          aria-label="Add tool connection"
        >
          <Field label="Connection ID">
            <input
              className="field font-term text-[13px]"
              value={form.id}
              placeholder="slack-ops"
              aria-label="Connection ID"
              onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label="Kind">
            <Select
              value={form.kind}
              aria-label="Connection kind"
              options={CONNECTION_KINDS}
              onChange={(v) => setForm({ ...form, kind: v })}
            />
          </Field>
          <Field label="Label">
            <input
              className="field text-[13px]"
              value={form.label}
              placeholder="Slack Operations Channel"
              aria-label="Connection label"
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </Field>
          <Field label="Endpoint URL">
            <input
              className="field font-term text-[13px]"
              value={form.endpoint}
              placeholder="https://mcp.example.com/sse"
              aria-label="Connection endpoint"
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            />
          </Field>
          <Field label="API Secret (vaulted, optional)" hint="Stored write-only via AES-256-GCM vault; never echoed back.">
            <input
              className="field text-[13px]"
              type="password"
              autoComplete="off"
              value={form.secret}
              placeholder="Bearer token or webhook key"
              aria-label="Connection secret"
              onChange={(e) => setForm({ ...form, secret: e.target.value })}
            />
          </Field>
          <div className="flex items-end justify-end">
            <button className="btn btn-primary text-[13px]" type="submit" disabled={!valid || busy}>
              <Icon name="add_link" size={16} />
              {busy ? "Saving…" : "Add connection"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
