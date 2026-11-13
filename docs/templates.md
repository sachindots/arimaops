# Templates, skills and methods (Phase 4)

The four launch templates, the skills their roles get, how those skills are fetched safely, and how templates are shared and improved. Builds on the Phase 1 model (`docs/core-model.md`: templates, roles, flows, gates, findings), the Phase 2 memory (`docs/memory-core.md`) and the Phase 3 engine (`docs/agent-engine.md`). Status: **design, 2026-11-13**; the owner's decisions are in section 10.

## 1. What changes

| Today (end of Phase 3) | After Phase 4 |
|---|---|
| Two built-in templates: Dev (build → review) and Blank | Dev v2 plus Security Red, Purple and Blue, Research, Marketing and Sales; Blank stays |
| A role's `owner/repo` skill is installed with `npx skills add` at whatever is latest, unscanned | Third-party skills come only from **pinned packs**: an exact commit, a content hash, and a scan before anything reaches an agent |
| Templates live in the HQ database only | Save and import as JSON, checked like a built-in |
| What a project learns stays in that project | Certified lessons can be promoted into the template, masked, rewritten and approved by the owner |
| No way to compare runs | A benchmark harness: the same sample project, the same metrics, run to run |

## 2. Skill packs: pinned, hashed, scanned (4.1)

**Why.** `classifyAgentSkills` sends any `owner/repo` entry to `npx skills add`, which fetches the repo's current state, runs an npm package to do it, and copies whatever it gets into every agent's folder. One renamed or compromised repo (the roadmap already rejected one with hidden "send secrets" characters) reaches every agent at its next start.

