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
    <div className="hud-void fixed inset-0 overflow-y-auto text-ink">
      <div className="flex min-h-full items-center justify-center p-4">
        <form
          className="hud-glass flex w-full max-w-[360px] flex-col gap-3.5 rounded-2xl p-6"
          onSubmit={submit}
          aria-label="Sign in"
        >
          <div className="flex items-center gap-2.5">
            <Logo size={30} />
            <div>
              <b className="block text-[18px] font-semibold tracking-tight text-ink">{BRAND.name}</b>
              <span className="font-term text-[12px] tracking-widest text-accent">HQ ACCESS</span>
            </div>
          </div>
          <p className="m-0 text-[13px] text-muted">Sign in to connect to this HQ instance.</p>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-ink" htmlFor="hq-signin-name">
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
          <label className="flex flex-col gap-1 text-[12px] font-medium text-ink" htmlFor="hq-signin-password">
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
            <p className="m-0 text-[12px] text-red" role="alert">
              {error}
            </p>
          )}
          <button
            className="mt-1 cursor-pointer rounded-lg border border-accent/45 bg-accent/15 px-4 py-2 font-term text-[12px] font-semibold tracking-wide text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
            type="submit"
            disabled={busy || !name.trim() || !password}
          >
            {busy ? "AUTHENTICATING…" : "SIGN IN"}
          </button>
          <p className="m-0 text-[12px] leading-relaxed text-muted">
            On the machine running HQ, the start-up URL printed in the terminal also signs you in.
          </p>
        </form>
      </div>
    </div>
  );
}
