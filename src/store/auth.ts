// Who is signed in on this device. Asks the server once at start; drives the
// sign-in screen, the owner prompt and the Users page. The server checks every
// command itself; this only decides what to show.

import { create } from "zustand";
import type { DeviceSession, PasskeyInfo, ProjectRole } from "../data/generated";

export type AuthRole = "owner" | "operator" | "viewer";

interface AuthState {
  /** checking: asking the server. signed-in / signed-out: a real HQ answered. none: no HQ (the demo). */
  status: "checking" | "signed-in" | "signed-out" | "none";
  role: AuthRole | null;
  user: { id: string; name: string } | null;
  /** People with a sign-in on this install (0: nobody yet; the start-up link is the owner). */
  people: number;
  /** True when the current origin supports WebAuthn passkeys (localhost or HTTPS domain). */
  passkeysAvailable: boolean;
}

export const useAuth = create<AuthState>(() => ({
  status: "checking",
  role: null,
  user: null,
  people: 0,
  passkeysAvailable: false,
}));

const store = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

const linkToken = () => {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
};

export function markSignedOut() {
  store("hq-live", null);
  store("hq-role", null);
  try {
    sessionStorage.removeItem("hq-token");
    sessionStorage.removeItem("hq-role");
  } catch {
    /* private mode */
  }
  useAuth.setState((s) => ({ ...s, status: "signed-out", role: null, user: null }));
}

