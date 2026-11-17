import { useState } from "react";

/** A person's new authenticator link: shown once, to add to Google Authenticator, Aegis, 1Password… */
export function AuthenticatorLink({ url, who }: { url: string; who: string }) {
  const [copied, setCopied] = useState(false);
  const secret = new URL(url.replace("otpauth://", "https://")).searchParams.get("secret") ?? "";
  return (
    <div className="border border-gold p-3 text-[13px]">
      <b>Authenticator for {who}</b>
      <p className="m-0 mt-1 text-muted">
        Add this to an authenticator app now; it's shown only once. HQ asks for a code from it before risky actions from another device.
      </p>
      <p className="m-0 mt-2 break-all font-mono text-[12px]">Key: {secret.replace(/(.{4})/g, "$1 ").trim()}</p>
      <div className="mt-2 flex gap-2">
        <button
          className="btn px-2 text-[12px]"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy otpauth link"}
        </button>
        <a className="btn px-2 text-[12px]" href={url}>
          Open in authenticator
        </a>
      </div>
    </div>
  );
}
