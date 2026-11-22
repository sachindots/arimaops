// Writes the built-in team templates, default names and colour palette that the Rust HQ embeds.
// Run `pnpm gen:team` after changing src/data/templates.ts, names.ts or theme/tokens.ts.
import { writeFileSync } from "node:fs";
import { BUILTIN_TEMPLATES } from "../src/data/templates";
import { LEAD_NAME, WORKER_NAMES } from "../src/data/names";
import { agentPalette } from "../src/theme/tokens";

const out = process.argv[2] ?? "server-rs/crates/arima-server/assets/team-data.json";
writeFileSync(out, `${JSON.stringify({ templates: BUILTIN_TEMPLATES, leadName: LEAD_NAME, workerNames: WORKER_NAMES, palette: agentPalette }, null, 1)}\n`);
console.log(`${BUILTIN_TEMPLATES.length} templates -> ${out}`);
