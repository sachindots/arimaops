// Encrypted store for API keys and cloud credentials. One JSON file; each value
// is AES-256-GCM encrypted with its name as associated data (a value can't be
// moved to another name). Values never leave this process except into the one
// agent process that needs them (see deliver.ts).
//
// The master key comes from, in order:
//   1. ARIMA_MASTER_KEY (servers: put it in your secret manager / systemd credential),
//   2. the OS keychain (Linux secret-tool, macOS security),
//   3. a 0600 key file beside the vault (weakest; the setup checklist warns about it).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { BRAND } from "../../src/data/brand";

export type MasterSource = "env" | "keychain" | "file";

interface Sealed {
  iv: string;
  tag: string;
  data: string;
  last4: string;
  updatedAt: string;
}

interface VaultFile {
  v: 1;
  /** sha256 of the master key, to tell "wrong key" from "corrupt file". */
  check: string;
  entries: Record<string, Sealed>;
}

export interface SecretInfo {
  ref: string;
  last4: string;
  updatedAt: string;
}

const KEYCHAIN_SERVICE = "arimaops";
const KEYCHAIN_ACCOUNT = "vault-master-key";

const fingerprint = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** A master key from a string: base64 of 32 bytes is used as is; anything else is hashed to 32 bytes. */
export function keyFrom(text: string): Buffer {
  const raw = Buffer.from(text.trim(), "base64");
  return raw.length === 32 ? raw : createHash("sha256").update(text.trim()).digest();
}

function keychainGet(): string | null {
  const os = platform();
  const r =
    os === "darwin"
      ? spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], { encoding: "utf8", timeout: 5000 })
      : os === "linux"
        ? spawnSync("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT], { encoding: "utf8", timeout: 5000 })
        : null;
  return r && r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function keychainSet(value: string): boolean {
  const os = platform();
  const r =
    os === "darwin"
      ? spawnSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", value], { timeout: 5000 })
      : os === "linux"
        ? spawnSync("secret-tool", ["store", "--label", `${BRAND.fullName} vault key`, "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT], { input: value, timeout: 5000 })
        : null;
  return !!r && r.status === 0;
}

export interface MasterKey {
  key: Buffer;
  source: MasterSource;
}

/** Finds (or, on first use, creates) the master key. `env`/`keychain`/`dir` are injectable for tests. */
export function loadMasterKey(opts: { env?: string; keychain?: { get(): string | null; set(v: string): boolean } | null; dir?: string } = {}): MasterKey {
  const env = opts.env ?? process.env.ARIMA_MASTER_KEY;
  if (env?.trim()) return { key: keyFrom(env), source: "env" };
  const kc = opts.keychain === undefined ? { get: keychainGet, set: keychainSet } : opts.keychain;
  const fromKc = kc?.get();
  if (fromKc) return { key: keyFrom(fromKc), source: "keychain" };
  const dir = opts.dir ?? join(homedir(), BRAND.homeDir);
  const file = join(dir, "vault.key");
  if (existsSync(file)) return { key: keyFrom(readFileSync(file, "utf8")), source: "file" };
  const fresh = randomBytes(32).toString("base64");
  if (kc?.set(fresh) && kc.get() === fresh) return { key: keyFrom(fresh), source: "keychain" };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, fresh + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return { key: keyFrom(fresh), source: "file" };
}

export class Vault {
  private data: VaultFile;

  constructor(
    private readonly file: string,
    private readonly master: MasterKey,
  ) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as VaultFile) : { v: 1, check: fingerprint(master.key), entries: {} };
    if (this.data.check !== fingerprint(master.key))
      throw new Error(`The vault at ${file} was locked with a different master key (${master.source}). Restore that key (ARIMA_MASTER_KEY or the keychain) instead of creating a new one.`);
  }

  get masterSource(): MasterSource {
    return this.master.source;
  }

  set(ref: string, value: string) {
    if (!ref || !value) throw new Error("A secret needs a name and a value.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master.key, iv);
    cipher.setAAD(Buffer.from(ref));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    this.data.entries[ref] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"), last4: value.slice(-4), updatedAt: new Date().toISOString() };
    this.save();
  }

  get(ref: string): string | null {
    const e = this.data.entries[ref];
    if (!e) return null;
    const d = createDecipheriv("aes-256-gcm", this.master.key, Buffer.from(e.iv, "base64"));
    d.setAAD(Buffer.from(ref));
    d.setAuthTag(Buffer.from(e.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString("utf8");
  }

  delete(ref: string) {
    if (!(ref in this.data.entries)) return;
    delete this.data.entries[ref];
    this.save();
  }

  /** What the UI may see: names, last 4 characters, when set. */
  list(): SecretInfo[] {
    return Object.entries(this.data.entries).map(([ref, e]) => ({ ref, last4: e.last4, updatedAt: e.updatedAt }));
  }

  /** Every stored value, for redaction. */
  values(): string[] {
    return Object.keys(this.data.entries).map((ref) => this.get(ref) ?? "").filter(Boolean);
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}
