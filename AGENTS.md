# ArimaOps: notes for coding agents

ArimaOps (அரிமா, "lion") is a multi-agent orchestrator: one Node server (`server/`) runs a team of AI agents per project, and a React UI (`src/`) shows the work: Home, Board, Inbox, Agents, Chat. The look is the command deck (`docs/design/command-deck.md`): a readable dark-glass HUD (glowing meters, sparklines, live counters) with Inter for all text (headings and big numbers in its heavier weights; a monospace font only in terminals), Material Symbols icons bundled with the app (`<Icon name=… />`, never a font from another site), text sizes 12 / 13 / 15 / 20 / 28 px only and weights 400 / 500 / 600 (page titles use `PageTitle`), and one accent per project type: components use `accent` / `accent-2` / `accent-glow`, set by `data-theme` on `<html>` from `src/ui/theme/projectTheme.ts` (cyan-blue for software, red for red team), never a hard-coded accent colour. Status colours are only for status; colours come from the tokens in `src/index.css`; no pixel or game styling, and no fictional or trademarked names in the UI. All viewports (desktop >= 1000 px, tablet, and phone) use the single unified responsive shell in `src/ui/deck/Deck.tsx` (custom portaled `<Select>` in `src/ui/primitives/Select.tsx` — never native `<select>`). Read `docs/architecture.md` before adding a module.

## Rules from the owner (Sachin)

- The name is **ArimaOps** everywhere visible. Never an older name such as "dothq" or ".hq" (old names live only in migration lists in `src/data/brand.ts`). Don't name or credit other products in the code, docs or UI; the MIT notices in `LICENSES/MIT.txt` stay as they are.
- **No AI attribution** in commits or PRs: no `Co-Authored-By` AI lines, no "Generated with" footers.
- Ask before big product decisions. Don't stop or delete the owner's running agents or projects.
- Never type secrets, TOTP codes or passwords on the owner's behalf; never answer an agent CLI's folder-trust prompt without the owner's OK.
- The repo is public: github.com/sachindots/arimaops, branch `main`. Never push `backup/*` branches.

## Build and test

```bash
pnpm install
pnpm build                                  # typecheck (UI + server), Vite build, server bundle
pnpm test                                   # every scripts/*-test.ts; `pnpm test auth users` runs some
```

Local dev: `pnpm dev:hq` (HQ on :7420, UI on :5173). The server keeps state in `~/.arima/`.

## v2.0 Rust Core (`server-rs/`)

`server/` is frozen v1; active backend development happens in the `server-rs/` Cargo workspace (`crates/arima-*`), with `ts-rs` generating `src/data/generated.ts` as the single shared contract with `src/`. Never touch `server/`, `~/.arima/`, `:7420`, or the running `arimaops-hq-1` container when developing v2.0. Every new `.rs` file must begin with `// SPDX-License-Identifier: AGPL-3.0-or-later`.

```bash
cargo test --manifest-path server-rs/Cargo.toml
cargo clippy --manifest-path server-rs/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/client/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/client/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm test:e2e                                 # Playwright desktop + tablet + phone + live Rust HQ E2E
pnpm gen:types                               # regenerate src/data/generated.ts from arima-core
```

Master architecture spec & live milestone checklist: `context/plans/001-arimaops-v2-rust.md`.
Agent continuation prompt (for handing off across sessions or coding agents): `context/plans/001-v2-continue-prompt.md`.

## Current work: see HANDOFF.md and ROADMAP.md (both local only, gitignored)
