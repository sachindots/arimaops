import { useState } from "react";
import { BRAND } from "../../data/brand";
import { signIn } from "../../store/auth";
import { Logo } from "../kit";

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
    <div className="deck-grid fixed inset-0 overflow-y-auto bg-[var(--color-grass)] text-ink">
      <div className="flex min-h-full items-center justify-center p-4">
        <form
          className="panel flex w-full max-w-[380px] flex-col gap-4 rounded-xl p-6 shadow-sm"
          onSubmit={submit}
          aria-label="Sign in"
        >
          <div className="flex items-center gap-3">
            <Logo size={34} />
            <div>
              <b className="block text-[17px] font-bold tracking-tight text-ink">{BRAND.name}</b>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">HQ Access</span>
            </div>
          </div>
          <p className="m-0 text-[13px] text-muted">Sign in to connect to this HQ instance.</p>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink" htmlFor="hq-signin-name">
            Name
            <input
              id="hq-signin-name"
              name="username"
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink" htmlFor="hq-signin-password">
            Password
            <input
              id="hq-signin-password"
              name="password"
              className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && (
            <p className="m-0 text-[12px] font-medium text-red" role="alert">
              {error}
            </p>
          )}
          <button
            className="btn btn-primary mt-1 py-2 text-[13px] font-semibold"
            type="submit"
            disabled={busy || !name.trim() || !password}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="m-0 text-[12px] leading-relaxed text-muted">
            On the machine running HQ, the start-up URL printed in the terminal also signs you in.
          </p>
        </form>
      </div>
    </div>
  );
}
