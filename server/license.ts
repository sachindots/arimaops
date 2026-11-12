// SPDX-License-Identifier: AGPL-3.0-or-later
// The licence file (docs/core-model.md section 10): ~/.arima/license.json, a payload signed with
// Ed25519, checked offline against the public key built into the release. No network call, so it
// works on air-gapped installs. Features in ee/ run only for a valid licence that lists them.

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LICENSE_PUBLIC_KEY } from "./licenseKey";
import { homeRoot } from "./paths";

export const TIERS = ["pro", "security"] as const;

export interface LicensePayload {
  licensee: string;
  tier: (typeof TIERS)[number];
  seats: number;
  features: string[];
  issued: string; // ISO date
  expires: string; // ISO date
}

/** What license.json holds: the payload as base64url JSON, and its signature. */
export interface LicenseFile {
  payload: string;
  signature: string;
}

export type LicenseCheck = { ok: true; license: LicensePayload } | { ok: false; why: string };

const b64 = (b: Buffer) => b.toString("base64url");

export function signLicense(payload: LicensePayload, privateKeyPem: string): LicenseFile {
  const data = Buffer.from(JSON.stringify(payload));
  return { payload: b64(data), signature: b64(sign(null, data, createPrivateKey(privateKeyPem))) };
}

function payloadOf(raw: unknown): LicensePayload | null {
  const p = raw as Partial<LicensePayload>;
  const date = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
  const ok =
    typeof p?.licensee === "string" && p.licensee.trim() !== "" &&
    (TIERS as readonly unknown[]).includes(p.tier) &&
    Number.isInteger(p.seats) && (p.seats as number) > 0 &&
    Array.isArray(p.features) && p.features.every((f) => typeof f === "string") &&
    date(p.issued) && date(p.expires);
  return ok ? (p as LicensePayload) : null;
}

/** Checks a licence file's signature, shape and dates. Every failure says why, for Settings to show. */
export function verifyLicense(file: unknown, publicKeyPem: string | null = LICENSE_PUBLIC_KEY, now = Date.now()): LicenseCheck {
  if (!publicKeyPem) return { ok: false, why: "This build has no licence key." };
  const f = file as Partial<LicenseFile>;
  if (typeof f?.payload !== "string" || typeof f.signature !== "string") return { ok: false, why: "The licence file is not in the right format." };
  const data = Buffer.from(f.payload, "base64url");
  let signed = false;
  try {
    signed = verify(null, data, createPublicKey(publicKeyPem), Buffer.from(f.signature, "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, why: "The licence signature doesn't match. The file was changed or isn't an ArimaOps licence." };
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    return { ok: false, why: "The licence payload is unreadable." };
  }
  const license = payloadOf(raw);
  if (!license) return { ok: false, why: "The licence payload is missing fields." };
  if (Date.parse(license.issued) > now) return { ok: false, why: `The licence starts on ${license.issued.slice(0, 10)}.` };
  if (Date.parse(license.expires) <= now) return { ok: false, why: `The licence expired on ${license.expires.slice(0, 10)}.` };
  return { ok: true, license };
}

export const licensePath = () => join(homeRoot(), "license.json");

/** The machine's licence, checked. No file is not an error: the core runs fully without one. */
export function readLicense(file = licensePath(), publicKeyPem = LICENSE_PUBLIC_KEY): LicenseCheck {
  if (!existsSync(file)) return { ok: false, why: "No licence file." };
  try {
    return verifyLicense(JSON.parse(readFileSync(file, "utf8")), publicKeyPem);
  } catch {
    return { ok: false, why: "The licence file is not valid JSON." };
  }
}
