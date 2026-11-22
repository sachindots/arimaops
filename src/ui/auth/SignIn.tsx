import { useState } from "react";
import { BRAND } from "../../data/brand";
import { switchServer, useIsNativeClient } from "../../lib/native";
import { signIn, signInWithPasskey, signInWithToken, useAuth } from "../../store/auth";
import { Icon } from "../deck/Icon";
import { Logo } from "../kit";
import { PasswordInput } from "./PasswordInput";

/** Shown when this device isn't signed in to a real HQ. */
export function SignIn() {
  const { people, passkeysAvailable } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nativeClient = useIsNativeClient();
  const canPasskey = passkeysAvailable && typeof PublicKeyCredential !== "undefined";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await signIn(name, password));
    setBusy(false);
  };

  const submitPasskey = async () => {
    setBusy(true);
    setError(await signInWithPasskey(name));
    setBusy(false);
  };

  const submitToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await signInWithToken(token));
    setBusy(false);
  };

  return (
    <div className="deck-grid fixed inset-0 overflow-y-auto bg-[var(--color-grass)] text-ink">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="panel flex w-full max-w-[380px] flex-col gap-4 rounded-xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <Logo size={48} />
            <div>
              <b className="block text-[15px] font-semibold tracking-tight text-ink">{BRAND.name}</b>
              <span className="text-[12px] font-medium text-muted">HQ access</span>
            </div>
          </div>
          <p className="m-0 text-[13px] text-muted">
            {people === 0
              ? "No user accounts exist yet. Use the start-up URL or token printed in the HQ terminal to create the owner."
              : "Sign in to connect to this HQ instance."}
          </p>
          <form className="flex flex-col gap-3" onSubmit={submit} aria-label="Sign in">
            <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink" htmlFor="hq-signin-name">
              Name
              <input
                id="hq-signin-name"
                name="username"
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="username webauthn"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink" htmlFor="hq-signin-password">
              Password
              <PasswordInput
                id="hq-signin-password"
                name="password"
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
            {canPasskey && (
              <button
                type="button"
                className="btn flex items-center justify-center gap-1.5 py-2 text-[13px] font-semibold"
                disabled={busy}
                onClick={() => void submitPasskey()}
              >
                <Icon name="passkey" size={18} />
                <span>Sign in with Passkey</span>
              </button>
            )}
          </form>

          <div className="border-t border-[var(--border-hairline)] pt-3">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center justify-between text-[12px] font-medium text-muted hover:text-ink"
              aria-expanded={tokenOpen}
              onClick={() => setTokenOpen((v) => !v)}
            >
              <span>Use a start-up token</span>
              <Icon name={tokenOpen ? "expand_less" : "expand_more"} size={16} />
            </button>
            {tokenOpen && (
              <form className="mt-2.5 flex flex-col gap-2" onSubmit={submitToken}>
                <input
                  className="field"
                  type="password"
                  placeholder="Paste HQ start-up token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
                <button className="btn py-1.5 text-[12px] font-semibold" type="submit" disabled={busy || !token.trim()}>
                  Sign in with token
                </button>
              </form>
            )}
          </div>

          <p className="m-0 text-[12px] leading-relaxed text-muted">
            On the machine running HQ, the start-up URL printed in the terminal also signs you in.
          </p>

          {nativeClient && (
            <div className="border-t border-[var(--border-hairline)] pt-3">
              <button
                type="button"
                className="btn flex w-full items-center justify-center gap-1.5 py-2 text-[13px] font-medium"
                onClick={() => void switchServer()}
              >
                <Icon name="dns" size={16} />
                <span>Switch server</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
