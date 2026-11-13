// Built-in ArimaOps skill library + external skills.sh parser.
// Built-in skills are written directly as SKILL.md into .claude/skills/, .agents/skills/,
// and .agent/skills/ (Antigravity), so they work immediately in any workspace without network access.
// External skills formatted as "owner/repo" or "owner/repo@skill-name" come from pinned packs only
// (server/skillPacks.ts): a commit and a hash per skill, scanned before any agent gets them.

import type { SkillSpec } from "./stack";

export interface BuiltinSkill {
  id: string;
  name: string;
  domain: "cybersec" | "research" | "content" | "ops" | "dev";
  description: string;
  body: string;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  // ---------------------------------------------------------------- Core Engineering, Anti-Slop & Token Discipline (Ponystack + Caveman)
  {
    id: "caveman",
    name: "Caveman & Cavecrew: Ultra-Compressed Token-Saving Mode",
    domain: "dev",
    description: "Cuts 65-75% output tokens while preserving 100% technical accuracy. Terse replies and 1-line inter-agent messages.",
    body: `# Caveman & Cavecrew Mode

Respond terse like smart caveman. All technical substance stay. Only fluff die.

## Rules
- **Drop:** articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/happy to), hedging, tool-call narration, decorative tables/emoji, long raw error-log dumps (quote shortest decisive line).
- **Keep:** exact technical terms, code symbols, file:line paths, CLI commands, error strings, and negations (not/never/no/only/except). Standard acronyms OK (DB/API/HTTP); never invent ambiguous abbreviations.
- **Clarity Register:** One idea per sentence (<20 words). Active voice. Imperative instructions ("Run X"). Pattern: \`[thing] [action] [reason]. [next step].\`
- **Tool Calls:** Fire direct. No preamble, plan, or progress note before or between tool calls.

## Cavecrew Inter-Agent & Status Contracts (\`send_message\` / \`set_my_status\`)
- **Builder / Worker status note:** \`<path:line-range> — <change <=10 words>. verified: <test/repro result>.\`
- **Investigator / Recon reply:** \`- path:line — \`symbol\` — short note\` (sorted by file:line).
- **Reviewer reply:** \`path:line: [CRITICAL|MAJOR|MINOR] <problem>. <fix>.\`
- Never send a separate \`send_message\` repeating what \`set_my_status\` already reported to the Lead.

## Auto-Clarity Boundaries
Switch to clear, normal English for:
1. Security warnings & irreversible action confirmations
2. Committed code, comments, commit messages, PR descriptions, and human-facing \`deliverables/\` reports.`,
  },
  {
    id: "ponytail",
    name: "Ponytail: Lazy Senior Dev & Strict YAGNI",
    domain: "dev",
    description: "The best code is code never written. Smallest complete change, stdlib/codebase reuse, zero speculative abstractions.",
    body: `# Ponytail — Lazy Senior Developer Mode

You are a lazy senior developer. The best code is the code never written. Solve the whole problem with the least new code.

## Before You Write
Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users (data loss, exposure, broken callers). That is scope. Extra features are not.

## The Smallest Complete Change
Take the first option that fully works:
1. **Does it need to exist?** Skip features, options, and flexibility nobody asked for.
2. **Already in this codebase?** Reuse existing helpers, components, services, and patterns the way surrounding code does.
3. **Standard library or platform feature?** Use it unless the project has its own canonical helper.
4. **Installed dependency?** Use it. Never add a dependency for a few lines.
5. **Minimum code that works:** The shortest readable diff wins once you know everything it must touch.

## Guardrails
- **Be lazy about the solution, never about the change:** Finish every caller, test, and fixture your change affects.
- **Zero Bloat:** No speculative abstraction, wrapper, pass-through helper, option flag, or "for later" config. Deletion beats addition.
- **Root-Cause Fixes:** Grep every caller of the function you touch and fix the root cause once in shared code.
- **Known Limits:** Mark deliberate shortcuts with \`// shortcut: <the limit>, <when to upgrade>\`.
- **Never Cut:** Validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything the task explicitly asked for.`,
  },
  {
    id: "pstack-architect",
    name: "pstack Architect & Domain Modeling",
    domain: "dev",
    description: "Ground the system, model the domain data shape, sketch types and module boundaries, design twice before coding.",
    body: `# pstack Architect & Domain Modeling

Design before implementing. Sketch types, function signatures, and module boundaries before writing implementation bodies.

## Phases
1. **Ground (\`how\` & \`why\`):** Trace the real control flow, state ownership, and invariants of every subsystem the change touches. Naming a file is not grounding.
2. **Model the Domain:** Encode domain rules in data structures (discriminated unions, state machines, typed registries/tables) instead of scattered boolean flags and ad-hoc conditionals. Make illegal states unrepresentable.
3. **Sketch & Design Twice:** Consider at least two structurally distinct designs. Prefer deep modules (small, simple public interface hiding rich internal logic) over shallow pass-through layers.
4. **Boundary Discipline:** Parse and validate external data at system boundaries; trust internal types and keep core logic pure and idempotent.
5. **Implement & Reconcile (or Scrap):** Fill in implementation against the type sketch. If repeated workarounds, \`any\` casts, or special-case branches appear across unrelated code, scrap the sketch and redesign from first principles—subtract dead weight before adding.`,
  },
  {
    id: "pstack-deslop",
    name: "pstack Deslop, Unslop & No-Comments",
    domain: "dev",
    description: "Eliminate AI code slop (casts, abnormal try/catch, narrating comments, >1k line files) and AI prose tells.",
    body: `# pstack Deslop, Unslop & No-Comments

Remove all AI-generated code slop and prose tells before finishing any task.

## Code Deslop Rules
- **No Narrating Comments:** Delete comments that restate what code does or narrate phases (\`// Phase 1: ...\`). Keep a comment only for a non-obvious *why* the code cannot show, in one line.
- **No Abnormal Defensive Clutter:** Remove redundant \`try/catch\` blocks or fallback guards inside trusted internal code paths that silently swallow errors.
- **Zero Type Escape Hatches:** Eliminate \`as any\`, \`as unknown as T\`, or loose optionality used to bypass type errors. Fix the underlying type contract.
- **Flatten Control Flow:** Replace deeply nested conditionals with early returns or table/dispatcher lookups.
- **1,000-Line Ceiling:** Never push a file past 1,000 lines without decomposing cohesive helpers or sub-modules first.

## Prose Unslop Rules
- **Cut AI Vocabulary:** Never use *delve, pivotal, tapestry, underscore, testament, showcase, fostering, intricate, seamless, leverage, utilize*. Use plain words (*use, help, build, check*).
- **No Superficial \`-ing\` Tails:** Cut trailing participles (*"...ensuring reliability and highlighting performance"*).
- **No Chatbot Filler or Sycophancy:** Never write *"Sure!"*, *"Great question!"*, *"I hope this helps!"*, or em-dash-heavy filler. State facts, mechanisms, and measured numbers directly in active voice.`,
  },
  {
    id: "pstack-blast-radius",
    name: "pstack Blast Radius & Prove-It-Works Verification",
    domain: "dev",
    description: "Find downstream breakage grep misses and prove safety invariants by running real code/tests before declaring done.",
    body: `# pstack Blast Radius & Prove-It-Works

Never trust your own writeup or "it compiles". Prove the change works and verify what it could break downstream.

## Workflow
1. **Find the Single Safety Fact:** Identify the core invariant the change depends on.
2. **Look Where Grep Stops:** Trace beyond direct symbol references—check JSON wire formats, WebSocket payloads, persisted config schemas, DB columns, lifecycle/unmount ordering, and concurrent shared state.
3. **Evidence Ladder (Reach Step 4 or 5):**
   - Step 1: Saying it's safe (worthless).
   - Step 2: Citing \`file:line\`.
   - Step 3: Tracing the failure path step-by-step.
   - Step 4: Running a real test or script that imports and executes the changed code and fails loudly if broken.
   - Step 5: Reproducing and verifying in the live running app/server.
4. **Sequence Verifiable Units:** Verify each unit before moving to the next and record the exact verification command/result in \`set_my_status\`.`,
  },
  {
    id: "pstack-thermo-review",
    name: "pstack Thermo-Nuclear & Ponytail Code Review",
    domain: "dev",
    description: "Strict maintainability and correctness audit: hunt for code-judo simplifications, bugs, scale risks, and bloat.",
    body: `# pstack Thermo-Nuclear & Ponytail Review

Review changes like the senior engineer who will be paged at 3am when it breaks.
Priority order: **1. Correct → 2. Safe → 3. Holds under load → 4. Tested → 5. Fast → 6. Lean**.

## Non-Negotiable Review Standards
1. **Hunt for "Code Judo" Moves:** Don't settle for local nits. Look for structural reframings where whole branches, helpers, flags, or layers disappear entirely.
2. **Block Spaghetti Growth:** Flag ad-hoc \`if\` statements bolted onto busy flows, feature logic leaking into shared modules, thin pass-through wrappers, and files pushed past 1,000 lines.
3. **Concrete Failure Cases Only:** Every finding must state a concrete input or race condition that causes a wrong result, security risk, or maintenance trap—no vague "consider..." nits.
4. **Terse Actionable Output:**
   - Format: \`file:L<line>: [MUST-FIX | SHOULD-FIX | LEAN] <problem>. <smallest fix>.\`
   - End with \`Verdict: Ship\` or \`Verdict: Fix <N> first\`, plus \`Lean: -<N> lines possible\`.`,
  },

