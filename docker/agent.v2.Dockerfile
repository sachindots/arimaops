# SPDX-License-Identifier: AGPL-3.0-or-later
# ArimaOps v2.0 — Multi-Arch Agent Container Image baking native arima-shim (amd64 / arm64)

FROM --platform=$BUILDPLATFORM rust:1.85-slim-bookworm AS shim-builder
ARG TARGETARCH
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config gcc g++ ca-certificates \
    gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
    gcc-x86-64-linux-gnu libc6-dev-amd64-cross \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu

COPY server-rs ./server-rs

ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc

RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) RUST_TARGET="aarch64-unknown-linux-gnu" ;; \
      amd64|*) RUST_TARGET="x86_64-unknown-linux-gnu" ;; \
    esac; \
    cargo build --release --manifest-path server-rs/Cargo.toml --target "${RUST_TARGET}" --bin arima-shim; \
    cp "server-rs/target/${RUST_TARGET}/release/arima-shim" /tmp/arima-shim

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10002 agent \
    && useradd --uid 10002 --gid 10002 --create-home --shell /bin/bash agent \
    && mkdir -p /workspace /run/arima/secrets \
    && chown -R agent:agent /workspace /run/arima

COPY --from=shim-builder /tmp/arima-shim /usr/local/bin/arima-shim
RUN chmod 0755 /usr/local/bin/arima-shim

USER agent:agent
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/arima-shim"]
CMD ["--version"]
