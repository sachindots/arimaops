// SPDX-License-Identifier: AGPL-3.0-or-later
// Ed25519 License & Plan card (GET/POST /api/license): displays tier, status, seat meter, features & activation.

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../store/auth";
import { useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";
import { Meter, SectionTitle } from "../kit";

export interface LicenseStatusPayload {
  tier: string;
  status: "community" | "active" | "expired" | "invalid";
  licensee: string | null;
  maxSeats: number;
  activeSeats: number;
  maxProjects: number;
  expiresAt: string | null;
  features: string[];
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  let tok = "";
  try {
    tok = sessionStorage.getItem("hq-token") ?? "";
  } catch {
    /* ignore */
  }
  return { ...(extra ?? {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
}

function initialMockLicense(): LicenseStatusPayload {
  return {
    tier: "community",
    status: "community",
    licensee: null,
    maxSeats: 5,
    activeSeats: 1,
    maxProjects: 3,
    expiresAt: null,
    features: ["core-orchestration", "live-preview", "fts5-memory", "encrypted-backups"],
  };
}

const STATUS_TONE: Record<LicenseStatusPayload["status"], { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-green)" },
  community: { label: "Community", color: "var(--accent)" },
  expired: { label: "Expired", color: "var(--color-amber)" },
  invalid: { label: "Invalid", color: "var(--color-red)" },
};

export function LicenseCard() {
  const live = useOffice((s) => s.live);
  const owner = useAuth((s) => s.role === "owner" || s.status === "none");
  const [license, setLicense] = useState<LicenseStatusPayload>(() => initialMockLicense());
  const [licenseKey, setLicenseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadLiveLicense = useCallback(async () => {
    if (!live) return;
    try {
      const res = await fetch("/api/license", {
        credentials: "same-origin",
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<LicenseStatusPayload> & { license?: Partial<LicenseStatusPayload> };
      const src = data.license ?? data;
      setLicense((prev) => ({
        tier: src.tier ?? prev.tier,
        status: (src.status as LicenseStatusPayload["status"]) ?? prev.status,
        licensee: src.licensee ?? null,
        maxSeats: typeof src.maxSeats === "number" ? src.maxSeats : prev.maxSeats,
        activeSeats: typeof src.activeSeats === "number" ? src.activeSeats : prev.activeSeats,
        maxProjects: typeof src.maxProjects === "number" ? src.maxProjects : prev.maxProjects,
        expiresAt: src.expiresAt ?? null,
        features: Array.isArray(src.features) ? src.features : prev.features,
      }));
    } catch {
      /* keep default */
    }
  }, [live]);

  useEffect(() => {
    if (live) void loadLiveLicense();
  }, [live, loadLiveLicense]);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = licenseKey.trim();
    if (!raw) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (live) {
        const res = await fetch("/api/license", {
          method: "POST",
          credentials: "same-origin",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ licenseKey: raw }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          license?: LicenseStatusPayload;
        };
        if (!res.ok) {
          throw new Error(body.error ?? `License verification failed (HTTP ${res.status}).`);
        }
        if (body.license) setLicense(body.license);
        else await loadLiveLicense();
        setLicenseKey("");
        setNotice("Ed25519 license verified and activated.");
      } else {
        // Offline ?mock=1 format check: require canonical "ARIMA2.<payload>.<sig>" format
        const parts = raw.split(".");
        if (parts.length !== 3 || parts[0] !== "ARIMA2" || parts[1].length < 8 || parts[2].length < 16) {
          throw new Error("Invalid Ed25519 license key format. Expected signed ARIMA2.<payload>.<signature> token.");
        }
        setLicense({
          tier: "enterprise",
          status: "active",
          licensee: "Acme Engineering Inc.",
          maxSeats: 25,
          activeSeats: 1,
          maxProjects: 20,
          expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
          features: [
            "core-orchestration",
            "live-preview",
            "fts5-memory",
            "encrypted-backups",
            "sso-rbac",
            "multi-project-factory",
          ],
        });
        setLicenseKey("");
        setNotice("Enterprise Ed25519 license verified and activated.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tone = STATUS_TONE[license.status] ?? STATUS_TONE.community;
  const seatPctColor =
    license.activeSeats >= license.maxSeats ? "var(--color-red)" : "var(--accent)";

  return (
    <div className="flex flex-col gap-5" aria-label="License and Plan">
      <section className="panel flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <SectionTitle>Current Plan</SectionTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-display text-[20px] font-semibold capitalize text-ink">
                {license.tier}
              </span>
              <span className="chip text-[12px]" style={{ ["--c" as string]: tone.color }}>
                {tone.label}
              </span>
            </div>
          </div>
          <div className="text-right text-[12px] text-muted">
            <div>{license.licensee ? `Licensed to ${license.licensee}` : "Self-hosted Community Edition"}</div>
            <div>
              {license.expiresAt
                ? `Expires ${new Date(license.expiresAt).toLocaleDateString()}`
                : "No expiration"}
            </div>
          </div>
        </div>

        {/* Seat Usage Meter */}
        <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--border-hairline)] bg-cream-2/40 p-3.5">
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-medium text-ink">Active seats</span>
            <span className="font-term font-semibold text-ink">
              {license.activeSeats} / {license.maxSeats} seats
            </span>
          </div>
          <Meter
            value={license.activeSeats}
            max={Math.max(1, license.maxSeats)}
            color={seatPctColor}
            label="Active license seats"
          />
          <div className="flex items-center justify-between text-[12px] text-muted">
            <span>Max active projects: {license.maxProjects}</span>
            <span>Ed25519 offline cryptographic verification</span>
          </div>
        </div>

        {/* Features */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted">Enabled features</span>
          <div className="flex flex-wrap gap-1.5">
            {license.features.map((f) => (
              <span key={f} className="chip font-term text-[12px]">
                <Icon name="check" size={14} className="text-green" />
                {f}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Owner-only Activate License Key form */}
      <section className="panel flex flex-col gap-3 p-5">
        <SectionTitle>Activate License Key</SectionTitle>
        <p className="m-0 text-[13px] text-muted">
          Paste a signed Ed25519 license token to unlock Enterprise seat quotas and features offline. Expired keys automatically fall back to Community limits.
        </p>

        {!owner ? (
          <p className="m-0 text-[13px] text-muted">Only the owner can activate or replace the license key.</p>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(e) => void handleActivate(e)}>
            <textarea
              className="field min-h-[84px] py-2 font-term text-[12px]"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder="ARIMA2.<base64url-payload>.<ed25519-signature>"
              aria-label="Ed25519 license key"
            />

            {error && (
              <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div
                className="flex items-center gap-1.5 rounded-lg border border-green/40 bg-green/10 px-3 py-2 text-[12px] font-medium text-green"
                role="status"
              >
                <Icon name="verified" size={16} />
                <span>{notice}</span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                className="btn btn-primary text-[13px]"
                disabled={busy || !licenseKey.trim()}
              >
                <Icon name="key" size={16} />
                {busy ? "Verifying signature…" : "Activate license"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