  // ---------------------------------------------------------------- Cybersecurity & OSINT
  {
    id: "threat-modeling",
    name: "Threat Modeling & Attack Surface Analysis",
    domain: "cybersec",
    description: "Structured STRIDE/DREAD threat modeling, trust boundary mapping, and attack tree generation.",
    body: `# Threat Modeling & Attack Surface Analysis

## Workflow
1. **Asset & Trust Boundary Mapping:** Enumerate entry points, privilege boundaries, data stores, external integrations, and identity flows.
2. **STRIDE Evaluation:** Analyze Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, and Elevation of Privilege per boundary.
3. **Attack Paths & Prioritization:** Rank findings by exploitability and impact (Critical / High / Medium / Low) with concrete attack scenarios.
4. **Mitigation Matrix:** Provide actionable, verifiable controls and architectural remediations for each finding.`,
  },
  {
    id: "vuln-triage",
    name: "Vulnerability Audit & CWE Triage",
    domain: "cybersec",
    description: "Source-to-sink taint analysis, OWASP/CWE auditing, and remediation verification.",
    body: `# Vulnerability Audit & CWE Triage

## Workflow
1. **Source-to-Sink Tracing:** Trace untrusted inputs across HTTP handlers, CLI args, webhooks, deserializers, and IPC/MCP boundaries to sensitive sinks (shell, SQL, filesystem, SSRF, template rendering, auth checks).
2. **Evidence-Based Reporting:** For every finding, document:
   - Exact file path and line numbers
   - CWE / OWASP classification and severity
   - Minimal reproduction or proof-of-concept trace
   - Minimal, non-breaking remediation diff or control`,
  },
  {
    id: "osint-recon",
    name: "OSINT & Footprint Reconnaissance",
    domain: "cybersec",
    description: "Passive reconnaissance, domain/subdomain footprinting, metadata analysis, and exposure synthesis.",
    body: `# OSINT & Footprint Reconnaissance

## Workflow
1. **Scope & Attribution Discipline:** Operate strictly within authorized scope and passive/public sources unless explicitly instructed otherwise.
2. **Entity & Asset Correlation:** Map domains, endpoints, public repositories, exposed configs, dependencies, and organizational metadata.
3. **Confidence Grading:** Tag every intelligence finding with source provenance and confidence level (\`HIGH\`, \`MEDIUM\`, \`LOW\`).
4. **Intelligence Brief:** Produce a structured markdown dossier with executive summary, asset inventory, exposure risks, and recommended hardening.`,
  },
  {
    id: "red-team-poc",
    name: "Red Team & Exploit Validation",
    domain: "cybersec",
    description: "Adversarial simulation, exploit chain validation, and defensive bypass testing.",
    body: `# Red Team & Exploit Validation

## Workflow
1. **Hypothesis-Driven Testing:** Formulate a clear adversarial hypothesis (e.g. privilege escalation, auth bypass, sandbox escape, injection).
2. **Safe PoC Construction:** Build deterministic, self-contained proof-of-concept scripts or test cases that demonstrate impact without destructive side effects.
3. **Kill-Chain Documentation:** Document prerequisites, step-by-step execution, observable indicators of compromise (IoCs), and exact defensive fixes.`,
  },
  {
    id: "soc-incident-response",
    name: "SOC Triage & Detection Engineering",
    domain: "cybersec",
    description: "Log analysis, IoC extraction, timeline reconstruction, and Sigma/YARA detection rules.",
    body: `# SOC Triage & Detection Engineering

## Workflow
1. **Timeline Reconstruction:** Correlate events, timestamps, actors, processes, and network indicators into a chronological incident timeline.
2. **Root Cause & Blast Radius:** Identify initial access vector, persistence mechanisms, and affected assets.
3. **Detection Engineering:** Write portable detection rules (Sigma, YARA, or structured queries) and containment runbooks to prevent recurrence.`,
  },