export async function checkAuth() {
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1") {
      return useAuth.setState({ status: "none", passkeysAvailable: false });
    }
    const tok = linkToken();
    const res = await fetch(`/api/auth/me${tok ? `?token=${encodeURIComponent(tok)}` : ""}`, { credentials: "same-origin" });
    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { people?: number; passkeysAvailable?: boolean };
      return useAuth.setState({
        status: "signed-out",
        role: null,
        user: null,
        people: body.people ?? 0,
        passkeysAvailable: Boolean(body.passkeysAvailable),
      });
    }
    if (!res.ok) return useAuth.setState({ status: "none", passkeysAvailable: false });
    const me = (await res.json()) as {
      role: AuthRole;
      user: { id: string; name: string } | null;
      people: number;
      passkeysAvailable?: boolean;
    };
    const was = useAuth.getState().status;
    useAuth.setState({
      status: "signed-in",
      role: me.role,
      user: me.user,
      people: me.people,
      passkeysAvailable: Boolean(me.passkeysAvailable),
    });
    if (was !== "signed-in") window.dispatchEvent(new Event("arima:signed-in"));
    // The rest of the UI reads the role at load (session first, then saved). The server's answer wins:
    // a viewer link must never show owner controls, so a mismatch is stored everywhere and the page reloads once.
    const read = (k: "sessionStorage" | "localStorage") => {
      try {
        return window[k].getItem("hq-role");
      } catch {
        return null;
      }
    };
    const shownViewer = (read("sessionStorage") ?? read("localStorage")) === "viewer";
    const now = me.role === "viewer" ? "viewer" : "operator";
    if (read("localStorage") !== now) store("hq-role", now);
    if (read("sessionStorage") !== null && read("sessionStorage") !== now) {
      try {
        sessionStorage.setItem("hq-role", now);
      } catch {
        /* private mode */
      }
    }
    if (shownViewer !== (now === "viewer")) location.reload();
  } catch {
    useAuth.setState({ status: "none", passkeysAvailable: false }); // no HQ server: the demo
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function signIn(name: string, password: string): Promise<string | null> {
  try {
    const r = await post("/api/auth/login", { name, password });
    if (!r.ok) return String(r.data.error ?? "Couldn't sign in.");
    store("hq-live", "1");
    location.reload();
    return null;
  } catch {
    return "Could not reach HQ. Check your connection and try again.";
  }
}

export async function signInWithToken(token: string): Promise<string | null> {
  const clean = token.trim();
  if (!clean) return "Enter a start-up token.";
  try {
    const r = await post("/api/login", { token: clean });
    if (!r.ok) return String(r.data.error ?? "Invalid start-up token.");
    store("hq-live", "1");
    try {
      sessionStorage.removeItem("hq-token");
    } catch {
      /* private mode */
    }
    location.reload();
    return null;
  } catch {
    return "Could not reach HQ. Check your connection and try again.";
  }
}

export async function signOut() {
  await post("/api/auth/logout", {}).catch(() => {});
  store("hq-live", null);
  store("hq-role", null);
  try {
    sessionStorage.removeItem("hq-token");
    sessionStorage.removeItem("hq-role");
  } catch {
    /* private mode */
  }
  location.reload();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<string | null> {
  try {
    const result = await post("/api/auth/password", { currentPassword, newPassword });
    if (!result.ok) return String(result.data.error ?? "Could not change your password.");
    location.reload();
    return null;
  } catch {
    return "Could not reach HQ. Check your connection and try again.";
  }
}

/** The owner's people API. Throws the server's message on failure. */
export async function usersApi<T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH" | "DELETE", path = "", body?: unknown): Promise<T> {
  const tok = linkToken();
  const res = await fetch(`/api/users${path}${tok ? `?token=${encodeURIComponent(tok)}` : ""}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
  return data;
}

export async function listDevices(): Promise<DeviceSession[]> {
  const res = await fetch("/api/auth/devices", { credentials: "same-origin" });
  if (res.status === 404) return [];
  const data = (await res.json().catch(() => ({}))) as { devices?: DeviceSession[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
  return data.devices ?? [];
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const res = await fetch(`/api/auth/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", credentials: "same-origin" });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const res = await fetch("/api/auth/passkeys", { credentials: "same-origin" });
  if (res.status === 404) return [];
  const data = (await res.json().catch(() => ({}))) as { passkeys?: PasskeyInfo[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
  return data.passkeys ?? [];
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
}

export async function projectRolesApi(
  projectId: string,
  method: "GET" | "PUT" | "DELETE",
  userId?: string,
  role?: AuthRole,
): Promise<ProjectRole[]> {
  const suffix = userId ? `/${encodeURIComponent(userId)}` : "";
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/roles${suffix}`, {
    method,
    credentials: "same-origin",
    headers: role ? { "Content-Type": "application/json" } : undefined,
    body: role ? JSON.stringify({ role }) : undefined,
  });
  if (res.status === 404) return [];
  const data = (await res.json().catch(() => ({}))) as { roles?: ProjectRole[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
  return data.roles ?? [];
}

function b64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function registerPasskey(label: string): Promise<PasskeyInfo> {
  if (typeof PublicKeyCredential === "undefined" || !navigator.credentials?.create) {
    throw new Error("Passkeys are not supported in this browser.");
  }
  const start = await post("/api/auth/passkeys/register/start", { label });
  if (!start.ok) throw new Error(String(start.data.error ?? "Could not start passkey registration."));
  const challengeId = String(start.data.challengeId ?? "");
  const opts = start.data.options as {
    publicKey: {
      challenge: string;
      rp: PublicKeyCredentialRpEntity;
      user: { id: string; name: string; displayName: string };
      pubKeyCredParams: PublicKeyCredentialParameters[];
      timeout?: number;
      excludeCredentials?: { id: string; type: PublicKeyCredentialType }[];
      authenticatorSelection?: AuthenticatorSelectionCriteria;
      attestation?: AttestationConveyancePreference;
    };
  };
  const pk: PublicKeyCredentialCreationOptions = {
    challenge: b64urlToBytes(opts.publicKey.challenge),
    rp: opts.publicKey.rp,
    user: {
      ...opts.publicKey.user,
      id: b64urlToBytes(opts.publicKey.user.id),
    },
    pubKeyCredParams: opts.publicKey.pubKeyCredParams,
    timeout: opts.publicKey.timeout,
    excludeCredentials: opts.publicKey.excludeCredentials?.map((c) => ({
      id: b64urlToBytes(c.id),
      type: c.type,
    })),
    authenticatorSelection: opts.publicKey.authenticatorSelection,
    attestation: opts.publicKey.attestation,
  };
  const cred = (await navigator.credentials.create({ publicKey: pk })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey registration was cancelled.");
  const resp = cred.response as AuthenticatorAttestationResponse;
  const finish = await post("/api/auth/passkeys/register/finish", {
    challengeId,
    credential: {
      id: cred.id,
      rawId: bytesToB64url(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: bytesToB64url(resp.attestationObject),
        clientDataJSON: bytesToB64url(resp.clientDataJSON),
      },
    },
  });
  if (!finish.ok) throw new Error(String(finish.data.error ?? "Could not save passkey."));
  return finish.data.passkey as PasskeyInfo;
}

export async function signInWithPasskey(name?: string): Promise<string | null> {
  if (typeof PublicKeyCredential === "undefined" || !navigator.credentials?.get) {
    return "Passkeys are not supported in this browser.";
  }
  try {
    const start = await post("/api/auth/passkeys/login/start", { name: name?.trim() || undefined });
    if (!start.ok) return String(start.data.error ?? "Could not start passkey sign-in.");
    const challengeId = String(start.data.challengeId ?? "");
    const opts = start.data.options as {
      publicKey: {
        challenge: string;
        rpId?: string;
        timeout?: number;
        allowCredentials?: { id: string; type: PublicKeyCredentialType }[];
        userVerification?: UserVerificationRequirement;
      };
    };
    const pk: PublicKeyCredentialRequestOptions = {
      challenge: b64urlToBytes(opts.publicKey.challenge),
      rpId: opts.publicKey.rpId,
      timeout: opts.publicKey.timeout,
      allowCredentials: opts.publicKey.allowCredentials?.map((c) => ({
        id: b64urlToBytes(c.id),
        type: c.type,
      })),
      userVerification: opts.publicKey.userVerification,
    };
    const cred = (await navigator.credentials.get({ publicKey: pk })) as PublicKeyCredential | null;
    if (!cred) return "Passkey sign-in was cancelled.";
    const resp = cred.response as AuthenticatorAssertionResponse;
    const finish = await post("/api/auth/passkeys/login/finish", {
      challengeId,
      credential: {
        id: cred.id,
        rawId: bytesToB64url(cred.rawId),
        type: cred.type,
        response: {
          authenticatorData: bytesToB64url(resp.authenticatorData),
          clientDataJSON: bytesToB64url(resp.clientDataJSON),
          signature: bytesToB64url(resp.signature),
          userHandle: resp.userHandle ? bytesToB64url(resp.userHandle) : null,
        },
      },
    });
    if (!finish.ok) return String(finish.data.error ?? "Passkey sign-in failed.");
    store("hq-live", "1");
    location.reload();
    return null;
  } catch {
    return "Could not complete passkey sign-in.";
  }
}
