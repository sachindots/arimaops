# ArimaOps v2.0 — Rust Core, Visual Q&A & Live Preview Annotation

Status: **All Milestones Complete (M0–M6, v2.0-GA Verified — Ready for Owner Cutover Verification)**
Target Version: `2.0.0-alpha.0` -> `2.0.0`
Created: 2026-11-21

---

## 1. Executive Summary & Locked Owner Decisions

ArimaOps v2.0 rebuilds the backend in **Rust** (`server-rs/` Cargo workspace) as a single self-contained static binary embedding the built React UI (`dist/` via `rust-embed`), paired with a minimal static `arima-shim` binary baked into agent containers/sandboxes. Node v1 (`server/`) is frozen until v2 cutover (no edits to `server/`).

| Dimension | Locked Decision |
|---|---|
| **Transition Strategy** | Freeze Node v1 (`server/` untouched) and build clean-slate Rust v2.0 in `server-rs/` from day one. |
| **Release Slicing** | Vertical slices: **v2.0-alpha** (Core, Auth/RBAC, SQLite, Hybrid Runners, Visual Q&A, Preview/Draw, GitHub PRs) -> **v2.0-beta** (Security Engagements: Scope/Findings/Reports + Team Memory) -> **v2.0-GA** (Factory Scorers/Benchmarks, Tool Connections, Licensing, v1->v2 migration & cutover). |
| **Workspace & Type Contract** | Same monorepo Cargo workspace (`server-rs/crates/*`); `ts-rs` exports Rust contract types to `src/data/generated.ts` (`pnpm gen:types`) so Rust and React stay compile-time type-safe. |
| **Agent Execution** | **Hybrid:** Native Rust HTTP+SSE API runners (Anthropic, OpenAI, Gemini, OpenRouter, Bedrock) power Lead, Reviewer, Second-Opinion, Verifier, and Memory/Scoring immediately + optional Docker coding seats; CLI agents remain first-class via static `arima-shim` (replacing `streamRunner.py` and `tmux` screen-scraping). |
| **Auth, RBAC & Security** | Password (Argon2id) + QR-code TOTP (vault-encrypted) everywhere + Passkeys/WebAuthn auto-enabled on `localhost` and HTTPS (Tailscale) + active device/session revocation + per-project RBAC (`owner`/`operator`/`viewer`) + strict read-only viewers + DNS-pinned SSRF-safe egress proxy. |
| **Persistence** | Consolidated SQLite (`~/.arima/v2/arima.db`): WAL mode, explicit `PRAGMA foreign_keys = ON`, `SAVEPOINT` nested transactions, persisted `agent_outbox(project_id, agent_id, epoch, seq, acked_at)`, complete `forget_project` purge across all tables and disk artifacts, encrypted full backup + restore UI. |
| **Live App Preview** | Isolated Preview Proxy on `:7421` by default (optional subdomain mode for VPS/cloud) with short-lived signed preview cookie isolated from `:7420` `hq_sid`. Auto-discovers Local (port blocks + probe), Container (`br-hq` fixed IP `172.30.0.x`), and Sandbox (`sbx ports`) dev servers — works on desktop and tablet over Tailscale. |
| **Annotation & Tablet Drawing** | Dual-mode Preview Tab (Live Browse + tap-to-pick DOM Element Inspector + Freeze & Draw Pen/Touch canvas via server-side Playwright snapshot with in-iframe DOM-to-PNG fallback) AND ability to annotate Verifier PR evidence screenshots. |
| **Visual Issue Routing** | Choice on submit: **Create Board Task** OR **Send to Agent / Team Chat**, attaching annotated PNG + structured JSON (`url`, `viewport`, `cssSelector`, `componentHint`, `outerHtmlSnippet`, `bbox`, `consoleErrors`) directly into `.arima/feedback/<id>/` inside the target agent's workspace. |
| **Visual Agent-to-User Comms** | Unified Visual Decision System across Inbox and inline Chat cards: (1) multi-choice `ask_user` cards with `(Recommended)` defaults, (2) side-by-side Second-Opinion & Disagreement cards + wired `recordGate` waive UI, (3) visual CLI permission/trust buttons replacing `"Open terminal"`. |
| **Meetings & Standup Calls** | Hybrid Standup Room + Optional Voice Call Mode (`"Join Call"` toggle with distinct per-agent TTS voices and push-to-talk mic or button taps). Lead moderates & invites relevant agents; triggered by agent MCP `request_meeting` (`Join now` / `Snooze` / `Decline` card), owner start, or scheduled `09:00`/`18:00` standups. Auto-generates Meeting Minutes with 1-click commit (Decisions -> certified Memory, Tasks, Agent unblocking). Pluggable Voice Adapter: free browser Web Speech API default + optional vaulted OpenAI/Gemini TTS/STT upgrade. |
| **Scale & Packaging** | Rock-solid single-machine scale (20–30 concurrent agents, 5–10 projects, 3–10 users); single static `arimaops` binary with `rust-embed` UI + minimal Docker image in `compose.yaml`. |
| **Unified Responsive Shell** | Single responsive `<Deck />` shell across Desktop (`>= 1000px`), Tablet (`900px`), and Phone (`390px`) with zero duplicated compact layout, custom accessible `<Select>` (zero native `<select>`), and bundled Inter `--font-sans` typography. |
| **Unified Client (`apps/client/`)** | Single thin Tauri v2 multi-server client for Linux, macOS, Windows, and Android (standalone Cargo workspace outside `server-rs/`), with dark-glass server picker, `/api/health` probing, `0600` profile store, desktop tray, and `switch_server` bridge. |
| **Cloud HTTPS Deployment** | AWS EC2 + Caddy automatic wildcard HTTPS (`deploy/aws-caddy/`): `hq.<domain>` -> `:7420`, `preview-*.<domain>` -> `:7421`, `HQ_PUBLIC_ORIGIN` / `HQ_PREVIEW_DOMAIN` / `HQ_TRUST_PROXY`, HTTPS `Secure` cookies, and Passkeys on `HQ_PUBLIC_ORIGIN`. |
| **Automated E2E & Visual QA** | Full Playwright E2E & visual-invariant suite (`pnpm test:e2e`, `tests/e2e/`) asserting 0 console errors, 0 native `<select>`, Inter font loading, zero overflow across `1440`/`900`/`390`, resize state preservation, workflows, and isolated live Rust HQ + Preview Proxy. |