  // ---------------------------------------------------------------- Research & Intelligence
  {
    id: "deep-research",
    name: "Deep Technical & Literature Research",
    domain: "research",
    description: "Multi-source synthesis, primary source verification, and structured research dossiers.",
    body: `# Deep Technical & Literature Research

## Workflow
1. **Question Decomposition:** Break the research prompt into falsifiable sub-questions and evaluation criteria.
2. **Primary Source Priority:** Prioritize primary documentation, specifications, benchmarks, and peer-reviewed or canonical sources over secondary summaries.
3. **Comparative Synthesis:** Present trade-off matrices, citations, and explicit unknowns rather than vague generalizations.`,
  },
  {
    id: "fact-checking",
    name: "Claim Auditing & Source Verification",
    domain: "research",
    description: "Line-by-line verification of technical, statistical, and factual claims against primary evidence.",
    body: `# Claim Auditing & Source Verification

## Workflow
1. **Claim Extraction:** Extract every falsifiable claim, metric, date, quote, or technical assertion from the target artifact.
2. **Verification Verdict:** Grade each claim as \`VERIFIED\`, \`PARTIALLY TRUE\`, \`UNSUBSTANTIATED\`, or \`FALSE\` with direct evidence links or file references.
3. **Correction Diff:** Provide exact replacement wording for any inaccurate or overstated claim.`,
  },

