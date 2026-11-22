import { useState } from "react";

/** A person's new authenticator link: shown once, to add to Google Authenticator, Aegis, 1Password… */
export function AuthenticatorLink({ url, who, qrSvg }: { url: string; who: string; qrSvg?: string }) {
  const [copied, setCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const secret = new URL(url.replace("otpauth://", "https://")).searchParams.get("secret") ?? "";
  const formattedSecret = secret.replace(/(.{4})/g, "$1 ").trim();
  const qrDataUrl = qrSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(qrSvg)}` : null;
  return (
    <div className="rounded-lg border border-gold/40 bg-card/60 p-3 text-[13px]">
      <b>Authenticator for {who}</b>
      <p className="m-0 mt-1 text-[12px] text-muted">
        Scan this QR code or copy the key into Google Authenticator, Aegis, or 1Password. It is shown only once. HQ asks for a 6-digit code before risky actions.
      </p>
      {qrDataUrl && (
        <div className="mt-2.5 flex justify-center rounded-lg bg-white p-2.5">
          <img src={qrDataUrl} alt={`Authenticator QR code for ${who}`} className="h-[152px] w-[152px]" />
        </div>
      )}
      <p className="m-0 mt-2.5 break-all font-mono text-[12px] text-ink">Key: {formattedSecret}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn px-2.5 py-1 text-[12px]"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopiedKey(true));
          }}
        >
          {copiedKey ? "Key copied" : "Copy key"}
        </button>
        <button
          type="button"
          className="btn px-2.5 py-1 text-[12px]"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? "Link copied" : "Copy otpauth link"}
        </button>
        <a className="btn inline-flex items-center px-2.5 py-1 text-[12px]" href={url}>
          Open in app
        </a>
      </div>
    </div>
  );
}