**The pin file.** `skill-packs.lock.json` at the repo root, shipped with HQ (the existing `skills-lock.json` belongs to the owner's own `npx skills` dev setup and stays as it is):

```json
{ "version": 1, "packs": {
  "trailofbits/skills": { "commit": "e4dd0bb…", "sha256": "<tree hash>", "licence": "CC-BY-SA-4.0",
                          "credit": "Trail of Bits", "use": "any" },
  "elementalsouls/Claude-BugHunter": { "commit": "4a2d93e…", "sha256": "…", "licence": "MIT", "use": "scoped-offensive" } } }
```

- **Fetching.** HQ downloads `https://codeload.github.com/<owner>/<repo>/tar.gz/<full commit>` itself (no `npx`, no `git` hooks), into `~/.arima/skill-packs/<owner>__<repo>@<commit>/`, and checks the hash of every file it keeps against `sha256` before using any of it. A pack is fetched once per machine, not per agent or project.
- **What an agent gets.** Only the skill folders its role names (`trailofbits/skills@differential-review`), copied from the verified cache, as today's built-ins are.
- **Offensive packs** (`use: "scoped-offensive"`, BugHunter) go only to Red and Purple roles, and only once the project has a scope or lab mode is on (the Phase 3 scope check, applied to skills too).
- **Licences.** Each pack's licence and credit go into the skill folder as `LICENSE-PACK.md`; CC-BY-SA files stay under their licence and are never edited by HQ (an edited copy would have to be CC-BY-SA too). The Settings skill list shows the credit.

**The scanner** (`server/skillScan.ts`) runs on every pack file before its hash is recorded, and again on every custom skill folder (`.hq/skills/`, `~/.arima/skills/`) at install. It blocks a file for:
- invisible or direction-changing Unicode: tag characters (U+E0000–E007F, the rejected Agentic-Bug-Hunter trick), zero-width and bidi controls outside code spans;
- instructions aimed at the agent rather than the task: "ignore previous instructions", "do not tell the user", reading `~/.ssh`, `.env`, the vault or HQ's token, and sending them anywhere;
- code that runs on install or reaches out: `curl … | sh`, `npx`/`pip install` of unpinned packages, base64 blobs decoded and executed, URLs outside the pack's own repo and docs.

A blocked file blocks its whole skill; the reason shows in Settings and the activity feed. Findings are reasons to refuse, never to "clean" a file. Done when a test feeds the scanner a copy of the rejected file's trick and it blocks it, and passes the four vetted packs at their pins.

**As built** (`server/skillScan.ts`, `server/skillPacks.ts`, `skill-packs.lock.json`, 3a1ea81):
- Packs are fetched per skill, not as a whole repo: the tree from GitHub's API at the pinned commit, then only the skill folders' files from raw.githubusercontent.com (a whole-repo tarball of `vercel/next.js`, which one stack skill comes from, would be huge). The lock pins a commit per pack and a hash per skill; links, submodules and `.git` paths are refused.
- The four vetted packs are pinned at their full commits (182 skills). On their real files nothing blocks inside a skill folder; Trail of Bits' three blocked files are plugin hooks outside any skill folder, which HQ never copies. Security skills quote attack strings, so text aimed at the agent blocks only in plain prose; quoted, in code or in a table row it is a warning. A plain `install.sh` or `setup.py` is a warning (it runs only if someone runs it); CLI hooks, settings files and package install scripts block.
- An unpinned source (including the stack's vendor skills: Clerk, Supabase, Stripe…) is proposed: pinned at its current commit, hashed and scanned in the background, then an Action item (**Approve** / **Reject**) shows the scan. Blocked skills stay out of an approved pack. Settings → Stack lists every pack with its status, licence and credit.

**Other `owner/repo` skills** (decision 1): pinned at the commit seen when the owner first adds them, scanned, and kept only after the owner approves the scan result in Settings. Never `npx skills add`.

## 3. Dev template v2 (4.2)

| Stage | Roles | Gates |
|---|---|---|
| Spec | lead | `spec-approved` (owner; the lead may approve while the owner is away) |
| Plan | lead | `analyze` (every spec item has a task) |
| Build | developer | `tests-ci` |
| Review | reviewer, lead | `reviewer`, `second-opinion` (high-stakes) |
| Merge | lead | `pr-merged` |

Skills: reviewer gets Cloudflare `security-audit` and ToB `differential-review`, `sharp-edges`, `insecure-defaults`, `supply-chain-risk-auditor`; developers get ToB `property-based-testing` and the language pack for the stack. The Anthropic security-review GitHub Action is offered (not installed) as a workflow file the owner adds to the repo. A Gemini (`agy`) seat, `second-opinion` role, 1 seat, on demand. v1 projects keep their copy; re-sync is on purpose.

**As built:**
- **The board's spec is approved once.** A written spec files an Action item with its text (**Approve** / **Send back**); approving marks that version of the board's spec approved, so every task on the board passes its spec gate until the spec changes. A newer version replaces a request still open and can't be overtaken by approving an old one. (The browser has no spec view yet; the item carries the text.)
- **Assigning moves a task out of the lead's own stages.** A task in Spec or Plan assigned to a developer moves to Build if the gates it leaves pass (approved spec, every item covered); otherwise the error says what's missing. A task in a worker's stage never jumps ahead because someone else is assigned.
- **The second opinion is asked for.** When a task goes into review and the flow wants a second opinion on it (here: high-stakes), HQ messages a seat whose model comes from another maker (the Gemini seat first) and starts it on demand. A seat's maker comes from its model name when it says (agy and OpenCode run several makers' models), else from its CLI.
- **Security review on PRs:** Settings → Workflow shows the workflow file to copy, pinned to the vetted commit (and `actions/checkout` to a commit); HQ never commits it. It runs on the repo's own `CLAUDE_API_KEY` secret.
- Dev v1 stays as `DEV_TEMPLATE_V1` for projects made from it (and for tests); the library now has v2. The language pack per stack (`modern-python`, `rust-review`…) isn't added yet: the stack has no language field.

## 4. Security templates (4.2)

All three: `rules.findings`, `scopeRequired` (lab mode lifts it), `plans` (an agent submits a plan and waits before changing a system), memory types below. Every finding is scored CVSS 4.0 and SSVC (Phase 1 schema); critical and high findings and the final report need a `second-opinion`. Reports export as PDF, Markdown, HackerOne, Bugcrowd, JSON and SARIF (Phase 1 `reports.ts`).

| Template | Stages (PTES / NIST) | Roles | Memory types |
|---|---|---|---|
| **Red** | Scope (`scope-set`) → Recon → Threat model → Vulnerability analysis → Exploitation → Post-exploitation → Report (`findings-report`, WSTG coverage) | lead, recon, exploit (2), reporter | Asset, Finding, Technique |
| **Purple** | Red's stages, plus Detect after Exploitation: each finding gets its ATT&CK ↔ D3FEND mapping and a detection check (Atomic Red Team test where one exists) | Red's + defender | + Detection |
| **Blue** | Prepare → Detect & analyse → Contain (`owner-approval: containment`) → Eradicate & recover → Lessons learned | lead, analyst (2), responder | Incident, Asset |

Skills per the vetted list (roadmap): BugHunter for red/lead (scoped only), ToB audit set and Cloudflare for blue/purple/code audit.

**As built** (`src/data/securityTemplates.ts`):
- Roles: lead (Claude Opus), recon (Gemini through agy, research), exploit ×2 (Claude Sonnet), reporter (Claude Sonnet), defender in Purple, analyst ×2 and responder in Blue, and a Gemini second-opinion seat in all three. Every skill they name is a built-in or pinned in a vetted pack (a test checks); BugHunter only in Red and Purple, and agents get it only once a scope is set.
- A task can be created straight into its phase (`create_task stageId`), through the gates before it: without a scope nothing leaves Scope or Prepare.
- Purple's Detect stage is a `reviewer` gate for the defender role: a task leaves Exploitation only after the defender maps its findings to ATT&CK ↔ D3FEND and checks the detection.
- The findings report also holds until every critical and high finding is verified by a person or by a model from another maker than its reporter's (the second opinion on severe findings).
- Lists name an office by its own sign, else by the project's name (`officeLabel`): the brand sign and the old ".HQ" said nothing about which project it was.

## 5. Research template (4.2)

Stages: Sources (a PRISMA-style log: every source searched, kept or dropped and why) → Claims (each claim linked to sources) → Fact-check (`reviewer` by the fact-checker role, someone other than the writer) → Report (`second-opinion`). Memory types: Source, Claim. Roles: lead, researcher (2), fact-checker. Paper search through free, keyless APIs (decision 3), added to the container egress allowlist (`rules.egress`); the open web through the CLIs' own search. A claim without a source fails the fact-check gate.

As built (`src/data/researchTemplate.ts`):
- Roles: lead (Claude Opus), researcher ×2 (agy Gemini), fact-checker (Claude Sonnet), second opinion (Codex). The researchers, the fact-checker and the second opinion are three different makers, so a check is never the same model reading its own work.
- Stages: `sources` (lead, researcher) → `claims` (researcher) → `factcheck` (`reviewer` gate, role fact-checker) → `report` (`file-delivered`, `second-opinion` always). Deliverables, not PRs. Starter board "Question".
- New built-in skill `paper-search`: arXiv, OpenAlex and Crossref queries with their polite limits, and the log format in `deliverables/sources.md` (Q searches, S sources kept, X dropped and why; claims cite `[S7]`).
- `rules.egress` (`export.arxiv.org`, `arxiv.org`, `api.openalex.org`, `api.crossref.org`, `doi.org`) now reaches every seat: the sbx network rules and the container proxy both add the template's egress to the agent's own allowlist.
- Limits: "a claim without a source fails" is the fact-checker's job (its role text), not a deterministic check on claims.md. Other hosts still go through the per-host access request in container mode.

## 6. Marketing and Sales templates (4.2)

`rules.outbound: "drafts-only"`, enforced, not just written in the role text:
- no email, CRM or social MCP servers can be attached in these projects (the MCP settings refuse them by name and category);
- the container egress allowlist has no mail or social hosts;
- drafts are deliverables (`file-delivered`), and the last gate is `owner-approval: outbound`, which the lead can never pass. The owner sends by hand.

| Template | Stages | Memory types |
|---|---|---|
| Marketing | Jobs-to-be-Done brief → Drafts (checked against the brief) → Owner approval | Audience, Campaign |
| Sales | MEDDICC qualification → Outreach drafts → Owner approval | Lead, Account |

As built (`src/data/commsTemplates.ts`, `src/data/outbound.ts`):
- **Marketing:** lead (Claude Opus), copywriter ×2 (Claude Sonnet), editor (agy Gemini, another maker). `brief` (lead) → `drafts` (`file-delivered`, `reviewer` by the editor) → `approval` (`owner-approval: outbound`). Starter board "Campaigns".
- **Sales:** lead, account researcher ×2 (agy Gemini), outreach writer (Claude Sonnet). `qualify` (lead, researcher) → `outreach` (`file-delivered`, `reviewer` by the lead) → `approval` (`owner-approval: outbound`). Starter board "Accounts".
- New built-in skills: `jtbd-brief`, `copywriting` (drafts only, sources for every claim) and `meddicc-qualification` (public, professional sources only).
- **Enforcement of drafts only:**
  - `OUTBOUND_HOSTS`: mail APIs and SMTP, social networks, chat and CRM/outreach APIs. Also any host named `smtp.`, `mail.`, `imap.`, `pop.` or `mx.`.
  - The container proxy refuses them on every port, before the scope or allow lists, and files no access request. That covers `gmail.googleapis.com` even though `*.googleapis.com` is in the base allowlist.
  - The sbx rules add them as deny rules for every seat and drop them from the allow lists. The owner's Allow on a blocked request for one of them is refused.
  - `request_access` tells the agent to write a deliverable instead.
  - MCP servers whose name or URL is a mail, social or CRM service aren't added or attached.
- **The owner's approval:** when the only gates left on a task are owner approvals (outbound, containment or merge), HQ files one Action item per gate, of kind `gate`, with Approve and Send back buttons. It's filed once, and only after the editor or the lead has accepted the draft. Approve records the gate as passed by the owner and tells the lead and the writer to finish the task. Blue's containment gate uses the same item.
- **Limits:**
  - A Local-mode agent runs outside any sandbox, so none of the network rules apply to it.
  - The MCP check goes by the server's name and URL, because sbx doesn't say what a server does.
  - The host list is a list. A service that isn't on it is caught only by the per-host access request.

## 7. Save and import (4.4)

- **Export** (Settings → Team → template menu): the project's template copy as JSON (`arimaops-template` v1: the `TeamTemplate` plus its pinned packs), no secrets, no seats, no project data.
- **Import:** checked by `validateTemplate` (Phase 1) plus the packs it names: a pack missing from `skill-packs.lock.json` goes through the owner's add-and-scan step (section 2) before the template can be used. Saved to the library under a new id; nothing runs until a project uses it.
- Done when a template exported from one HQ imports on a fresh one and makes the same team and flow.

As built (`src/data/templateFile.ts`, `server/templateIO.ts`):
- **Save as file** (Settings → Team → Template file) downloads `<id>.arimaops-template.json` on the device that asked: `{format: "arimaops-template", v: 1, exportedAt, template, packs}`. `template` keeps only a TeamTemplate's own fields. `packs` pins each pack the roles name, with this HQ's commit and the hashes of the skills used.
- **Import a template…** is in the welcome and in Settings → Team. It's owner-only, and from a remote device it asks for the authenticator code.
  - The file is checked: 512 KB at most, the format and version, `templateErrors`, a hash for every pack skill used. Unknown fields and pins for unused packs are dropped.
  - Packs:
    - **Vetted here:** used at this HQ's vetted commit, noted when it differs from the file's.
    - **Already approved here:** must be at the same commit.
    - **Rejected here:** refuses the file.
    - **New:** fetched at the file's commit (not the newest), and each skill's hash compared with the file's. A mismatch refuses the import and leaves nothing behind. When the hashes match, the pack is scanned and waits for the owner in Action items.
  - Saved under a new id (`marketing-2`). It never overwrites, and a built-in keeps its own.
- **Using it:** `copyToProject` refuses any template with a pack that isn't usable yet, saying which. The welcome lists the library (built-ins in their order, then the owner's), marks the owner's templates "yours · vN" and the ones waiting on the owner "waits for you", and disables Create team for those.
- Checked: 25 checks in `scripts/template-file-test.ts`, and live: a Marketing template saved from one throwaway HQ and imported on a fresh one made the same team (lead, 3 copywriters, editor).