  // ---------------------------------------------------------------- Content & Documentation
  {
    id: "technical-writing",
    name: "Technical Documentation & Runbooks",
    domain: "content",
    description: "Clear architecture docs, API references, onboarding guides, and operational runbooks.",
    body: `# Technical Documentation & Runbooks

## Workflow
1. **Verify Before Writing:** Inspect actual code, CLI flags, and configurations so every command and path in the docs is accurate.
2. **Structure for Scannability:** Lead with a concise overview, quickstart commands, architecture diagrams (Mermaid), and troubleshooting tables.
3. **Copy-Paste Ready:** Ensure all code blocks and shell commands are runnable as written.`,
  },
  {
    id: "executive-briefing",
    name: "Executive Briefings & Launch Copy",
    domain: "content",
    description: "High-signal executive summaries, changelogs, release notes, and strategic communications.",
    body: `# Executive Briefings & Launch Copy

## Workflow
1. **Bottom-Line Up Front (BLUF):** Open with the core outcome, decision, or impact in the first paragraph.
2. **Zero Fluff:** Replace buzzwords with concrete metrics, capabilities, and before/after examples.
3. **Audience Calibration:** Tailor depth and framing to the target audience (engineering, security leadership, customers, or stakeholders).`,
  },

  // ---------------------------------------------------------------- Product & Operations
  {
    id: "product-prd",
    name: "Product Specs & PRD Architecture",
    domain: "ops",
    description: "Problem framing, user stories, acceptance criteria, and phased execution plans.",
    body: `# Product Specs & PRD Architecture

## Workflow
1. **Problem & Non-Goals:** Define the exact user problem, success metrics, and explicit non-goals to prevent scope creep.
2. **Edge Cases & Flows:** Specify happy paths, failure states, permissions, and data lifecycle requirements.
3. **Verifiable Acceptance Criteria:** Write testable \`doneWhen\` criteria that engineering or QA can verify deterministically.`,
  },
  {
    id: "data-analysis",
    name: "Quantitative & Data Analysis",
    domain: "ops",
    description: "Dataset exploration, cohort/funnel analysis, statistical validation, and visual reporting.",
    body: `# Quantitative & Data Analysis

## Workflow
1. **Data Hygiene Check:** Inspect schema completeness, null rates, outliers, and sample sizes before drawing conclusions.
2. **Reproducible Queries/Scripts:** Keep all SQL queries, Python/Node analysis scripts, and transformations reproducible in the workspace.
3. **Decision-Oriented Output:** Pair every chart or table with the concrete operational takeaway it supports.`,
  },

