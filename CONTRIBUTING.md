# Contributing to ArimaOps

## Run it from source

Needs Node.js 22+ and pnpm 10 or 11 (`corepack enable` gets you pnpm), plus Rust (stable) and Docker when running the HQ server locally.

```bash
git clone https://github.com/sachindots/arimaops && cd arimaops
pnpm install
pnpm dev:ui                                # the UI with fake data, no agents
HQ_PORT=7430 pnpm dev                      # the Rust HQ server (needs built dist/)
```

`pnpm dev:ui` is a demo with fake data: nothing runs and nothing leaves the browser. To test a change end-to-end against the Rust HQ, build the UI (`pnpm build`) and run `pnpm dev`, or run the Docker / Playwright suite (`PLAYWRIGHT_PORT=47313 HQ_PORT=47399 pnpm test:e2e`).

| Command | Does |
| --- | --- |
| `pnpm dev:ui` | Demo UI with fake data at http://localhost:5173 |
| `pnpm dev` | Runs `server-rs/` (`arima-server`) against built `dist/` |
| `pnpm build` | Type-checks and builds the UI to `dist/` |
| `pnpm typecheck` | Type-check only |
| `pnpm test` | Runs every `scripts/*-test.ts` suite |
| `cargo test --manifest-path server-rs/Cargo.toml` | Runs Rust HQ unit & integration tests |

Start HQ with `HQ_DEBUG=1` to log why a queued message is waiting.

## Where things are

```
src/
  data/      Types, the OfficeDataSource interface, fake (data/mock) and real (data/ws) data
  store/     Zustand stores; the only code that talks to the data source
  office/    The PixiJS pixel office: layout, sprites, agents, belt
  ui/        Top bar, team panel, activity, drawers, settings, setup checklist, welcome
server-rs/   Rust HQ workspace (`crates/arima-*`): SQLite store, container runtime, auth, MCP, GitHub webhooks
apps/client/ Tauri desktop & Android client
docker/      v2 HQ image (`hq.v2.Dockerfile`), sandbox & verifier images
docs/        User guides and design docs
context/     Implementation plans
```

## Docker Sandboxes versions

HQ calls the `sbx` CLI and reads its output. sbx 0.48 changed several outputs (for example `sbx ls --json` and `sbx mcp ls --json` now return a bare array), so read sbx output in a way that accepts both the old and the new format. HQ is tested on sbx 0.47 and 0.50.

## Releasing

1. Bump `version` in `package.json` and merge to `main`.
2. Tag the commit `v<version>` and push the tag. The **Release** workflow builds, runs the tests, packs the tarball, writes `SHA256SUMS`, attaches a signed build-provenance attestation and creates the GitHub release.
3. Publish to npm from the release's tarball with provenance: `npm publish arimaops-<version>.tgz --provenance` (needs the `NPM_TOKEN` secret if run from CI).

Check a download: `sha256sum -c SHA256SUMS` and `gh attestation verify arimaops-<version>.tgz --repo sachindots/arimaops`.
