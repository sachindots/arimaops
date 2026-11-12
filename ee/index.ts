// Commercial: see ee/LICENSE. Runs only with a valid ArimaOps licence that lists each feature.
// The core never imports this folder; server/features.ts loads it when it is present.
import type { EeModule } from "../server/features";

export const features: EeModule["features"] = {
  /** A placeholder that proves the seam: it only logs who the licence is for. */
  "ee-stub": ({ license, log }) => log(`Licensed features on for ${license.licensee} (${license.tier}, ${license.seats} seats).`),
};
