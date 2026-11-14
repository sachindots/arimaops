# ArimaOps architecture

How the code is laid out, where the security boundaries are, and how it grows into an open-core product with API keys, teams and paid features. Read this before adding a module.

## 1. The shape today

One Node process (the **HQ server**) runs every project on a machine. Each project has a team of AI agents. Every agent is a real CLI (Claude Code, Codex, Antigravity, Gemini CLI…) running in its own tmux session, folder and, optionally, container. Browsers, the tablet and the phone are views of that server.

```
 browser / tablet / phone (React UI)
        │  WebSocket /ws?project=…   (snapshot + events; commands back)
        │  WebSocket /ws?…&watch=1   (read-only feed of another project, for the building)
        ▼
 HQ server ─── one Runtime per project ─── Hub (state + events)
        │                                   ├─ Planner (boards, tasks, briefs, stalls)
        │                                   ├─ Inbox (what gets typed into agents)
        │                                   ├─ Sessions (start/stop CLIs, watch screens)
        │                                   └─ GitHubSync, Findings, ActionItems…
        │
        ├─ /hook/<agent>/<event>   CLI hooks report what agents do (agent token)
        ├─ /mcp                    Team MCP: agents' tools (tasks, messages, findings)
        └─ machine-wide: projects registry, account limits, agent cap, port blocks
```

### Server (`server/`)

| Area | Files | Owns |
|---|---|---|
| Entry and HTTP | `main.ts`, `http.ts`, `remote.ts` | Starting projects, routes, WebSocket auth, roles, the remote TOTP step-up |
| One project | `project.ts`, `hub.ts`, `store.ts` | Wiring a project's parts; its state and event bus; saving config and plan |
| Agents | `sessions.ts`, `adapters.ts`, `agentFiles.ts`, `backends/*`, `workspace.ts` | Launching each CLI, its settings and role text, its folder, its terminal |
| Isolation | `containers.ts`, `sbx.ts`, `sbxMcp.ts`, `lib/cleanEnv.ts` | Container and sandbox modes, egress allow-lists, a clean environment |
| Team work | `planner.ts`, `inbox.ts`, `mcp.ts`, `hooks.ts`, `loopguard.ts`, `facts.ts`, `usage.ts` | Tasks and briefs, delivery, agent tools, hook events, lean mode |
| Code flow | `github.ts`, `githubSync.ts`, `repo.ts` | PRs, reviews, merges |
| Security work | `scope.ts`, `findings.ts` | Engagement scope, findings and the report |
| Machine-wide | `projectsRegistry.ts`, `accounts.ts`, `ports.ts`, `paths.ts` | All projects; shared usage limits and the RAM cap; per-agent port blocks; where files live |

### UI (`src/`)

| Area | Files |
|---|---|
| Data in | `data/ws/wsSource.ts` (live), `data/mock/*` (demo), `store/office.ts` (one project), `store/building.ts` (other projects, read-only) |
| Shared types | `data/types.ts` (the contract between server and UI; change it on both sides) |
| Desktop | `ui/hud/*` (top bar, team, activity), `ui/drawers/*`, `ui/settings/*` |
| Phone / tablet | `ui/compact/CompactApp.tsx` (tabs; the office is a tab or sits beside the page) |
| Office | `office/iso/*`: layout and building (pure), behaviour and events (pure), art, robots, effects and the Pixi scene. `office/engine/*` holds the camera, pen, font and paths |

**Rules that keep it clear:**
- Pure logic (layout, behaviour, events, limits, ports, scope) has no Pixi, no I/O, and its own test script under `scripts/`.
- The server is the source of truth. The UI never decides anything that matters, and the server re-checks every command.
- Machine-wide concerns live in their own module (`accounts.ts`, `ports.ts`), never inside one project.

## 2. Security boundaries today

