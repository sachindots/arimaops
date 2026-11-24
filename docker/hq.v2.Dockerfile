# SPDX-License-Identifier: AGPL-3.0-or-later
# ArimaOps v2.0 — Single-Binary Multi-Stage HQ Dockerfile (embeds React dist/ into static Rust binary)

# Stage 1: Build the React UI bundle (dist/)
FROM node:24-trixie-slim AS ui-builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.23.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY scripts/fix-node-pty.mjs ./scripts/fix-node-pty.mjs
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN pnpm exec vite build

# Stage 2: Build the release Rust arima-server binary embedding dist/
FROM rust:1.100.0-slim-trixie AS rust-builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server-rs ./server-rs
COPY --from=ui-builder /app/dist ./dist
ENV ARIMA_DIST_DIR=/app/dist
RUN cargo build --release --manifest-path server-rs/Cargo.toml --bin arima-server

# Stage 3: Minimal non-root runtime image
FROM debian:trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 arima \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin arima \
    && mkdir -p /data /workspaces \
    && chown -R arima:arima /data /workspaces

COPY --from=rust-builder /app/server-rs/target/release/arima-server /usr/local/bin/arima-server

USER arima:arima
WORKDIR /workspaces

ENV ARIMA_HOME=/data \
    HQ_HOST=0.0.0.0 \
    HQ_PORT=7420 \
    HQ_PREVIEW_PORT=7421 \
    RUST_LOG=info

EXPOSE 7420 7421

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD curl -fsS http://127.0.0.1:7420/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/arima-server"]
