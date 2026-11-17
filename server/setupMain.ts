// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry for `arimaops setup` (bin/arimaops.mjs), bundled on its own so it never starts HQ.
import { setupCli } from "./setupCli";

await setupCli(process.argv.slice(2));
process.exit(0);
