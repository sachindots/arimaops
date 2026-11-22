import { useCallback, useEffect, useState } from "react";
import type { DeviceSession, PasskeyInfo } from "../../data/generated";
import {
  changePassword,
  deletePasskey,
  listDevices,
  listPasskeys,
  markSignedOut,
  projectRolesApi,
  registerPasskey,
  revokeDevice,
  signOut,
  useAuth,
  usersApi,
  type AuthRole,
} from "../../store/auth";
import { useOffice } from "../../store/office";
import { AuthenticatorLink } from "../auth/Authenticator";
import { PasswordInput } from "../auth/PasswordInput";
import { Field, SectionTitle } from "../kit";
import { Select } from "../primitives/Select";
import { ask } from "../dialog";

interface Person {
  id: string;
  name: string;
  role: AuthRole;
  createdAt: string;
  disabled: boolean;
}

const ROLE_HINT: Record<AuthRole, string> = {
  owner: "Everything, including people and API keys",
  operator: "Runs the teams: agents, tasks, merges",
  viewer: "Watches and chats",
};

/** The owner's list of people: add, change role, reset password or authenticator, disable, remove. */
export function UsersSettings() {
  const { user, role, passkeysAvailable } = useAuth();
  const projectId = useOffice((s) => s.snap?.config.project.id ?? null);
  const projectName = useOffice((s) => s.snap?.config.project.name ?? null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [projectRoles, setProjectRoles] = useState<Record<string, AuthRole>>({});
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ url: string; who: string; qrSvg?: string } | null>(null);
  const [form, setForm] = useState({ name: "", role: "operator" as AuthRole, password: "" });
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passkeyLabel, setPasskeyLabel] = useState("");
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const tasks: Promise<void>[] = [];
      if (role === "owner") {
        tasks.push(
          usersApi<{ users: Person[] }>("GET").then((r) => setPeople(r.users)),
        );
        if (projectId) {
          tasks.push(
            projectRolesApi(projectId, "GET").then((rows) => {
              const map: Record<string, AuthRole> = {};
              for (const row of rows) map[row.userId] = row.role;
              setProjectRoles(map);
            }),
          );
        }
      }
      if (user) {
        tasks.push(listDevices().then(setDevices));
        if (passkeysAvailable) {
          tasks.push(listPasskeys().then(setPasskeys));
        }
      }
      await Promise.all(tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [role, user, projectId, passkeysAvailable]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<{ otpauth?: string; qrSvg?: string } | unknown>, who?: string) => {
    setError(null);
    try {
      const r = (await fn()) as { otpauth?: string; qrSvg?: string };
      if (r?.otpauth && who) setShown({ url: r.otpauth, who, qrSvg: r.qrSvg });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        {user ? (
          <>
            Signed in as <b className="text-ink">{user.name}</b> ({role}).
          </>
        ) : (
          <>Signed in with the start-up link.</>
        )}
        <button type="button" className="btn px-2 text-[12px]" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
      {error && <p className="m-0 rounded border border-red px-3 py-1.5 text-[13px] text-red">{error}</p>}
      {shown && <AuthenticatorLink url={shown.url} who={shown.who} qrSvg={shown.qrSvg} />}

      {user && (
        <form
          className="flex max-w-[520px] flex-col gap-3"
          aria-label="Change your password"
          onSubmit={async (event) => {
            event.preventDefault();
            setPasswordStatus(null);
            setError(null);
            if (passwords.next !== passwords.confirm) return setError("The new passwords do not match.");
            setChangingPassword(true);
            const err = await changePassword(passwords.current, passwords.next);
            setChangingPassword(false);
            if (err) {
              setError(err);
            } else {
              setPasswordStatus("Password updated.");
              setPasswords({ current: "", next: "", confirm: "" });
            }
          }}
        >
          <SectionTitle>Change your password</SectionTitle>
          <p className="m-0 text-[13px] text-muted">Use your current password to set a new one. Other devices will be signed out.</p>
          <label className="flex flex-col gap-1 text-[13px]">
            Current password
            <PasswordInput
              autoComplete="current-password"
              required
              value={passwords.current}
              onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            New password
            <PasswordInput
              autoComplete="new-password"
              minLength={10}
              maxLength={200}
              required
              value={passwords.next}
              onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            Confirm new password
            <PasswordInput
              autoComplete="new-password"
              minLength={10}
              maxLength={200}
              required
              value={passwords.confirm}
              onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
            />
          </label>
          {passwordStatus && <p className="m-0 text-[13px] text-green">{passwordStatus}</p>}
          <button className="btn self-start border-green text-green" type="submit" disabled={changingPassword}>
            {changingPassword ? "Changing password…" : "Change password"}
          </button>
        </form>
      )}

      {user && (
        <section className="flex max-w-[600px] flex-col gap-3">
          <SectionTitle>Passkeys</SectionTitle>
          {!passkeysAvailable ? (
            <p className="m-0 text-[13px] text-muted">Passkeys require http://localhost or an https:// domain.</p>
          ) : (
            <>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError(null);
                  setPasskeyBusy(true);
                  try {
                    await registerPasskey(passkeyLabel.trim() || "This browser");
                    setPasskeyLabel("");
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setPasskeyBusy(false);
                  }
                }}
              >
                <input
                  className="field max-w-[260px]"
                  placeholder="Label (e.g. Laptop Touch ID)"
                  value={passkeyLabel}
                  onChange={(e) => setPasskeyLabel(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn border-green text-green"
                  disabled={passkeyBusy || typeof PublicKeyCredential === "undefined"}
                >
                  {passkeyBusy ? "Waiting for device…" : "Add passkey"}
                </button>
              </form>
              {!passkeys ? (
                <p className="m-0 text-[13px] text-muted">Loading passkeys…</p>
              ) : passkeys.length === 0 ? (
                <p className="m-0 text-[13px] text-muted">No passkeys registered yet.</p>
              ) : (
                <div className="divide-y divide-[var(--border-hairline)] rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)]">
                  {passkeys.map((pk) => (
                    <div key={pk.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                      <b className="text-[13px] font-semibold text-ink">{pk.label}</b>
                      <span className="text-[12px] text-muted">
                        Added {new Date(pk.createdAt).toLocaleDateString()}
                        {pk.lastUsedAt ? ` · Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}` : " · Never used"}
                      </span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        className="btn px-2.5 text-[12px]"
                        onClick={() =>
                          void ask
                            .confirm(`Remove passkey "${pk.label}"?`, "You can register another passkey anytime.", { ok: "Remove", danger: true })
                            .then((ok) => ok && void act(() => deletePasskey(pk.id)))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {user && (
        <section className="flex max-w-[680px] flex-col gap-3">
          <SectionTitle>Active Devices</SectionTitle>
          {!devices ? (
            <p className="m-0 text-[13px] text-muted">Loading devices…</p>
          ) : devices.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">No active device sessions.</p>
          ) : (
            <div className="divide-y divide-[var(--border-hairline)] rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)]">
              {devices.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                  <b className="min-w-0 max-w-[360px] truncate text-[13px] font-semibold text-ink" title={d.label}>{d.label}</b>
                  {d.current && <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--color-green)" }}>this device</span>}
                  {d.remote && <span className="chip text-[12px]">remote</span>}
                  <span className="text-[12px] text-muted">
                    {d.origin ? `${d.origin} · ` : ""}Last seen {new Date(d.lastSeenAt).toLocaleString()}
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="btn px-2.5 text-[12px]"
                    onClick={() =>
                      void act(async () => {
                        await revokeDevice(d.id);
                        if (d.current) markSignedOut();
                      })
                    }
                  >
                    {d.current ? "Sign out" : "Revoke"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {role === "owner" && (
        <>
          <section>
            <SectionTitle>People</SectionTitle>
            {!people ? (
              <p className="text-[13px] text-muted">Loading…</p>
            ) : people.length === 0 ? (
              <p className="text-[13px] text-muted">Nobody has a sign-in yet. Add yourself as the owner below.</p>
            ) : (
              <div className="divide-y divide-[var(--border-hairline)] rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)]">
                {people.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <b className={`text-[13px] font-semibold ${p.disabled ? "text-muted line-through" : "text-ink"}`}>{p.name}</b>
                    {p.id === user?.id && <span className="chip text-[12px]">you</span>}
                    <Select
                      className="w-auto min-w-[108px]"
                      size="sm"
                      value={p.role}
                      ariaLabel={`${p.name}'s role`}
                      onChange={(v) => void act(() => usersApi("PATCH", `/${p.id}`, { role: v }))}
                      options={(["owner", "operator", "viewer"] as AuthRole[]).map((r) => ({ value: r, label: r }))}
                    />
                    {projectId && (
                      <Select
                        className="w-auto min-w-[165px]"
                        size="sm"
                        value={projectRoles[p.id] ?? ""}
                        ariaLabel={`${p.name}'s role on ${projectName ?? projectId}`}
                        onChange={(next) => {
                          void act(() =>
                            next === ""
                              ? projectRolesApi(projectId, "DELETE", p.id)
                              : projectRolesApi(projectId, "PUT", p.id, next as AuthRole),
                          );
                        }}
                        options={[
                          { value: "", label: `${projectName ?? "Project"}: inherit (${p.role})` },
                          ...(["owner", "operator", "viewer"] as AuthRole[]).map((r) => ({
                            value: r,
                            label: `${projectName ?? "Project"}: ${r}`,
                          })),
                        ]}
                      />
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
                      <button
                        type="button"
                        className="btn px-2.5 text-[12px]"
                        onClick={() => {
                          void ask.text(`New password for ${p.name}`, "10 or more characters.", { field: "password", ok: "Set password" }).then((pw) => {
                            if (pw) void act(() => usersApi("PATCH", `/${p.id}`, { password: pw }));
                          });
                        }}
                      >
                        Reset password
                      </button>
                      <button type="button" className="btn px-2.5 text-[12px]" onClick={() => void act(() => usersApi("PATCH", `/${p.id}`, { resetTotp: true }), p.name)}>
                        New authenticator
                      </button>
                      <button type="button" className="btn px-2.5 text-[12px]" onClick={() => void act(() => usersApi("PATCH", `/${p.id}`, { disabled: !p.disabled }))}>
                        {p.disabled ? "Enable" : "Disable"}
                      </button>
                      {p.id !== user?.id && (
                        <button type="button" className="btn px-2.5 text-[12px]" onClick={() => void ask.confirm(`Remove ${p.name}?`, "Their devices are signed out.", { ok: "Remove", danger: true }).then((ok) => ok && void act(() => usersApi("DELETE", `/${p.id}`)))}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex max-w-[520px] flex-col gap-3">
            <SectionTitle>Add a person</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
              </Field>
              <Field label="Role" hint={ROLE_HINT[form.role]}>
                <Select
                  value={people?.length === 0 ? "owner" : form.role}
                  disabled={people?.length === 0}
                  ariaLabel="Role"
                  onChange={(v) => setForm({ ...form, role: v as AuthRole })}
                  options={(["operator", "viewer", "owner"] as AuthRole[]).map((r) => ({ value: r, label: r }))}
                />
              </Field>
            </div>
            <Field label="First password" hint="10+ characters. Tell them to change it with you later.">
              <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
            </Field>
            <div>
              <button
                type="button"
                className="btn border-green text-green"
                disabled={!form.name.trim() || form.password.length < 10}
                onClick={() =>
                  void act(async () => {
                    const r = await usersApi<{ otpauth: string; qrSvg?: string; user: { name: string } }>("POST", "", form);
                    setForm({ name: "", role: "operator", password: "" });
                    setShown({ url: r.otpauth, who: r.user.name, qrSvg: r.qrSvg });
                    return {};
                  })
                }
              >
                Add person
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
