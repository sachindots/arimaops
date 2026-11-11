# ArimaOps: notes for coding agents

ArimaOps (அரிமா, "lion") is a multi-agent orchestrator: one Node server (`server/`) runs a team of AI agents per project, and a React + PixiJS UI (`src/`) shows them in an isometric office. Read `docs/architecture.md` before adding a module.

## Rules from the owner (Sachin)

- The name is **ArimaOps** everywhere visible. Never "dothq", ".hq" or "JSM HQ" as a name (old names live only in migration lists in `src/data/brand.ts`).
- **No AI attribution** in commits or PRs: no `Co-Authored-By` AI lines, no "Generated with" footers.
- Ask before big product decisions. Don't stop or delete the owner's running agents or projects.
- Never type secrets, TOTP codes or passwords on the owner's behalf; never answer an agent CLI's folder-trust prompt without the owner's OK.
- The repo is public: github.com/sachindots/arimaops, branch `main`. Never push `backup/*` branches.

## Build and test

```bash
pnpm install
pnpm build                                  # typecheck (UI + server), Vite build, server bundle
for t in session-backend workspace auth limits inbox scope findings planner env usage loopguard persona container office office-input accounts credentials users rename company command; do npx tsx scripts/$t-test.ts; done
```

Local dev: `pnpm dev:hq` (HQ on :7420, UI on :5173). The server keeps state in `~/.arima/`.

## Current work: see HANDOFF.md
