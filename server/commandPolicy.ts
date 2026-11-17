// Every browser command, in one table: the lowest role that may run it, whether a remote device needs a
// fresh authenticator code first, and the arguments it takes. The WebSocket checks all three before a
// handler runs, and server/commands.ts must have a handler for each name here (and none that isn't).
//
// Limits here are abuse caps, not product rules: handlers still trim to their own lengths.

import { z } from "zod";
import type { AgentMode } from "../src/data/types";

export type Role = "viewer" | "operator" | "owner";
const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 };

/** What a policy may look up about the project to decide (only what it needs). */
export interface PolicyContext {
  agentMode(id: string): AgentMode | undefined;
}

interface Entry<S extends z.ZodTuple> {
  role: Role;
  stepUp?: boolean;
  args: S;
  /** Arguments that make this call the owner's (it would reach the host). */
  ownerIf?: (args: z.infer<S>, ctx: PolicyContext) => boolean;
}
const entry = <S extends z.ZodTuple>(e: Entry<S>) => e;

const id = z.string().max(200);
const text = (max: number) => z.string().max(max);
const num = z.number().finite();
const flag = z.boolean();
/** An object with its own validator in the handler (templates, forms, account input). */
const obj = z.record(z.string(), z.unknown());
const opt = <T extends z.ZodType>(t: T) => t.nullish(); // JSON turns a missing trailing arg into null
const mode = z.enum(["local", "sandbox", "container"]);
const agentPatch = z.looseObject({ mode: z.unknown().optional(), workspacePath: z.unknown().optional() });
const projectPatch = z.looseObject({ crossProject: z.unknown().optional() });

/** A terminal that isn't a sandboxed or container agent's own is a shell on this machine. */
const hostTerminal = (term: string, ctx: PolicyContext) => {
  const m = ctx.agentMode(term);
  return !m || m === "local";
};

