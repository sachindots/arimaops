// SPDX-License-Identifier: AGPL-3.0-or-later
// Makes the ArimaOps licence-signing key pair, once. The private key goes to the path you give
// (0600, never inside this repo); the public key is written into server/licenseKey.ts.
// Run: npx tsx scripts/license-keygen.ts ~/Documents/Keys/arimaops-license-private.pem
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: npx tsx scripts/license-keygen.ts <where to save the private key>");
  process.exit(1);
}
const file = resolve(target);
if (!relative(process.cwd(), file).startsWith("..")) {
  console.error("Refused: keep the private key outside the repo.");
  process.exit(1);
}
if (existsSync(file)) {
  console.error(`Refused: ${file} exists. A new key would invalidate every licence signed with the old one.`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
writeFileSync(
  "server/licenseKey.ts",
  `// SPDX-License-Identifier: AGPL-3.0-or-later
// The public half of the ArimaOps licence-signing key. scripts/license-keygen.ts writes it here;
// the private half never enters the repo. null: no key yet, so no licence verifies.
export const LICENSE_PUBLIC_KEY: string | null = ${JSON.stringify(pem)};
`,
);
console.log(`Private key: ${file} (keep it safe and backed up; it signs every licence).`);
console.log("Public key: written to server/licenseKey.ts. Commit that file.");