## 8. Lesson promotion (4.5)

- **What:** certified Lessons, Decisions and Dead ends from a project, offered to its template's library copy, so the next project from that template starts with them in its briefs.
- **How:** `cleanMemory` (secrets, personal data, keep-out names), then a Haiku rewrite that removes the project's specifics (hosts, IPs, names, product names, paths outside the stack), then the owner approves each in Action items. Stored in the template as `lessons` (text and type only, no project id).
- **Off by default for security engagements** (any template with `rules.findings`): a lesson from a client's network must never leak into the next client's brief. The owner can switch it on per project.
- Haiku runs only once the owner turns it on (as with Phase 2 extraction) and counts toward spend caps on API-key accounts.
- Done when a test feeds lessons full of hosts, IPs, names and keys, and none survives promotion.

As built (`server/lessons.ts`, `server/lessonPromotion.ts`):
- **Where they live:** in the `template_lessons` table (migration 9), keyed by the library template id, not inside the template body. Built-ins are rewritten from code on every HQ update, so a body field would be lost. No project id is stored, only a hash of project and memory id, so each memory is tried once. A rewrite that fails the check is kept as `dropped`, without its text, so it isn't paid for again.
- **Run:** Settings → Memory → Lessons for the template → **Offer lessons now** (owner only, authenticator code from a remote device). It needs memory extraction on and uses the same account through the metered runner, so it counts toward spend caps.
  1. Only certified Lessons, Decisions and Dead ends are taken, at most 30 per run.
  2. `cleanMemory` masks secrets, vault values, emails, keep-out names and public IPs before Haiku sees the text.
  3. Haiku rewrites each lesson, or gives up on it.
  4. The rewrite is cleaned again, then **refused** if `specificsIn` still finds a URL, an email, an IP (local ones too), a host on a common TLD, an absolute or home path, a mask, or one of the project's own words (id, name, repo, office sign, scope entries, keep-out names). Conventional file names like `middleware.ts` pass.
  5. Each survivor is an Action item of kind `lesson`: Approve or Reject.
