import { useState } from "react";
import { BRAND } from "../../data/brand";
import { checkAuth, useAuth, usersApi } from "../../store/auth";
import { AuthenticatorLink } from "./Authenticator";

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
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ otpauth: string; name: string } | null>(null);
  if (status !== "signed-in" || role !== "owner" || (people > 0 && !made) || (hidden && !made)) return null;

  const create = async () => {
    setError(null);
    try {
      const r = await usersApi<{ otpauth: string; user: { name: string } }>("POST", "", { name, password, role: "owner" });
      setMade({ otpauth: r.otpauth, name: r.user.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    // Scrolls, and centres only when there's room: a phone or tablet keyboard takes half the screen.
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[rgba(4,6,12,0.7)]" role="dialog" aria-modal="true" aria-label="Make this HQ yours">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="panel flex w-full max-w-[440px] flex-col gap-3 p-5">
        {made ? (
          <>
            <b className="text-[18px]">You're the owner, {made.name}</b>
            <AuthenticatorLink url={made.otpauth} who={made.name} />
            <p className="m-0 text-[13px] text-muted">Add people in Settings → Users. Other devices now sign in with a name and password.</p>
            <button className="btn border-green text-green" onClick={() => (setMade(null), void checkAuth())}>
              Done
            </button>
          </>
        ) : (
          <>
            <b className="text-[18px]">Make this {BRAND.name} yours</b>
            <p className="m-0 text-[13px] text-muted">
              Create the owner sign-in. Then teammates get their own sign-ins and roles, every action is logged with who did it, and the start-up link stops
              working from other devices.
            </p>
            <input className="field" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
            <input className="field" type="password" placeholder="Password (10+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            {error && <p className="m-0 text-[13px] text-red">{error}</p>}
            <div className="flex gap-2">
              <button className="btn border-green text-green" disabled={!name.trim() || password.length < 10} onClick={() => void create()}>
                Create owner
              </button>
              <button
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
          </>
        )}
      </div>
      </div>
    </div>
  );
}