---

## 2. v1 Audit Findings That v2.0 Must Eliminate

Every bug and vulnerability discovered during the 2026-11-21 live + static audit of v1 (`server/` and `src/`):

### Event Flow, Crash Recovery & Reliability
1. **Stream engine post-restart message blackhole (`server/streamEngine.ts`, `server/inbox.ts`):** In-memory `queues` and `seq` reset to `0` on restart while surviving `streamRunner.py` retained old `ack`, silently dropping `seq 1..ack`; also marked `"typed"` before delivery. **v2 fix:** SQLite `agent_outbox` keyed by `(project_id, agent_id, epoch, seq)` — new server epoch supersedes stale client `ack` without dropping messages.
2. **Silent WS command failures (`server/http.ts`):** Command exceptions were only logged server-side; UI received no ack/error, causing `WelcomeModal` (`Creating...`) to hang forever on error. **v2 fix:** Correlated `{ id, cmd, args }` -> `WsCommandAck { id, ok, error }`.
3. **Concurrency & startup races (`server/sessions.ts`, `server/planner.ts`, `server/onDemand.ts`):** `Sessions.start()` checked `"starting"` before async awaits; `startPolling()` had no overlap guard; `resumeAgents` raced `startPolling` after a hardcoded 8 s sleep; `OnDemand.started` was lost on restart; `planner.assign()` didn't await deliverable/workspace sync before sending `"Start task"`. **v2 fix:** Tokio task supervisor with per-agent state locks, explicit async setup sequencing, and persisted runtime state.
4. **30-minute stall auto-escalation bug (`server/stalls.ts`):** Told the Lead to decide *every* open Action Item except `plan` (including `send`, `skills`, `spend`, `memory`). **v2 fix:** Explicit `owner_only` classification on `VisualDecision`.
5. **Screen-scraping & folder-trust stall (`server/sessions.ts`, `server/screen.ts`):** `reconcileFromScreen` omitted `trust` while `canType()` blocked on `trust`. **v2 fix:** `arima-shim` reports explicit structured states and hooks over persistent WS (zero screen scraping for stream/shim agents).
6. **Subprocess-fork & event-loop bottlenecks:** Eliminated by `arima-shim` (no 3s `tmux` fork storms), Docker Engine API via `bollard`, in-memory container IP map (no 1s `docker network inspect`), incremental byte-offset usage tailing, async Argon2id via `spawn_blocking`, cached MCP handlers, single-serialize WS broadcasts with bounded per-client backpressure, and on-demand PTY streaming only when a viewer attaches.

