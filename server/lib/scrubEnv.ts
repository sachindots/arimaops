// Imported first by main.ts: modules copy process.env when they load (TERM_ENV), so it must be clean before them.
import { scrubParentSession } from "./cleanEnv";

export const scrubbedVars = scrubParentSession(process.env);