export const COMMANDS = {
  // Terminals and sessions
  sendTerminalInput: entry({ role: "operator", stepUp: true, args: z.tuple([id, text(100_000)]), ownerIf: ([term], ctx) => hostTerminal(term, ctx) }),
  resizeTerminal: entry({ role: "operator", args: z.tuple([id, num, num]) }),
  openShell: entry({ role: "owner", stepUp: true, args: z.tuple([id]) }),
  closeShell: entry({ role: "operator", args: z.tuple([id]) }),
  openHostShell: entry({ role: "owner", stepUp: true, args: z.tuple([text(4096), opt(flag)]) }),
  closeHostShell: entry({ role: "operator", args: z.tuple([]) }),
  forwardPort: entry({ role: "operator", stepUp: true, args: z.tuple([id, num]) }),
  unforwardPort: entry({ role: "operator", args: z.tuple([id, num]) }),
  startAgent: entry({ role: "operator", args: z.tuple([id]) }),
  stopAgent: entry({ role: "operator", args: z.tuple([id]) }),
  openWorkspace: entry({ role: "operator", args: z.tuple([id]) }),
  inspectWorkspace: entry({ role: "operator", args: z.tuple([id]) }),
  recreateSandbox: entry({ role: "operator", stepUp: true, args: z.tuple([id]) }),
  recheckSetup: entry({ role: "viewer", args: z.tuple([]) }),
  runSetupFix: entry({ role: "owner", stepUp: true, args: z.tuple([text(64)]) }),

  // Work
  assignTask: entry({ role: "operator", args: z.tuple([id, id]) }),
  updateFinding: entry({ role: "operator", args: z.tuple([id, obj]) }),
  recordGate: entry({ role: "operator", stepUp: true, args: z.tuple([id, id, text(20), opt(text(4000))]) }),
  setTaskRunsOn: entry({ role: "operator", args: z.tuple([id, opt(text(40)), opt(text(200))]) }),
  sendMessage: entry({ role: "viewer", args: z.tuple([id, text(100_000)]) }),
  createBoard: entry({ role: "operator", args: z.tuple([text(500)]) }),
  updateBoard: entry({ role: "operator", args: z.tuple([id, obj]) }),
  resolveActionItem: entry({ role: "operator", stepUp: true, args: z.tuple([id, text(20), opt(text(10_000))]) }),
  addToSuite: entry({ role: "owner", stepUp: true, args: z.tuple([id]) }),

  // Team and template
  addAgent: entry({ role: "operator", args: z.tuple([obj]), ownerIf: ([input]) => input.mode === "local" }),
  updateAgent: entry({
    role: "operator",
    stepUp: true,
    args: z.tuple([id, agentPatch]),
    // A seat's own folder, or Local mode, runs it on this machine.
    ownerIf: ([, p]) => p.workspacePath !== undefined || p.mode === "local",
  }),
  removeAgent: entry({ role: "operator", stepUp: true, args: z.tuple([id, opt(obj)]) }),
  setTeamMode: entry({ role: "operator", stepUp: true, args: z.tuple([mode]), ownerIf: ([m]) => m === "local" }),
  updateRole: entry({ role: "operator", stepUp: true, args: z.tuple([id, obj]) }),
  updateProjectTemplate: entry({ role: "operator", stepUp: true, args: z.tuple([obj]) }),
  resyncTemplate: entry({ role: "operator", stepUp: true, args: z.tuple([]) }),
  exportTemplate: entry({ role: "operator", args: z.tuple([]) }),
  importTemplate: entry({ role: "owner", stepUp: true, args: z.tuple([text(2_000_000)]) }),
  saveTemplate: entry({ role: "operator", stepUp: true, args: z.tuple([obj]) }),
  promoteLessons: entry({ role: "owner", stepUp: true, args: z.tuple([]) }),
  setLessonPromotion: entry({ role: "owner", stepUp: true, args: z.tuple([flag]) }),
  removeLesson: entry({ role: "owner", stepUp: true, args: z.tuple([id]) }),
  proposeImprovements: entry({ role: "owner", stepUp: true, args: z.tuple([]) }),
  completeWelcome: entry({ role: "operator", args: z.tuple([obj]) }),

  // Sandboxes, keys and tools
  updateSandbox: entry({ role: "operator", stepUp: true, args: z.tuple([id, obj]) }),
  setSecret: entry({ role: "operator", stepUp: true, args: z.tuple([z.string().max(200).nullable(), text(40), text(20_000)]) }),
  removeSecret: entry({ role: "operator", stepUp: true, args: z.tuple([z.string().max(200).nullable(), text(40)]) }),
  setProxy: entry({ role: "owner", stepUp: true, args: z.tuple([z.string().max(2000).nullable()]) }),
  openEnvFile: entry({ role: "operator", stepUp: true, args: z.tuple([id]) }),
  refreshSbx: entry({ role: "viewer", args: z.tuple([]) }),
  answerApproval: entry({ role: "operator", stepUp: true, args: z.tuple([id, id, text(20)]) }),
  resolveAccess: entry({ role: "operator", stepUp: true, args: z.tuple([id, text(20)]) }),
  refreshMcp: entry({ role: "viewer", args: z.tuple([]) }),
  addMcp: entry({ role: "owner", stepUp: true, args: z.tuple([obj]) }),
  authMcp: entry({ role: "operator", stepUp: true, args: z.tuple([id]) }),
  removeMcp: entry({ role: "operator", stepUp: true, args: z.tuple([id]) }),
  setAgentMcp: entry({ role: "operator", args: z.tuple([id, z.array(text(200)).max(200)]) }),
  updateStack: entry({ role: "operator", args: z.tuple([obj.nullable()]) }),

  // Machine-wide: accounts, memory, money, GitHub
  saveAccount: entry({ role: "owner", stepUp: true, args: z.tuple([obj]) }),
  removeAccount: entry({ role: "owner", stepUp: true, args: z.tuple([id]) }),
  setMemoryExtraction: entry({ role: "owner", stepUp: true, args: z.tuple([obj]) }),
  decideMemories: entry({ role: "operator", stepUp: true, args: z.tuple([id, obj]) }),
  keepOutOfMemory: entry({ role: "operator", args: z.tuple([text(1000)]) }),
  setLabMode: entry({ role: "owner", stepUp: true, args: z.tuple([flag]) }),
  setSpendCaps: entry({ role: "owner", stepUp: true, args: z.tuple([obj]) }),
  finishGithubApp: entry({ role: "owner", stepUp: true, args: z.tuple([text(200)]) }),

  // Project settings
  updateWorkflow: entry({ role: "operator", stepUp: true, args: z.tuple([obj]) }),
  updateProject: entry({ role: "operator", stepUp: true, args: z.tuple([projectPatch]), ownerIf: ([p]) => p.crossProject !== undefined }),
};

export type CommandName = keyof typeof COMMANDS;
export type CommandArgs<K extends CommandName> = z.infer<(typeof COMMANDS)[K]["args"]>;
/** server/commands.ts satisfies this: one handler per command, with typed arguments. */
export type Handlers = { [K in CommandName]: (...args: CommandArgs<K>) => unknown };

export type Verdict =
  | { ok: true; name: CommandName; args: unknown[] }
  | { ok: false; why: "unknown" | "bad-args" | "role" | "step-up" };

export const isCommand = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

/** Whether `who` may run `name` with `args` now. A refused call never reaches its handler. */
export function authorize(name: string, args: unknown[], who: { role: Role; remote: boolean; elevated: boolean }, ctx: PolicyContext): Verdict {
  if (!isCommand(name)) return { ok: false, why: "unknown" };
  const e = COMMANDS[name] as Entry<z.ZodTuple>;
  const parsed = e.args.safeParse(args);
  if (!parsed.success) return { ok: false, why: "bad-args" };
  const need: Role = e.ownerIf?.(parsed.data, ctx) ? "owner" : e.role;
  if (RANK[who.role] < RANK[need]) return { ok: false, why: "role" };
  if (who.remote && e.stepUp && !who.elevated) return { ok: false, why: "step-up" };
  return { ok: true, name, args: parsed.data as unknown[] };
}

/** Commands a remote device must confirm with an authenticator code (the UI names them in its prompt). */
export const needsStepUp = (name: string) => isCommand(name) && !!COMMANDS[name].stepUp;