### Auth, RBAC & Security
7. **Unauthenticated WS/HTTP crash DoS (`server/http.ts:50`):** Raw `decodeURIComponent()` in `cookie()` outside `try/catch` threw uncaught `URIError` on malformed `hq_sid`. **v2 fix:** Safe decoding returning `400`/`401` `Result` errors.
8. **`viewer` prompt-injection bypass (`server/commandPolicy.ts:137-139`):** Viewers could call `sendMessage` / `askTeam` delivered to live agents as `"You"`. **v2 fix:** `viewer` is strictly read-only at policy and command layers; cannot trigger agent prompts.
9. **`operator` Local RCE & owner-gate bypass (`server/commandPolicy.ts`):** Operators could inject `NODE_OPTIONS`/`BASH_ENV` via `setEnvVar` on Local agents + `startAgent`, and could call `recordGate` / `resolveActionItem` as `"you"` to approve specs/sends/merges. **v2 fix:** Strict server + per-project RBAC separating operator execution from host-level `env`/mode edits and owner-only approvals.
10. **Container Egress Proxy SSRF (`server/containers.ts:221-308`):** Checked hostname string only without DNS IP validation, permitting loopback, RFC 1918, and cloud metadata (`169.254.169.254`) access, plus IPv6 `CONNECT` split bug. **v2 fix:** `arima-proxy` resolves DNS directly and pins connections to validated public IPs (or explicit scoped targets), blocking loopback/private/link-local/IMDS CIDRs.
11. **Unlimited container CPU/RAM & shell injection (`server/templates.ts`, `server/adapters.ts`, `server/agentFiles.ts`):** Containers defaulted to `cpus: null, memoryGb: null`; unquoted shell interpolation for CLI args; bearer tokens passed on argv; cloud credential files lingered on disk. **v2 fix:** Enforce default container resource quotas, zero-shell `Command::new` argv arrays, header/stdin secret passing, and short-lived tmpfs/memory delivery.
12. **Auth hygiene gaps (`server/http.ts`, `server/users.ts`, `src/store/auth.ts`):** Admin password/TOTP reset didn't revoke `hq_sid` cookies or 24h elevation; `viewerToken` stayed valid remotely forever; `?token=` leaked in API query strings after login; `X-Forwarded-For` first-IP trust bypassed rate limits; plaintext TOTP secrets; missing QR TOTP, Passkeys, device list/revocation, and `/api/projects/*` audit logging.

### Data Persistence & UI/Responsive Parity
13. **`forgetProject()` data leaks (`server/forget.ts`):** Omitted `task_events`, `action_answers`, `scores`, `goals`, container usage transcripts (`~/.arima/usage/hq-<slug>-*`), `secrets/<slug>`, and `container-ips.json` entries. **v2 fix:** `ON DELETE CASCADE` on `project_id` + tested full purge across all tables and disk directories.
14. **Fragmented DBs, missing FKs & incomplete backups (`server/lib/docs.ts`, `server/backups.ts`):** Split across 3 DBs + 15 files; `PRAGMA foreign_keys = ON` never executed; no nested savepoints; open DB handles leaked on unload; backups skipped project DBs/configs/vault/evidence with no restore UI.
15. **Live UI & tablet bugs:** `WelcomeModal` non-dismissible (blocks `Setup` and `Sign out`); `signIn()` hangs on network error; expired WS `4001` loops reconnecting instead of returning to `<SignIn />`; mock UI flashes before auth check; `PrDrawer` hides details & GitHub link `< 1100px`; `ActionItemsDrawer` renders duplicate detail cards at `900px`; resizing `1440 -> 900` resets Chat to Home and wipes drafts; `GoalsPage` and `UsagePage` unreachable `< 1000px`; `recordGate` missing from UI; `ask_user` lacks structured choices and punts agent doubts to `"Open terminal"`.

