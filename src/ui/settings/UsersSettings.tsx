import { useCallback, useEffect, useState } from "react";
import { changePassword, signOut, useAuth, usersApi, type AuthRole } from "../../store/auth";
import { AuthenticatorLink } from "../auth/Authenticator";
import { Field, SectionTitle } from "../kit";

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
  const { user, role } = useAuth();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ url: string; who: string } | null>(null);
  const [form, setForm] = useState({ name: "", role: "operator" as AuthRole, password: "" });
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [changingPassword, setChangingPassword] = useState(false);

  const load = useCallback(async () => {
    if (role !== "owner") return;
    try {
      setPeople((await usersApi<{ users: Person[] }>("GET")).users);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [role]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<{ otpauth?: string } | unknown>, who?: string) => {
    setError(null);
    try {
      const r = (await fn()) as { otpauth?: string };
      if (r?.otpauth && who) setShown({ url: r.otpauth, who });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 flex flex-wrap items-center gap-2 text-[14px] text-muted">
        {user ? (
          <>
            Signed in as <b className="text-ink">{user.name}</b> ({role}).
          </>
        ) : (
          <>Signed in with the start-up link.</>
        )}
        <button className="btn px-2 text-[12px]" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
      {error && <p className="m-0 border-[3px] border-red px-3 py-1.5 text-[13px]">{error}</p>}
      {shown && <AuthenticatorLink url={shown.url} who={shown.who} />}

      {user && (
        <form className="flex max-w-[520px] flex-col gap-3" aria-label="Change your password" onSubmit={async (event) => {
          event.preventDefault();
          if (passwords.next !== passwords.confirm) return setError("The new passwords do not match.");
          setChangingPassword(true);
          setError(await changePassword(passwords.current, passwords.next));
          setChangingPassword(false);
        }}>
          <SectionTitle>Change your password</SectionTitle>
          <p className="m-0 text-[13px] text-muted">Use your current password to set a new one. Other devices will be signed out.</p>
          <label className="flex flex-col gap-1 text-[14px]">Current password
            <input className="field" type="password" autoComplete="current-password" required value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-[14px]">New password
            <input className="field" type="password" autoComplete="new-password" minLength={10} maxLength={200} required value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-[14px]">Confirm new password
            <input className="field" type="password" autoComplete="new-password" minLength={10} maxLength={200} required value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} />
          </label>
          <button className="btn self-start border-green text-green" type="submit" disabled={changingPassword}>
            {changingPassword ? "Changing password…" : "Change password"}
          </button>
        </form>
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
              <div className="border-[3px] border-ink">
                {people.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t-2 border-dashed border-cream-3 px-3 py-2 first:border-t-0">
                    <b className={p.disabled ? "text-muted line-through" : ""}>{p.name}</b>
                    {p.id === user?.id && <span className="text-[12px] text-muted">you</span>}
                    <select className="field py-0 text-[13px]" value={p.role} aria-label={`${p.name}'s role`} onChange={(e) => void act(() => usersApi("PATCH", `/${p.id}`, { role: e.target.value }))}>
                      {(["owner", "operator", "viewer"] as AuthRole[]).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <span className="flex-1" />
                    <button
                      className="btn px-2 text-[12px]"
                      onClick={() => {
                        const pw = window.prompt(`New password for ${p.name} (10+ characters):`);
                        if (pw) void act(() => usersApi("PATCH", `/${p.id}`, { password: pw }));
                      }}
                    >
                      Reset password
                    </button>
                    <button className="btn px-2 text-[12px]" onClick={() => void act(() => usersApi("PATCH", `/${p.id}`, { resetTotp: true }), p.name)}>
                      New authenticator
                    </button>
                    <button className="btn px-2 text-[12px]" onClick={() => void act(() => usersApi("PATCH", `/${p.id}`, { disabled: !p.disabled }))}>
                      {p.disabled ? "Enable" : "Disable"}
                    </button>
                    {p.id !== user?.id && (
                      <button className="btn px-2 text-[12px]" onClick={() => window.confirm(`Remove ${p.name}? Their devices are signed out.`) && void act(() => usersApi("DELETE", `/${p.id}`))}>
                        Remove
                      </button>
                    )}
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
                <select className="field" value={people?.length === 0 ? "owner" : form.role} disabled={people?.length === 0} onChange={(e) => setForm({ ...form, role: e.target.value as AuthRole })}>
                  {(["operator", "viewer", "owner"] as AuthRole[]).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="First password" hint="10+ characters. Tell them to change it with you later.">
              <input className="field" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
            </Field>
            <div>
              <button
                className="btn border-green text-green"
                disabled={!form.name.trim() || form.password.length < 10}
                onClick={() =>
                  void act(async () => {
                    const r = await usersApi<{ otpauth: string; user: { name: string } }>("POST", "", form);
                    setForm({ name: "", role: "operator", password: "" });
                    setShown({ url: r.otpauth, who: r.user.name });
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
