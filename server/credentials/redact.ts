// Replaces stored secret values with "••••<last 4>" in anything that leaves the
// server: terminal output, events, snapshots. Terminal output arrives in chunks,
// so a key split across two chunks is caught by holding back a chunk's tail
// while it could be the start of a key (flushed on the next chunk or after FLUSH_MS).

const MIN_LEN = 8; // shorter values would hit ordinary text
const FLUSH_MS = 80;

/** Secrets to look for: each value, and for JSON credentials each long string inside it. */
export function secretsOf(values: string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v.length >= MIN_LEN) out.add(v);
    try {
      const walk = (x: unknown) => {
        if (typeof x === "string" && x.length >= MIN_LEN) out.add(x);
        else if (x && typeof x === "object") Object.values(x).forEach(walk);
      };
      walk(JSON.parse(v));
    } catch {
      /* not JSON */
    }
  }
  return [...out].sort((a, b) => b.length - a.length); // longest first: a key inside a longer one is masked once
}

export const mask = (s: string) => `••••${s.slice(-4)}`;

export class Redactor {
  private secrets: string[] = [];
  private carry = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly load: () => string[]) {
    this.refresh();
  }

  /** Re-read the vault (after an account's key is added, replaced or removed). */
  refresh() {
    try {
      this.secrets = secretsOf(this.load());
    } catch {
      this.secrets = [];
    }
  }

  get active(): boolean {
    return this.secrets.length > 0;
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) if (out.includes(s)) out = out.split(s).join(mask(s));
    return out;
  }

  /** Streaming: emits redacted output for `key` (an agent), holding back a possible partial secret at the end. */
  stream(key: string, chunk: string, emit: (text: string) => void) {
    const held = this.carry.get(key);
    if (held) clearTimeout(held.timer);
    const text = (held?.text ?? "") + chunk;
    if (!this.active) {
      this.carry.delete(key);
      return emit(text);
    }
    const hold = this.partialTail(text);
    const ready = this.redact(text.slice(0, text.length - hold));
    if (ready) emit(ready);
    if (!hold) return void this.carry.delete(key);
    const rest = text.slice(text.length - hold);
    this.carry.set(key, { text: rest, timer: setTimeout(() => (this.carry.delete(key), emit(this.redact(rest))), FLUSH_MS) });
  }

  /** Length of the longest end of `text` that is the beginning of a secret (and not a whole one). */
  private partialTail(text: string): number {
    let best = 0;
    for (const s of this.secrets)
      for (let n = Math.min(s.length - 1, text.length); n > best; n--)
        if (text.endsWith(s.slice(0, n))) {
          best = n;
          break;
        }
    return best;
  }
}