---

## 3. Cargo Workspace & Crate Boundaries (`server-rs/`)

All Rust code uses `// SPDX-License-Identifier: AGPL-3.0-or-later`.

```text
server-rs/
├── Cargo.toml
└── crates/
    ├── arima-core     Domain types, VisualDecision, VisualFeedback, OutboxMessage,
    │                  WS protocol envelopes, ts-rs codegen binary (export_types)
    ├── arima-db       Unified SQLite (~/.arima/v2/arima.db), WAL, PRAGMA foreign_keys=ON,
    │                  SAVEPOINT nested tx, migrations, OutboxRepo (epoch+seq/ack),
    │                  forget_project purge, encrypted full backup & restore
    ├── arima-auth     Argon2id, DeviceSessions (hq_sid + preview token), Passkeys (webauthn-rs),
    │                  Vault-encrypted TOTP + SVG QR, per-project RBAC, persistent Throttle, AuditLog
    ├── arima-proxy    DNS-pinned SSRF-safe L4/L7 Egress Proxy + Isolated Preview Proxy (:7421)
    │                  with Local/Container/Sandbox discovery, WS/HMR proxying, ArimaBridge injection
    ├── arima-agents   Native HTTP+SSE provider runners, arima-shim WS hub, Docker Engine API (bollard),
    │                  sbx adapter, incremental byte-offset usage tailer, feedback workspace sync
    ├── arima-server   Main `arimaops` binary: Axum HTTP+WS server, cached /mcp endpoint, GitHub App/Sync,
    │                  Playwright snapshot & PNG compositor, rust-embed dist/ UI
    └── arima-shim     Tiny static binary for containers/sandboxes: PTY + stream-json +
                       --permission-prompt-tool bridge + persistent epoch/ack state
```

---

## 4. Core Protocol & Feature Contracts

### 4.1 Unified SQLite Schema (`arima-db` Migration 001)
All tables enforce `FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE` (with `PRAGMA foreign_keys = ON` always enabled on every connection):
- Auth & Audit: `users`, `user_project_roles`, `device_sessions`, `passkeys`, `audit_log`
- Core Project & Flow: `projects`, `boards`, `tasks`, `task_events`, `gate_events`, `goals`, `scores`, `action_answers`
- Comms, Meetings, Outbox & Visuals: `visual_decisions`, `visual_feedback`, `meetings`, `meeting_turns`, `messages`, `agent_outbox(project_id, agent_id, epoch, seq, acked_at)`, `usage_events`
- Memory & Security (populated in M4): `memories`, `memory_about`, `memory_fts` (FTS5), `findings`

### 4.2 Correlated WebSocket Protocol (`arima-core::protocol`)
- Client sends: `WsClientMessage { id: String, cmd: String, args: JsonValue }`
- Server replies directly to sender: `WsServerEvent::CommandAck(WsCommandAck { id, ok, error })`
- Server broadcasts state deltas via single pre-serialized JSON frame over bounded per-client Tokio `mpsc` channels (`try_send` / backpressure drop + snapshot resync for slow clients).

### 4.3 Unified Visual Decision System (`arima-core::decision`)
`VisualDecision` unifies Inbox and inline Chat decision cards:
- `question` (`ask_user` upgraded): `questions[]` with `single` / `multi` mode, options (`id`, `label`, `description`, `recommended`), optional free-text `"Other"`, and structured `QuestionAnswer[]` submission.
- `second-opinion` & `disagreement`: Unlimited Markdown rationale, `optionA` vs `optionB` comparison (`OpinionSide`), confidence/risk notes, and one-click actions (`OptionA`, `OptionB`, `Revise`, `WaiveGate`).
- `permission`: Structured tool/command/trust request from `--permission-prompt-tool` or `arima-shim` with `AllowOnce`, `AllowForTask`, `Deny`.
- Existing approvals (`spec-approval`, `plan-approval`, `gate-approval`, `send-proposal`, `memory-review`, `spend-alert`, `skill-scan`, `overflow-fallback`, `info`) with Markdown body rendering and inline draft previews.

