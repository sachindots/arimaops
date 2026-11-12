// SPDX-License-Identifier: AGPL-3.0-or-later
// Signs a licence file with the private key from license-keygen.ts and checks it against the
// public key in server/licenseKey.ts before printing it.
// Run: npx tsx scripts/license-sign.ts --key <private.pem> --licensee "Acme" --tier security --seats 5 --features audit-export --days 365 > license.json
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { signLicense, TIERS, verifyLicense, type LicensePayload } from "../server/license";

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    licensee: { type: "string" },
    tier: { type: "string" },
    seats: { type: "string", default: "1" },
    features: { type: "string", default: "" },
    days: { type: "string", default: "365" },
  },
});
const fail = (why: string) => {
  console.error(why);
  process.exit(1);
};
if (!values.key || !values.licensee) fail("Needs --key <private.pem> and --licensee <name>.");
if (!(TIERS as readonly string[]).includes(values.tier ?? "")) fail(`--tier is one of ${TIERS.join(", ")}.`);
const now = new Date();
const payload: LicensePayload = {
  licensee: values.licensee!,
  tier: values.tier as LicensePayload["tier"],
  seats: Number(values.seats),
  features: values.features!.split(",").map((f) => f.trim()).filter(Boolean),
  issued: now.toISOString(),
  expires: new Date(now.getTime() + Number(values.days) * 86_400_000).toISOString(),
};
const file = signLicense(payload, readFileSync(values.key!, "utf8"));
const check = verifyLicense(file);
if (!check.ok) fail(`Signed, but it doesn't verify with this build's public key: ${check.why}`);
console.log(JSON.stringify(file, null, 2));
