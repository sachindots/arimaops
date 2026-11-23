import { useState, type InputHTMLAttributes } from "react";
import { Icon } from "../deck/Icon";

/** Password input with an accessible show/hide visibility toggle. */
export function PasswordInput({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative flex items-center">
      <input {...props} type={visible ? "text" : "password"} className={`field pr-9 ${className}`} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        title={visible ? "Hide password" : "Show password"}
        className="absolute right-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-muted hover:text-ink"
      >
        <Icon name={visible ? "visibility_off" : "visibility"} size={16} />
      </button>
    </div>
  );
}