### 4.4 Isolated Preview & Tablet Annotation (`arima-core::feedback`, `arima-proxy`)
- **Origin Isolation:** Preview Proxy serves on `:7421` (or `preview-<slug>.<host>` in subdomain mode). HQ (`:7420`) issues a short-lived HMAC/signed preview token exchanged for a `:7421`-only cookie so untrusted demo apps can never read `:7420` `hq_sid` or call `/api/*`.
- **Target Auto-Discovery:** Scans Local allocated port blocks + active TCP listeners, Container fixed IPs (`172.30.0.10–250` on `br-hq` without publishing host ports), and Sandbox published ports.
- **ArimaBridge + Freeze & Draw:** Injected bridge handles hover/tap DOM picking (`cssSelector`, `ariaRole`, `componentHint`, `textSnippet`, `outerHtmlSnippet`, `bbox`) and buffers `consoleErrors[]` / failed network fetches, communicating only via origin-validated `postMessage`. Freeze & Draw snapshots via Playwright/Chromium (fallback: in-iframe DOM-to-PNG), overlays a Pointer Events `<canvas>` (`touch-action: none`, `pen | touch | mouse`, freehand ink, arrow, box, numbered callout, undo/redo), composites PNG + JSON to `~/.arima/v2/feedback/<slug>/<id>/`, syncs into target workspace `.arima/feedback/<id>/`, and creates either a Board Task or Agent Chat message.

### 4.5 Discussion Sessions, Meetings & Standup Calls (`arima-core::meeting`)
- **Domain Model:** `MeetingSession` (`standup` | `discussion` | `kickoff` | `review`, urgency, Lead moderator, invited `participantIds`, agenda items, `VoiceProvider`, optional `MeetingMinutes`) and ordered `MeetingTurn` records (each turn can link directly to an interactive `VisualDecision` card and optional concise `spokenText`).
- **Triggers & Lead Moderation:**
  - **Agent-requested:** Any agent calls MCP `request_meeting(topic, urgency, agenda, recommendations)` which creates a `DecisionPayload::MeetingRequest` Inbox/Home card (`Join now` / `Snooze` / `Decline`).
  - **Owner / Scheduled:** Owner launches a Discussion Room anytime, or `09:00`/`18:00` standups trigger an interactive Standup Room when the team has movement or blockers.
  - **Moderation Loop:** The Lead opens with an agenda, invites only relevant agents turn-by-turn (avoiding crosstalk and wasted spend), renders their blocker/recommendation cards inline, and synthesizes trade-offs.
- **Hybrid Voice Call Mode (Pluggable Voice Adapter):** Clicking `"Join Call"` enables distinct per-agent spoken voices (`BrowserWebSpeech` free default via Web Speech API TTS + push-to-talk STT; optional vaulted `OpenAi` / `Gemini` TTS/STT endpoints added in M4). Works smoothly on `localhost` and HTTPS Tailscale; falls back gracefully to silent visual cards on plain LAN HTTP.
- **1-Click Meeting Minutes Commit:** Ending a session produces `MeetingMinutes` listing `ProposedDecision[]` (persisted as certified Team Memory), `ProposedTask[]` (created/assigned on the Board), and `AgentInstruction[]` (delivered into `agent_outbox`), editable and committed in one click.

---

## 5. Phased Milestone Checklist

