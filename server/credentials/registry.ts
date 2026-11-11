// Accounts: named sign-ins agents can use (machine-wide, shared by every project).
// accounts.json holds only names, providers and non-secret settings; secret
// values live in the vault under "account:<id>". An agent's `account` that isn't
// listed here is a CLI subscription (its own config folder, see ../accounts.ts).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../../src/data/brand";
import { isProvider, PROVIDER_SPECS, providerEnv, type AccountView, type Provider, type ProviderEnv } from "../../src/data/providers";
import type { AgentCli } from "../../src/data/types";
import { cleanAccount } from "../accounts";
import { loadMasterKey, Vault } from "./vault";
import { Redactor } from "./redact";

export interface AccountRecord {
  id: string;
  provider: Provider;
  label: string;
  fields: Record<string, string>;
}

export interface AccountInput {
  id?: unknown;
  provider?: unknown;
  label?: unknown;
  fields?: unknown;
  secret?: unknown;
}

const secretRef = (id: string) => `account:${id}`;
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

export class Accounts {
  private list: AccountRecord[];

  constructor(
    private readonly vault: Vault,
    private readonly file: string,
  ) {
    try {
      this.list = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as AccountRecord[]).filter((a) => isProvider(a.provider)) : [];
    } catch {
      this.list = [];
    }
  }

  get masterSource() {
    return this.vault.masterSource;
  }

  views(): AccountView[] {
    const secrets = new Map(this.vault.list().map((s) => [s.ref, s]));
    return this.list.map((a) => {
      const s = secrets.get(secretRef(a.id));
      return { id: a.id, provider: a.provider, auth: PROVIDER_SPECS[a.provider].auth, label: a.label, fields: { ...a.fields }, secret: s ? { last4: s.last4, updatedAt: s.updatedAt } : null };
    });
  }

  get(id: string): AccountRecord | undefined {
    return this.list.find((a) => a.id === id);
  }

  /** Adds or updates an account. A missing secret keeps the stored one; an empty name is refused. */
  save(input: AccountInput): AccountRecord {
    const id = cleanAccount(clip(input.id, 40));
    if (!id || id === "default") throw new Error('Give the account a short name (letters, numbers, dashes), not "default".');
    const existing = this.get(id);
    const provider = isProvider(input.provider) ? input.provider : existing?.provider;
    if (!provider) throw new Error("Pick a provider.");
    const spec = PROVIDER_SPECS[provider];
    const raw = (input.fields && typeof input.fields === "object" ? input.fields : {}) as Record<string, unknown>;
    const fields = Object.fromEntries(spec.fields.map((f) => [f.id, clip(raw[f.id], 120)]).filter(([, v]) => v));
    const secret = typeof input.secret === "string" ? input.secret.trim() : "";
    if (secret) {
      if (secret.length > 20_000) throw new Error("That secret is too long.");
      if (spec.auth === "cloud") {
        try {
          JSON.parse(secret);
        } catch {
          // Not the parser's message: it quotes part of the input, which is the secret.
          throw new Error(`The ${spec.secretLabel} isn't valid JSON. Paste the whole file's contents.`);
        }
      }
      this.vault.set(secretRef(id), secret);
    } else if (!existing || !this.vault.list().some((s) => s.ref === secretRef(id))) {
      throw new Error(`Paste the ${spec.secretLabel.toLowerCase()}.`);
    }
    const rec: AccountRecord = { id, provider, label: clip(input.label, 60) || existing?.label || spec.label, fields };
    this.list = [...this.list.filter((a) => a.id !== id), rec].sort((a, b) => a.id.localeCompare(b.id));
    this.write();
    return rec;
  }

  remove(id: string) {
    this.list = this.list.filter((a) => a.id !== id);
    this.vault.delete(secretRef(id));
    this.write();
  }

  /** The environment (and files) an agent on `cli` needs for this account; null when it's a subscription account. */
  envFor(id: string, cli: AgentCli): ProviderEnv | { error: string } | null {
    const a = this.get(id);
    if (!a) return null;
    const secret = this.vault.get(secretRef(id));
    if (!secret) return { error: `The ${a.id} account has no key stored. Add it in Settings → Accounts.` };
    return providerEnv(a.provider, cli, secret, a.fields);
  }

  /** Every stored secret value, for redacting output. */
  secretValues(): string[] {
    return this.vault.values();
  }

  private write() {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

let shared: Accounts | null = null;
let redactorShared: Redactor | null = null;
let vaultShared: Vault | null = null;

/** One vault writer for accounts and machine-wide integrations. */
export function credentialsVault(): Vault {
  if (!vaultShared) {
    const dir = join(homedir(), BRAND.homeDir);
    vaultShared = new Vault(join(dir, "vault.json"), loadMasterKey({ dir }));
  }
  return vaultShared;
}

/** The machine's redactor: masks every stored secret. Works (as a no-op) when the vault can't be opened. */
export function redactor(): Redactor {
  if (!redactorShared)
    redactorShared = new Redactor(() => {
      try {
        // Nothing stored yet: nothing to hide, and no reason to create a master key.
        if (!shared && !existsSync(join(homedir(), BRAND.homeDir, "vault.json"))) return [];
        return accounts().secretValues();
      } catch {
        return [];
      }
    });
  return redactorShared;
}

/** The machine's accounts (one per HQ process). Throws if the vault's master key is missing or wrong. */
export function accounts(): Accounts {
  if (!shared) {
    const dir = join(homedir(), BRAND.homeDir);
    shared = new Accounts(credentialsVault(), join(dir, "accounts.json"));
  }
  return shared;
}

/** What every project's snapshot carries about accounts (no secret values). */
export function accountsState(): import("../../src/data/types").AccountsState {
  const dir = join(homedir(), BRAND.homeDir);
  if (!shared && !existsSync(join(dir, "vault.json")) && !existsSync(join(dir, "accounts.json"))) return { list: [], masterSource: null };
  try {
    const a = accounts();
    return { list: a.views(), masterSource: a.masterSource };
  } catch (e) {
    return { list: [], masterSource: null, error: e instanceof Error ? e.message : String(e) };
  }
}
