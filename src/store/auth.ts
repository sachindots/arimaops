// Who is signed in on this device. Asks the server once at start; drives the
// sign-in screen, the owner prompt and the Users page. The server checks every
// command itself; this only decides what to show.

import { create } from "zustand";

export type AuthRole = "owner" | "operator" | "viewer";

interface AuthState {
  /** checking: asking the server. signed-in / signed-out: a real HQ answered. none: no HQ (the demo). */
  status: "checking" | "signed-in" | "signed-out" | "none";
  role: AuthRole | null;
  user: { id: string; name: string } | null;
  /** People with a sign-in on this install (0: nobody yet; the start-up link is the owner). */
  people: number;
}

export const useAuth = create<AuthState>(() => ({ status: "checking", role: null, user: null, people: 0 }));

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

export async function checkAuth() {
  try {
    const tok = linkToken();
    const res = await fetch(`/api/auth/me${tok ? `?token=${encodeURIComponent(tok)}` : ""}`, { credentials: "same-origin" });
    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { people?: number };
      return useAuth.setState({ status: "signed-out", role: null, user: null, people: body.people ?? 0 });
    }
    if (!res.ok) return useAuth.setState({ status: "none" });
    const me = (await res.json()) as { role: AuthRole; user: { id: string; name: string } | null; people: number };
    useAuth.setState({ status: "signed-in", role: me.role, user: me.user, people: me.people });
    // The rest of the UI reads the role at load: keep it in step (a changed role takes effect on reload).
    const was = (() => {
      try {
        return localStorage.getItem("hq-role");
      } catch {
        return null;
      }
    })();
    const now = me.role === "viewer" ? "viewer" : "operator";
    if (was !== now) store("hq-role", now);
  } catch {
    useAuth.setState({ status: "none" }); // no HQ server: the demo
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function signIn(name: string, password: string): Promise<string | null> {
  const r = await post("/api/auth/login", { name, password });
  if (!r.ok) return String(r.data.error ?? "Couldn't sign in.");
  store("hq-live", "1");
  location.reload();
  return null;
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
