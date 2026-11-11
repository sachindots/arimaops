// Run on the HQ host as its service user: npx tsx scripts/configure-push.ts /private/path/service-account.json
import { readFileSync } from "node:fs";
import { credentialsVault } from "../server/credentials/registry";
import { FcmSender, parseServiceAccount } from "../server/push";

try {
  const file = process.argv[2];
  if (!file) throw new Error("Pass the local Firebase service-account JSON path.");
  const raw = readFileSync(file, "utf8");
  const account = parseServiceAccount(raw);
  await new FcmSender(() => raw).accessToken();
  credentialsVault().set("push:fcm", raw);
  console.log(`Firebase authorization verified for ${account.project_id}; credential stored in the encrypted HQ vault.`);
} catch {
  console.error("Firebase setup failed. Check the file path, service-account key, network, and HQ vault master key.");
  process.exitCode = 1;
}