### Milestone 0: Cargo Workspace, Contracts & Unified SQLite Foundation
- [x] **M0.1** Write master spec (`context/plans/001-arimaops-v2-rust.md`), continuation prompt (`context/plans/001-v2-continue-prompt.md`), update `AGENTS.md`, `.gitignore`, `vite.config.ts`, `package.json` (`gen:types`), and `HANDOFF.md`.
- [x] **M0.2** Initialize Cargo workspace at `server-rs/Cargo.toml` with all 7 crates (`arima-core`, `arima-db`, `arima-auth`, `arima-proxy`, `arima-agents`, `arima-server`, `arima-shim`).
- [x] **M0.3** Implement `arima-core` domain contracts (`auth`, `decision`, `feedback`, `outbox`, `protocol`) with `ts-rs` derives and `export_types` binary generating `src/data/generated.ts`.
- [x] **M0.4** Implement `arima-db` (`Db::open` with WAL/FK/0600, `SAVEPOINT` nested transactions, `001_initial_v2_schema`, `OutboxRepo` with `epoch+seq/ack`, complete `forget_project` purge, `backup_sqlite_to` via `VACUUM INTO`).
- [x] **M0.5** Scaffold `arima-auth`, `arima-proxy`, `arima-agents`, `arima-shim` (`--version`), and `arima-server` (`GET /api/health`) + write `db_invariants.rs` integration tests.
- [x] **M0.6** Verify: `pnpm gen:types`, `cargo test`, `cargo clippy -- -D warnings`, `pnpm build`, `pnpm test` all pass cleanly.
- [x] **M0.7** Add Meeting & Standup Call contracts (`arima-core::meeting`, `DecisionPayload::MeetingRequest`, `WsServerEvent::MeetingUpdated`/`MeetingTurnAdded`), regenerate `src/data/generated.ts`, add `002_meetings_schema` migration in `arima-db`, update `forget_project` cascade tests, and verify all checks.

### Milestone 1: Auth, Strict RBAC, Hardened Proxies & Base UI Fixes (v2.0-alpha pt. 1)
- [x] **M1.1** `arima-auth`: Argon2id hashing (`spawn_blocking`), `hq_sid` session cookies (revoke all user sessions & step-up on admin password/TOTP reset), vault-encrypted TOTP + SVG QR code generator + constant-time verification, `webauthn-rs` Passkeys (auto-enabled on `localhost`/HTTPS), per-project RBAC (`user_project_roles`), persistent login throttle (no blind `X-Forwarded-For` trust), full audit logging on HTTP/WS/MCP, safe cookie/URL percent-decoding.
- [x] **M1.2** `arima-proxy` Egress Proxy: DNS-pinned connector blocking loopback (`127.0.0.0/8`, `::1`), RFC 1918, link-local / cloud IMDS (`169.254.169.254`, `fe80::/10`), and proper IPv6 `CONNECT` parsing; static container IP map lookup (zero `docker network inspect` polling).
- [x] **M1.3** `arima-server`: Axum HTTP + WS server with correlated `WsCommandAck`, bounded per-client broadcast queues, `rust-embed` static UI, `Referrer-Policy` / `nosniff` / scoped CSP headers, HTTP endpoints for auth, passkeys, devices, users, projects, and audit logs.
- [x] **M1.4** React Auth & Shell Fixes: stop `?token=` query leaks after login, fix `signIn()` network-error hang, handle WS `4001` redirect to `<SignIn />`, eliminate unauthenticated mock flash, add Passkey sign-in + SVG QR TOTP setup + Active Devices revocation UI + per-project role assignment in `UsersSettings`, make `WelcomeModal` dismissible + reset error state on failed commands.
- [x] **M1.5** Verify: Auth/RBAC/operator-escalation/viewer-read-only/SSRF security integration tests pass; browser check on isolated Rust HQ verifying login, QR TOTP, Passkeys on `localhost`, device revocation, and dismissible onboarding.

