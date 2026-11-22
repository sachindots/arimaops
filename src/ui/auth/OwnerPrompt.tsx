import { useState } from "react";
import { BRAND } from "../../data/brand";
import { checkAuth, useAuth, usersApi } from "../../store/auth";
import { AuthenticatorLink } from "./Authenticator";
import { PasswordInput } from "./PasswordInput";

const LATER = "arima.ownerPromptLater";

/** While nobody has a sign-in, the start-up link is the owner. This asks them to make it theirs (needed for anyone else to join). */
export function OwnerPrompt() {
  const { status, role, people } = useAuth();
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(LATER) === "1";
    } catch {
      return false;
    }
  });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedKey, setSavedKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ otpauth: string; qrSvg?: string; name: string } | null>(null);
  if (status !== "signed-in" || role !== "owner" || (people > 0 && !made) || (hidden && !made)) return null;

  const mismatch = confirm.length > 0 && password !== confirm;
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await usersApi<{ otpauth: string; qrSvg?: string; user: { name: string } }>("POST", "", {
        name: name.trim(),
        password,
        role: "owner",
      });
      setSavedKey(false);
      setMade({ otpauth: r.otpauth, qrSvg: r.qrSvg, name: r.user.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    // Scrolls, and centres only when there's room: a phone or tablet keyboard takes half the screen.
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[rgba(4,6,12,0.7)]" role="dialog" aria-modal="true" aria-label="Make this HQ yours">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="panel flex w-full max-w-[440px] flex-col gap-3 p-5">
        {made ? (
          <>
            <b className="text-[20px]">You're the owner, {made.name}</b>
            <AuthenticatorLink url={made.otpauth} who={made.name} qrSvg={made.qrSvg} />
            <p className="m-0 text-[13px] text-muted">Add people in Settings → People. Other devices now sign in with a name and password.</p>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={savedKey} onChange={(e) => setSavedKey(e.target.checked)} />
              <span>I saved my authenticator key</span>
            </label>
            <button type="button" className="btn border-green text-green" disabled={!savedKey} onClick={() => (setMade(null), void checkAuth())}>
              Done
            </button>
          </>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={create}>
            <b className="text-[20px]">Make this {BRAND.name} yours</b>
            <p className="m-0 text-[13px] text-muted">
              Create the owner sign-in. Then teammates get their own sign-ins and roles, every action is logged with who did it, and the start-up link stops
              working from other devices.
            </p>
            <input className="field" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
            <PasswordInput placeholder="Password (10+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <PasswordInput placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            {mismatch && <p className="m-0 text-[12px] text-red">Passwords do not match.</p>}
            {error && <p className="m-0 text-[13px] text-red">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                className="btn border-green text-green"
                disabled={busy || !name.trim() || password.length < 10 || password !== confirm}
              >
                {busy ? "Creating…" : "Create owner"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  try {
                    sessionStorage.setItem(LATER, "1");
                  } catch {
                    /* private mode */
                  }
                  setHidden(true);
                }}
              >
                Later
              </button>
            </div>
          </form>
        )}
      </div>
      </div>
    </div>
  );
}