  // ---------------------------------------------------------------- Software Engineering
  {
    id: "system-architecture",
    name: "System Architecture & Interface Contracts",
    domain: "dev",
    description: "Modular boundary design, TypeScript/API contracts, data models, and migration safety.",
    body: `# System Architecture & Interface Contracts

## Workflow
1. **Contract-First Design:** Define shared types, schemas, and API boundaries before implementation begins.
2. **Backward Compatibility:** Preserve existing config formats and migration paths unless a breaking change is explicitly required.
3. **Minimal Complexity:** Favor composable modules and clear data flow over premature abstraction.`,
  },
  {
    id: "frontend-design",
    name: "Frontend UI & Interactive Canvas Engineering",
    domain: "dev",
    description: "High-craft UI components, keyboard accessibility, state management, and responsive layouts.",
    body: `# Frontend UI & Interactive Canvas Engineering

## Workflow
1. **Theme & Token Discipline:** Use design tokens from \`src/theme/tokens.ts\` and CSS variables in \`src/index.css\` (Black-Ops Crimson Red + Obsidian Black + Phosphor Green HUD). Never introduce yellow or orange hues.
2. **Accessibility & Keyboard UX:** Maintain ARIA roles, focus states, and keyboard shortcuts across all drawers and modals.
3. **Type & Build Verification:** Run \`pnpm typecheck\` and verify zero regressions across both live and mock data sources.`,
  },
  {
    id: "test-engineering",
    name: "Test Automation & Edge-Case Verification",
    domain: "dev",
    description: "Deterministic unit/integration tests, boundary condition coverage, and regression harnesses.",
    body: `# Test Automation & Edge-Case Verification

## Workflow
1. **Behavior Over Implementation:** Test observable inputs, outputs, state transitions, and error handling rather than internal mocks.
2. **Boundary & Failure Coverage:** Cover empty inputs, malformed payloads, timeouts, permission denials, and race conditions.
3. **Fast & Deterministic:** Never rely on arbitrary sleeps or external network availability in unit tests.`,
  },
  {
    id: "code-review",
    name: "Rigorous Code & Security Review",
    domain: "dev",
    description: "Correctness, concurrency, type safety, security, and performance auditing.",
    body: `# Rigorous Code & Security Review

## Workflow
1. **Scope & Contract Check:** Verify the changes satisfy \`doneWhen\` and stay within the assigned file boundaries.
2. **Bug & Regression Hunt:** Check for unhandled rejections, null/undefined edge cases, resource leaks, and subtle state desynchronization.
3. **Actionable Feedback:** Provide exact file:line citations and concrete fix suggestions categorized by severity (\`BLOCKER\`, \`MAJOR\`, \`MINOR\`).`,
  },
];

export const findBuiltinSkill = (id: string): BuiltinSkill | undefined =>
  BUILTIN_SKILLS.find((s) => s.id === id.trim().toLowerCase());

/**
 * Parses an agent's skill entries into:
 * - `builtin`: built-in ArimaOps skills written directly to disk
 * - `external`: external `npx skills add` specs ("owner/repo@skill" or "owner/repo")
 * - `custom`: freeform skill names that generate a tailored SKILL.md stub if not in BUILTIN_SKILLS
 */
export function classifyAgentSkills(rawSkills: string[]): {
  builtin: BuiltinSkill[];
  external: SkillSpec[];
  custom: BuiltinSkill[];
} {
  const builtin: BuiltinSkill[] = [];
  const custom: BuiltinSkill[] = [];
  const extMap = new Map<string, Set<string>>();
  const seenBuiltin = new Set<string>();

  for (const raw of rawSkills) {
    const entry = raw.trim();
    if (!entry) continue;

    // External skill format: "owner/repo@skill" or "owner/repo"
    const extMatch = entry.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_.-]+))?$/);
    if (extMatch) {
      const [, source, skillName] = extMatch;
      const set = extMap.get(source) ?? new Set<string>();
      if (skillName) set.add(skillName);
      extMap.set(source, set);
      continue;
    }

    const slug = entry.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (!slug || seenBuiltin.has(slug)) continue;
    seenBuiltin.add(slug);

    const found = findBuiltinSkill(slug);
    if (found) {
      builtin.push(found);
    } else {
      custom.push({
        id: slug,
        name: entry,
        domain: "dev",
        description: `Specialized agent skill for ${entry}.`,
        body: `# ${entry}\n\nApply best practices, rigorous verification, and domain expertise for **${entry}** when executing assigned tasks.`,
      });
    }
  }

  const external: SkillSpec[] = [...extMap.entries()].map(([source, skills]) => ({
    source,
    skills: skills.size ? [...skills].sort() : ["*"],
  }));

  return { builtin, external, custom };
}

/** Formats a BuiltinSkill as a SKILL.md file with YAML frontmatter compatible with Claude Code, Codex, and Antigravity (agy). */
export function renderSkillMd(skill: BuiltinSkill): string {
  return [
    "---",
    `name: ${skill.id}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}