### Milestone 2: Hybrid Agent Engine, `arima-shim`, Visual Decision Cards & Tablet Fixes (v2.0-alpha pt. 2)
- [x] **M2.1** `arima-shim` static binary: PTY multiplexer (streams bytes only when a UI terminal viewer attaches), `stream-json` runner with persisted `(epoch, seq, ack)`, `--permission-prompt-tool` MCP/WS interceptor, zero screen scraping.
- [x] **M2.2** `arima-agents`: Native Rust HTTP+SSE runners (Anthropic, OpenAI, Gemini, OpenRouter/DeepSeek, Bedrock) for Lead, Reviewer, Second-Opinion, Verifier + optional coding seats; `bollard` Docker launcher with mandatory default CPU/RAM quotas (`2 CPU / 2 GB`) and zero shell interpolation; `sbx` adapter; incremental byte-offset usage tailer.
- [x] **M2.3** `arima-server` `/mcp` & GitHub PR sync: cached MCP handler per `(project, agent)` exposing upgraded `ask_user`, `request_meeting`, `record_gate` (unlimited rationale + A/B sides), `request_access`, `attach_evidence`, `get_visual_feedback`, task/board/ledger tools; Lead meeting moderator loop + scheduled interactive `09:00`/`18:00` standups; GitHub App webhooks + GraphQL PR sync without post-restart blind spots.
- [x] **M2.4** Unified Visual Decision UI, Meetings/Standup Room & Tablet Fixes: render `QuestionCard`, `SecondOpinionCard` / `DisagreementCard`, `PermissionCard`, `MeetingRequest` cards (`Join now` / `Snooze` / `Decline`), Markdown spec/plan & inline draft previews across Inbox & Chat; build `Meetings` / Standup Room UI with browser Web Speech `"Join Call"` toggle (per-agent TTS voices + push-to-talk STT) and 1-click Meeting Minutes commit modal; wire `recordGate` in `TaskSheet`; fix `PrDrawer < 1100px`, `900px` Inbox duplicate card render, `1440 <-> 900` resize Chat/draft preservation, and `< 1000px` access to Goals & Usage.
- [x] **M2.5** Verify: Crash-restart `OutboxRepo` + `arima-shim` integration tests (zero dropped messages); end-to-end Lead structured interview, `request_meeting` -> Standup Room -> 1-click Minutes commit, CLI permission button, and PR gate waive checked in desktop & tablet browser.

### Milestone 3: Isolated Live Preview, DOM Picker & Tablet Freeze & Draw (v2.0-alpha complete)
- [x] **M3.1** `arima-proxy` Preview Proxy (`:7421` + optional subdomain mode): signed preview-only cookie exchange, HTTP + WebSocket/HMR proxying, `X-Frame-Options` / `frame-ancestors` stripping, target auto-discovery across Local/Container(`br-hq`)/Sandbox, strict origin-checked `ArimaBridge` injection (element hover/tap picker + console/network error ring buffer).
- [x] **M3.2** `arima-server` Snapshot & Feedback Pipeline: Playwright/Chromium live viewport screenshot endpoint (`POST /api/projects/:id/preview/snapshot`) with DOM-to-PNG fallback payload support, feedback save (`annotated.png` + `context.json`), workspace `.arima/feedback/<id>/` atomic sync, routing to Board Task or Agent Chat.
- [x] **M3.3** React Preview Tab & Freeze & Draw Canvas: `PreviewPage` in `DeckRail` & `CompactApp` (target picker, URL bar, Desktop/Tablet/Phone viewport frames, Browse/Pick/Draw modes), Pointer Events `<canvas>` (`touch-action: none`, pen/touch/mouse, freehand, arrow, box, numbered callout, color, undo/redo), **Annotate** button on Verifier PR evidence screenshots (`TaskSheet` / `PrDrawer`), submit modal choosing Task vs Chat.
- [x] **M3.4** Verify: Cookie-isolation security test confirms `:7421` JS cannot read `:7420` `hq_sid` or call `/api/*`; live Vite app previewed on desktop & tablet viewport, DOM element picked, drawn on, submitted to agent, and `.arima/feedback/<id>/` verified in agent workspace.