- **Briefs:** up to 8 approved lessons, dead ends first, are added to the Memory section of every brief in projects made from that template, even while Neo4j is down. Settings lists the approved ones, and you can remove any.
- **Security engagements:** off by default (`project.promoteLessons`, missing = `!rules.findings`). The owner can switch it on per project.
- **Checked:** 19 checks in `scripts/lessons-test.ts`. Lessons full of hosts, IPs, URLs, names, keys, a vault value and paths go through three fake models: one that changes nothing, one that slips specifics back in, and one that rewrites well. No sensitive value survives any of them.
- **Not checked:** a real Haiku run (paid, waiting for the owner's go-ahead).
- **Limit:** a product or company name that isn't one of the project's own words can only be caught by Haiku or by you at approval.

## 9. Benchmarks (4.3)

- **Harness** (`scripts/bench/`): a benchmark is a template, a sample project (a repo or a target), a fixed brief and a time and spend limit. A run records findings (matched against the target's known list), cost, time, gate rejections and replans, as JSON, and compares to the last run.
- **Security targets** (decision 2): OWASP Juice Shop, DVWA and crAPI as local Docker containers on an isolated network, the project in lab mode with the target as its only scope entry; code-audit repos with published CVEs at the vulnerable commit.
- **Other templates:** 3–5 practice projects each (a small app for Dev, a question with a known answer set for Research, a product brief for Marketing and Sales).
- Every run uses real models and costs money: the harness never starts one without the owner's go-ahead per run.

## 10. Owner's decisions (2026-11-13)

1. **Other `owner/repo` skills are pinned at first add, scanned, and kept only after the owner approves the scan.** `npx skills add` goes.
2. **Benchmarks run on the laptop**, targets in local Docker on an isolated network, lab mode, each paid run asked first.
3. **Paper search uses arXiv, OpenAlex and Crossref** (free, no keys).
4. **The four vetted packs may be downloaded** from GitHub at their pinned commits during step 2.

## 11. Work order

1. This design and the owner's decisions.
2. Skill scanner and pinned packs; `npx skills add` replaced (section 2).
3. Dev template v2 (section 3).
4. Security templates: Red, Purple, Blue (section 4).
5. Research template (section 5).
6. Marketing and Sales, drafts only (section 6).
7. Save and import (section 7).
8. Lesson promotion (section 8).
9. Benchmark harness (section 9).
10. Demo on a throwaway HQ, tablet check, evidence in HANDOFF.

Not checked locally without the owner's go-ahead: real benchmark runs (paid) and the Haiku rewrite in lesson promotion (paid).
