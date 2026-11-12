// People who use this HQ: owner (everything, including accounts and people),
// operator (runs the teams), viewer (watches and chats). Passwords are scrypt
// hashes; each person has their own authenticator secret for the remote
// step-up. Stored in ~/.arima/arima.db (users.json row, 0600). Agents never use these.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { BRAND } from "../src/data/brand";
import { base32Encode } from "./remote";
import { readDoc, writeDoc } from "./lib/docs";

export const USER_ROLES = ["owner", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const isUserRole = (v: unknown): v is UserRole => typeof v === "string" && (USER_ROLES as readonly string[]).includes(v);

interface User {
  id: string;
  name: string;
  role: UserRole;
  salt: string;
  hash: string;
  /** Base32 TOTP secret for this person's step-up codes. */
  totp: string;
  createdAt: string;
  disabled?: boolean;
}

/** What the Users page shows. */
export interface UserView {
  id: string;
  name: string;
  role: UserRole;
  createdAt: string;
  disabled: boolean;
}

export const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const hashOf = (password: string, salt: string) => scryptSync(password, Buffer.from(salt, "base64"), 64, SCRYPT).toString("base64");
// Compared against when the name doesn't exist, so a wrong name takes as long as a wrong password.
const DUMMY = { salt: randomBytes(16).toString("base64"), hash: "" };
DUMMY.hash = hashOf(randomBytes(12).toString("hex"), DUMMY.salt);

const cleanName = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, 40) : "");

export function otpauthFor(name: string, secretB32: string): string {
  const label = encodeURIComponent(`${BRAND.name}:${name}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(BRAND.name)}&digits=6&period=30`;
}

export class Users {
  private list: User[];

  constructor(private readonly file: string) {
    try {
      this.list = readDoc<User[]>(file) ?? [];
    } catch {
      this.list = [];
    }
  }

  count(): number {
    return this.list.length;
  }

  views(): UserView[] {
    return this.list.map((u) => ({ id: u.id, name: u.name, role: u.role, createdAt: u.createdAt, disabled: !!u.disabled }));
  }

  /** An active person by id (null if missing or disabled). */
  active(id: string | undefined): { id: string; name: string; role: UserRole; totp: string } | null {
    const u = id ? this.list.find((x) => x.id === id) : undefined;
    return u && !u.disabled ? { id: u.id, name: u.name, role: u.role, totp: u.totp } : null;
  }

  firstOwner() {
    const u = this.list.find((x) => x.role === "owner" && !x.disabled);
    return u ? this.active(u.id) : null;
  }

  /** New person. Returns their authenticator link (shown once). */
  create(input: { name?: unknown; role?: unknown; password?: unknown }): { user: UserView; otpauth: string } {
    const name = cleanName(input.name);
    if (!name) throw new Error("Give the person a name.");
    if (this.list.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already someone called ${name}.`);
    const role = isUserRole(input.role) ? input.role : "operator";
    if (this.list.length === 0 && role !== "owner") throw new Error("The first person must be the owner.");
    const password = this.checkPassword(input.password);
    const salt = randomBytes(16).toString("base64");
    const user: User = { id: randomBytes(8).toString("hex"), name, role, salt, hash: hashOf(password, salt), totp: base32Encode(randomBytes(20)), createdAt: new Date().toISOString() };
    this.list.push(user);
    this.save();
    return { user: this.views().find((v) => v.id === user.id) as UserView, otpauth: otpauthFor(name, user.totp) };
  }

  /** The person if the name and password match (constant work either way). */
  verify(name: unknown, password: unknown): { id: string; name: string; role: UserRole } | null {
    const n = cleanName(name).toLowerCase();
    const pw = typeof password === "string" ? password : "";
    const u = this.list.find((x) => x.name.toLowerCase() === n);
    const target = u ?? DUMMY;
    const got = Buffer.from(hashOf(pw, target.salt), "base64");
    const want = Buffer.from(target.hash, "base64");
    const ok = got.length === want.length && timingSafeEqual(got, want);
    return ok && u && !u.disabled ? { id: u.id, name: u.name, role: u.role } : null;
  }

  update(id: string, patch: { role?: unknown; password?: unknown; disabled?: unknown; resetTotp?: unknown }): { otpauth?: string } {
    const index = this.list.findIndex((x) => x.id === id);
    if (index < 0) throw new Error("No such person.");
    // Validate the entire patch on a copy before changing any live credentials or roles.
    const u = { ...this.list[index] };
    const out: { otpauth?: string } = {};
    if (patch.role !== undefined) {
      if (!isUserRole(patch.role)) throw new Error("Unknown role.");
      if (u.role === "owner" && patch.role !== "owner") this.keepAnOwner(u.id);
      u.role = patch.role;
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled === true && u.role === "owner") this.keepAnOwner(u.id);
      u.disabled = patch.disabled === true;
    }
    if (patch.password !== undefined) {
      u.salt = randomBytes(16).toString("base64");
      u.hash = hashOf(this.checkPassword(patch.password), u.salt);
    }
    if (patch.resetTotp === true) {
      u.totp = base32Encode(randomBytes(20));
      out.otpauth = otpauthFor(u.name, u.totp);
    }
    this.list[index] = u;
    this.save();
    return out;
  }

  remove(id: string) {
    const u = this.list.find((x) => x.id === id);
    if (!u) return;
    if (u.role === "owner") this.keepAnOwner(u.id);
    this.list = this.list.filter((x) => x.id !== id);
    this.save();
  }

  private keepAnOwner(exceptId: string) {
    if (!this.list.some((x) => x.id !== exceptId && x.role === "owner" && !x.disabled)) throw new Error("Keep at least one active owner: make someone else owner first.");
  }

  private checkPassword(p: unknown): string {
    const pw = typeof p === "string" ? p : "";
    if (pw.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
    if (pw.length > 200) throw new Error("That password is too long.");
    return pw;
  }

  private save() {
    writeDoc(this.file, this.list);
  }
}

/** Failed sign-ins: at most `max` per key (address, name) per window, then refused until it passes. */
export class Throttle {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()) {
    this.hits.set(key, [...this.recent(key, now), now]);
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  private recent(key: string, now: number) {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }
}