| Boundary | How it's enforced |
|---|---|
| Browser ↔ server | Token link or `hq_sid` device cookie, plus an Origin check. `viewer` role: read-only. Risky commands from a remote device need a TOTP code (24 h per device). |
| Agent ↔ server | Each agent's token is an HMAC of its id with the project's secret. Hooks and MCP calls are tied to one agent in one project. |
| Agent ↔ your machine | Local mode: its own folder, a scrubbed environment and its own ports. Container mode: Docker, a non-root user, an egress allow-list through HQ's proxy, a per-CLI/account sign-in volume. Sandbox mode: Docker Sandboxes. |
| Agent ↔ the internet (security work) | Engagement scope: findings outside scope are refused; out-of-scope hosts are denied at the proxy. |
| Read-only building feeds | `watch=1` sockets get no terminal output, and the server ignores their commands. |
| Secrets | Sandbox keys go to `sbx secret` (never to HQ's files). Env files are passed to the agent without HQ reading them. |

**Gaps, and where they were closed:**
1. ~~Single owner~~: named people with owner, operator and viewer roles, passwords and an authenticator code (stage B).
2. ~~No HQ secret store~~: an encrypted vault for API keys and cloud credentials (stage A).
3. ~~Terminal output isn't redacted~~: every stored secret is masked before output leaves the server (stage A).
4. ~~Old names remain~~: the CLI, package, folders and UI are ArimaOps; `.hq` and `~/.hq` move on first start (stage C).
5. ~~Unsigned releases~~: tagged releases carry `SHA256SUMS` and a build-provenance attestation (stage C). Still open: a signed update manifest for in-app updates.

## 3. Where it's going (your decisions, 10 Nov 2026)

- **Open core:** the core stays open source. Paid features live in a separate licensed module.
- **Small teams:** one install serves several people with roles (owner, operator, viewer).
- **API keys:** stored encrypted on disk. The master key comes from the OS keychain on a laptop, or an environment secret on a server.
- **Providers first:** Anthropic and OpenAI, Google Gemini, OpenRouter/DeepSeek, AWS Bedrock/Vertex.

### 3.1 Accounts and credentials (core)

Today an agent has an `account` name (stage 1 of this). It becomes a first-class record.

```ts
// ~/.arima/accounts.json: no secret values, only references
interface Account {
  id: string;                    // "default", "work", "client-a"
  provider: "anthropic" | "openai" | "google" | "openrouter" | "deepseek" | "bedrock" | "vertex";
  auth: "subscription" | "api-key" | "cloud";
  label: string;
  secretRef?: string;            // key in the vault, for api-key / cloud
  limits?: { monthlyUsd?: number };
}
```

- **`server/credentials/vault.ts`:** AES-256-GCM, one file, written atomically.
  - The master key comes from `ARIMA_MASTER_KEY`, or the OS keychain (`secret-tool`, macOS `security`, Windows Credential Manager).
  - Only as a last resort it comes from a 0600 key file, with a setup-checklist warning.
  - Values never leave the server: the UI sees "set ✓ ending 1a2b" and can replace or delete a key.
- **`server/credentials/providers.ts`:** one table of what each CLI needs for each provider and auth kind. For example:
  - Claude Code with an API key: `ANTHROPIC_API_KEY`.
  - Claude Code through Bedrock: `CLAUDE_CODE_USE_BEDROCK=1` plus AWS credentials.
  - Codex: `OPENAI_API_KEY`.
  - Gemini: `GEMINI_API_KEY`, or Vertex settings.
  - OpenCode: `OPENROUTER_API_KEY` / `DEEPSEEK_API_KEY`.

  Adding a provider means adding a row there, not touching sessions.
- **Delivery to an agent:**
  - Local mode: the launch environment of that one process only, never written into the agent's folder.
    - Not on the command line, as the port block is today: tmux's command line is visible to anyone on the machine through `ps`.
    - Instead, through a 0600 file that the launch shell reads and deletes.
  - Container mode: a 0600 env file deleted right after `docker run` starts.
  - Sandbox mode: `sbx secret`.
- **Redaction:** the server replaces every stored secret value in terminal output, logs and the snapshot before anything leaves the process.
- **Spend:** the usage meter already counts tokens per agent. With a price table per provider, API-key accounts show money spent and can stop at `monthlyUsd`.

### 3.2 Users and roles (core)

- `users.json`: owner, operator and viewer.
  - Sign-in with a passkey or a password, plus TOTP.
  - Device cookies become per-user sessions.
- Every command is checked against the role and written to an audit log: who, what, which project, from which device.
- Agents keep their own tokens. People and agents never share credentials.
- The current token link stays as the owner's first-run bootstrap, then expires.

### 3.3 Open-core seam

- `ee/` (a separate folder and later a separate package) holds the paid features.
  - It registers through hooks the core exposes: `registerFeature("sso", …)`, `registerAuditSink(…)`, `registerSettingsPage(…)`.
  - The core never imports `ee/`. Without it, the product works fully for one team.
- `server/license.ts`: a license file signed with Ed25519, verified offline against a public key built into the release.
  - It says who the license is for, the seat count, the features and the expiry.
  - No phone-home needed (good for air-gapped security teams).
- **Candidate paid features:**
  - SSO (OIDC/SAML);
  - more than N users;
  - audit-log export (SIEM);
  - spend policies across accounts;
  - fleet view across several HQ servers;
  - priority updates.
- **Licensing choice to make:** the core is MIT today. Keeping MIT is the simplest. AGPL-3.0 for new core code would stop someone hosting your core as a competing SaaS without sharing changes. The MIT notices in `LICENSES/MIT.txt` stay either way.

### 3.4 Release and security hygiene (before the first sale)

- **Finish the rename:**
  - the CLI becomes `arimaops`;
  - folders `.arima/` and `~/.arima/`, with migration from `.hq`;
  - the package name;
  - remove the old CLI alias.
- **Ship safely:**
  - signed release artifacts and a signed update manifest;
  - `SECURITY.md` with a disclosure address;
  - dependency audit in CI.
- **Harden the web side:**
  - a CSP on the UI;
  - rate limits on sign-in;
  - session expiry.
- **Back up safely:**
  - backup and restore of `~/.arima`, with the vault staying encrypted in backups.

## 4. Order of work

| Stage | What | Why first |
|---|---|---|
| A | Accounts and credentials: vault, provider table, delivery, redaction, UI to add keys | Unblocks API keys; everything else assumes it |
| B | Users and roles, audit log | Needed for any team or customer |
| C | Rename to ArimaOps everywhere, remove old names, signed releases (done) | Legal and brand; must be done before selling |
| D | Open-core seam: `ee/` hooks, license file, first paid feature (SSO or audit export) | Revenue |
| E | Spend tracking and limits per account | Cost control once API keys are used |

Each stage ships behind tests, like the office and account tests today, and none of them needs the earlier office work to change.