### Milestone 4: Security Engagements, Team Memory & Encrypted Backup/Restore (v2.0-beta)
- [x] **M4.1** Port Security Engagements: Scope enforcement (synchronized with `arima-proxy` DNS-pinned egress proxy), CVSS 4.0 Finding schema, 6 report exports (PDF/HTML, Markdown, HackerOne, Bugcrowd, JSON, SARIF), `FindingsDrawer` integration.
- [x] **M4.2** Port SQLite FTS5 Team Memory & Upgraded Voice Adapters: Native Rust API Haiku/Flash extraction, consolidation, 30-day uncertified decay, contradiction checks, Inbox certification, lesson promotion to templates, connect committed Meeting Decisions directly to certified Team Memory, and add optional vaulted OpenAI / Gemini TTS & STT endpoints for Standup Calls.
- [x] **M4.3** Full Encrypted Backup & Restore UI: Scheduled + on-demand encrypted archive containing `arima.db`, encrypted vault, accounts, env configs, and `evidence/` + `feedback/`, with Settings restore verification UI.
- [x] **M4.4** Verify: Ported security & memory test suites + backup/restore round-trip test pass.

### Milestone 5: Factory, Tool Connections, Licensing & Cutover (v2.0-GA)
- [x] **M5.1** Port Factory Metrics, Native LLM Scorers, Nightly Improvement Proposals, Replay Benchmark Harness, Tool Connections (`propose_send`), and `ee/` Ed25519 licensing (with runtime expiry & seat limits enforced).
- [x] **M5.2** v1 -> v2 Data Migrator (`arimaops migrate-v1`): lossless migration of `~/.arima/` + per-project/repo SQLite DBs, vault, accounts, and evidence into `~/.arima/v2/arima.db` with dry-run report.
- [x] **M5.3** Single-binary multi-stage `docker/hq.v2.Dockerfile` + `docker/agent.v2.Dockerfile` (baking static `arima-shim` for `x86_64` & `aarch64`), `compose.v2.yaml` & `deploy/aws-caddy/compose.aws.yaml` update (Node `server/` and v1 `compose.yaml` kept intact pending explicit owner cutover approval).
- [x] **M5.4** Verify: v1->v2 migration test, 20-agent concurrent load test within single-machine RAM/CPU budget, full `cargo test` (46/46) + `clippy` (0 warnings) + `pnpm build` + `pnpm test:e2e` (18/18) + `docker compose -f compose.v2.yaml config -q` valid.

### Milestone 6: Unified Responsive Shell, Tauri v2 Client (Desktop + Android), AWS EC2/Caddy HTTPS & Playwright E2E
- [x] **M6.1** Merge `Deck.tsx` + `CompactApp.tsx` into ONE unified responsive `<Deck />` shell across Desktop (`>= 1000px`), Tablet (`900px`), and Phone (`390px`) with Tauri v2 `switch_server` bridge in `src/lib/native.ts`.
- [x] **M6.2** Production HTTPS Wildcard Subdomain Preview & AWS EC2/Caddy Deployment Pack (`HQ_PUBLIC_ORIGIN`, `HQ_PREVIEW_DOMAIN`, `HQ_TRUST_PROXY`, `https://preview-<slug>.<domain>`, HTTPS `Secure` cookies, WebAuthn Passkeys on `HQ_PUBLIC_ORIGIN`, `deploy/aws-caddy/`).
- [x] **M6.3** Unified Tauri v2 Multi-Server Client (`apps/client/` standalone Cargo workspace for Linux/macOS/Windows/Android + `.github/workflows/client-release.yml`).
- [x] **M6.4** Automated Playwright E2E & Visual-Invariant Suite (`pnpm test:e2e`, `tests/e2e/`) verified across Desktop, Tablet, Phone, and live isolated Rust HQ + Preview Proxy.

---

## 6. Architecture Rules for Agents Working on This Spec
1. Never edit `server/` (v1 is frozen) or touch live `~/.arima/`, `:7420`, or `arimaops-hq-1`.
2. All new `.rs` files and generated TypeScript files begin with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
3. Whenever `arima-core` exported types change, run `pnpm gen:types` immediately and verify `pnpm build`.
4. Maintain `AGENTS.md` UI rules (`Inter` font, `@material-symbols` `<Icon>`, `12/13/15/20/28` px type scale, `400/500/600` weights, `data-theme` CSS tokens, `PageTitle`, ArimaOps branding only).
5. Check off `- [x]` items in this file only after verifying tests/checks pass, and log a concise entry at the top of `HANDOFF.md`.
