// The licence check and the open-core seam: signatures, dates, tampering, the ee/ stub starting only
// with a valid licence, and the core never importing ee/. Run: npx tsx scripts/license-test.ts
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEe, startFeatures } from "../server/features";
import { readLicense, signLicense, verifyLicense, type LicensePayload } from "../server/license";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const keys = pair();
const other = pair();
const day = 86_400_000;
const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  licensee: "Acme Security",
  tier: "security",
  seats: 5,
  features: ["ee-stub"],
  issued: new Date(Date.now() - day).toISOString(),
  expires: new Date(Date.now() + 30 * day).toISOString(),
  ...over,
});
const why = (r: ReturnType<typeof verifyLicense>) => (r.ok ? "ok" : r.why);

const good = signLicense(payload(), keys.priv);
const ok = verifyLicense(good, keys.pub);
check("a signed licence verifies", ok.ok && ok.license.licensee === "Acme Security", why(ok));
check("an expired licence is refused", /expired/.test(why(verifyLicense(signLicense(payload({ expires: new Date(Date.now() - day).toISOString() }), keys.priv), keys.pub))));
check("a licence that hasn't started is refused", /starts on/.test(why(verifyLicense(signLicense(payload({ issued: new Date(Date.now() + day).toISOString() }), keys.priv), keys.pub))));
{
  const raised = Buffer.from(JSON.stringify({ ...payload(), seats: 500 })).toString("base64url");
  check("a payload changed after signing is refused", /signature doesn't match/.test(why(verifyLicense({ ...good, payload: raised }, keys.pub))));
  const sig = Buffer.from(good.signature, "base64url");
  sig[0] ^= 1;
  check("a changed signature is refused", /signature doesn't match/.test(why(verifyLicense({ ...good, signature: sig.toString("base64url") }, keys.pub))));
}
check("a licence signed with another key is refused", /signature doesn't match/.test(why(verifyLicense(signLicense(payload(), other.priv), keys.pub))));
check("a malformed file is refused", /right format/.test(why(verifyLicense({ payload: 1 }, keys.pub))));
check("a signed payload missing fields is refused", /missing fields/.test(why(verifyLicense(signLicense({ ...payload(), seats: 0 }, keys.priv), keys.pub))));
check("a build without a public key verifies nothing", /no licence key/.test(why(verifyLicense(good, null))));
{
  const dir = mkdtempSync(join(tmpdir(), "arima-lic-"));
  check("no licence file is reported, not thrown", /No licence file/.test(why(readLicense(join(dir, "license.json"), keys.pub))));
  writeFileSync(join(dir, "license.json"), JSON.stringify(good));
  check("a licence file on disk verifies", readLicense(join(dir, "license.json"), keys.pub).ok);
}

// The seam: ee/ loads only when present, and its stub runs only when the licence lists it.
const ee = await loadEe(join(import.meta.dirname, "..", "server"));
check("ee/ loads from source when the folder is there", typeof ee["ee-stub"] === "function", Object.keys(ee).join());
check("an install without ee/ loads no features", Object.keys(await loadEe(mkdtempSync(join(tmpdir(), "arima-noee-")))).length === 0);
const logs: string[] = [];
const on = await startFeatures(ee, verifyLicense(good, keys.pub), (m) => logs.push(m));
check("the stub runs with a valid licence", on.started.includes("ee-stub") && logs.some((l) => l.includes("Acme Security")), JSON.stringify(on));
const expired = await startFeatures(ee, verifyLicense(signLicense(payload({ expires: new Date(Date.now() - day).toISOString() }), keys.priv), keys.pub), () => {});
check("the stub doesn't run with an expired licence", expired.started.length === 0 && /expired/.test(expired.skipped[0]?.why ?? ""));
const tampered = await startFeatures(ee, verifyLicense({ ...good, payload: Buffer.from(JSON.stringify(payload({ seats: 99 }))).toString("base64url") }, keys.pub), () => {});
check("the stub doesn't run with a tampered licence", tampered.started.length === 0);
const unlisted = await startFeatures(ee, verifyLicense(signLicense(payload({ features: [] }), keys.priv), keys.pub), () => {});
check("the stub doesn't run when the licence doesn't list it", unlisted.started.length === 0 && /doesn't include ee-stub/.test(unlisted.skipped[0]?.why ?? ""));
const isolated = await startFeatures({ broken: () => { throw new Error("boom"); }, "ee-stub": ee["ee-stub"] }, verifyLicense(signLicense(payload({ features: ["broken", "ee-stub"] }), keys.priv), keys.pub), () => {});
check("one feature failing doesn't stop the others", isolated.started.join() === "ee-stub" && /boom/.test(isolated.skipped[0]?.why ?? ""));

// The core never imports ee/: only server/features.ts names it, by path, at run time.
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") || f.endsWith(".tsx") ? [join(dir, f)] : []));
const root = join(import.meta.dirname, "..");
const importsEe = [...files(join(root, "server")), ...files(join(root, "src"))].filter((f) => /from\s+["'](\.\.\/)+ee\//.test(readFileSync(f, "utf8")));
check("no core file imports ee/", importsEe.length === 0, importsEe.join(", "));

// The key-pair script keeps the private key out of the repo.
const inside = spawnSync(process.execPath, ["--import", "tsx", "scripts/license-keygen.ts", "license-private.pem"], { cwd: root, encoding: "utf8" });
check("keygen refuses a private key path inside the repo", inside.status === 1 && /outside the repo/.test(inside.stderr), inside.stderr);

if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
