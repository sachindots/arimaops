# ArimaOps v2.0 — Continuation Prompt for Coding Agents

Copy and paste the prompt below into a fresh coding agent session to continue ArimaOps v2.0 polish, cutover verification, or post-GA work seamlessly from where the previous session left off.

---

```text
You are continuing ArimaOps v2.0 (`v2.0-GA`, Rust core in `server-rs/`, unified responsive React UI in `src/`, Playwright E2E in `tests/e2e/`, AWS EC2+Caddy pack in `deploy/aws-caddy/`, and unified Tauri v2 client in `apps/client/`).

## 1. Mandatory Startup Read Order (do this before writing code)
1. Read `AGENTS.md` (owner rules, UI design rules, build & test commands).
2. Read `context/plans/001-arimaops-v2-rust.md` (architecture spec, v1 audit findings to avoid regressing on, and the M0–M6 milestone checklist).
3. Read the top 60 lines of `HANDOFF.md` (latest v2.0-GA status, known minor items, and cutover checklist).
4. Run `git status --short && git log -5 --oneline` to inspect the current workspace state (all M0–M6 work is verified in the working copy, uncommitted).

## 2. Hard Non-Negotiable Constraints
- **DO NOT edit or delete anything under `server/`**, `compose.yaml`, `docker/hq.Dockerfile`, or `docker/agent.Dockerfile` without explicit owner approval after live v2 cutover verification.
- **DO NOT touch `~/.arima/`, port `:7420`, or the live Docker container `arimaops-hq-1`.** Use isolated temp directories and throwaway ports for any live tests.
- **Keep branding strictly `ArimaOps`.** Never use legacy internal names or name/credit other products in code, docs, or UI.
- **No AI attribution** anywhere (no `Co-Authored-By`, no generated-by footers).
- **SPDX Header:** Every new `.rs` file (`server-rs/` and `apps/client/src-tauri/`) and generated TypeScript file (`src/data/generated.ts`) must start with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- **Ask the owner before big product decisions**, deleting legacy directories (`android/`), committing, pushing, or running live cutover.

## 3. UI & Architecture Invariants (preserve strictly on every UI edit)
- Single unified responsive shell in `src/ui/deck/Deck.tsx` across desktop (`>= 1000px`), tablet, and phone (`390px`) — `CompactApp.tsx` is deleted; never split into separate viewport shells.
- Zero native `<select>` elements anywhere (`grep -rn "<select" src/` must equal `0`) — always use `src/ui/primitives/Select.tsx`.
- Default to dark-glass (`data-scheme="dark"`), bundled `Inter` via `--font-sans` (`12/13/15/20/28` px, weights `400/500/600`), bundled `<Icon name="…" />`, `data-theme` CSS tokens from `src/index.css`, and zero `dangerouslySetInnerHTML`.
- Keep `server-rs/crates/arima-core` (`ts-rs`) as the single contract source; run `pnpm gen:types` if core types change.

## 4. Current State & Likely Next Tasks
Milestones M0–M6 (`v2.0-GA`) are implemented and verified. Focus on what the owner asks for next, starting with:
1. Optional 1-line polish: align `src/ui/settings/LicenseCard.tsx` (`?mock=1` format check & placeholder `ARIMA2.*`) to match `server-rs/crates/arima-server/src/license.rs` (`ARIMA1.<b64url_payload>.<b64url_sig>`), updating `tests/e2e/m5-ga.spec.ts` to match.
2. Owner cutover verification (only when asked): review/commit changes, run `arima-server migrate-v1 --from ~/.arima --to ~/.arima/v2 --dry-run` (read-only on source), smoke-test `compose.v2.yaml` / `deploy/aws-caddy/`, build/verify `apps/client/` (`Linux`/`macOS`/`Windows`/`Android`), and retire `server/` once approved.

## 5. Required Verification Suite After Any Final Edit
- `pnpm build` (522+ modules, 0 TS/Vite errors — run before Cargo so `dist/` is embedded)
- `cargo test --manifest-path server-rs/Cargo.toml` (46/46+)
- `cargo clippy --manifest-path server-rs/Cargo.toml --all-targets -- -D warnings` (0 warnings)
- `cargo test --manifest-path apps/client/src-tauri/Cargo.toml` (4/4+)
- `cargo clippy --manifest-path apps/client/src-tauri/Cargo.toml --all-targets -- -D warnings` (0 warnings)
- `pnpm test` (53/53)
- `pnpm test:e2e` (18/18, using isolated ports & temp dirs)
- Keep `context/plans/001-arimaops-v2-rust.md` and `HANDOFF.md` updated cleanly with exact verified results.
```
