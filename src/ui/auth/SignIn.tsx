import { useState } from "react";
import { BRAND } from "../../data/brand";
import { signIn } from "../../store/auth";
import { Logo } from "../hud/TopBar";

/** Shown when this device isn't signed in to a real HQ. */
export function SignIn() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await signIn(name, password));
    setBusy(false);
  };
  return (
    <div className="fixed inset-0 overflow-y-auto bg-grass text-ink">
      <div className="flex min-h-full items-center justify-center p-4">
      <form className="panel flex w-full max-w-[380px] flex-col gap-3 p-5" onSubmit={submit} aria-label="Sign in">
        <div className="flex items-center gap-2.5">
          <Logo size={36} />
          <b className="text-[24px] text-gold">{BRAND.name}</b>
        </div>
        <p className="m-0 text-[14px] text-muted">Sign in to this HQ.</p>
        <label className="flex flex-col gap-1 text-[14px]">
          Name
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-[14px]">
          Password
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="m-0 text-[13px] text-red" role="alert">{error}</p>}
        <button className="btn border-green text-green" type="submit" disabled={busy || !name.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="m-0 text-[12px] text-muted">On the computer running HQ, the link it prints at start-up also signs you in.</p>
      </form>
      </div>
    </div>
  );
}
