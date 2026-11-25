#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installer for ArimaOps v2 (Docker Compose stack + isolated agent containers).
set -eu

ARIMA_DIR="${ARIMA_DIR:-$HOME/arimaops}"
COMPOSE_URL="${ARIMA_COMPOSE_URL:-https://raw.githubusercontent.com/sachindots/arimaops/main/compose.yaml}"
HQ_PORT="${HQ_HOST_PORT:-7420}"
PREVIEW_PORT="${HQ_PREVIEW_HOST_PORT:-7421}"
SOCK="/var/run/docker.sock"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required. Install Docker Desktop or Docker Engine first."
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin is required."
[ -S "$SOCK" ] || fail "Docker socket not found at $SOCK. Is the Docker daemon running?"

if gid="$(stat -c %g "$SOCK" 2>/dev/null)"; then
  :
elif gid="$(stat -f %g "$SOCK" 2>/dev/null)"; then
  :
else
  fail "Could not determine group ID for $SOCK"
fi

mkdir -p "$ARIMA_DIR/workspaces"

if [ -n "${ARIMA_COMPOSE_SRC:-}" ]; then
  [ -f "$ARIMA_COMPOSE_SRC" ] || fail "ARIMA_COMPOSE_SRC does not exist: $ARIMA_COMPOSE_SRC"
  cp "$ARIMA_COMPOSE_SRC" "$ARIMA_DIR/compose.yaml"
elif command -v curl >/dev/null 2>&1; then
  curl -fsSL "$COMPOSE_URL" -o "$ARIMA_DIR/compose.yaml"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$ARIMA_DIR/compose.yaml" "$COMPOSE_URL"
else
  fail "curl or wget is required to download compose.yaml"
fi

ENV_FILE="$ARIMA_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    MASTER_KEY="$(openssl rand -hex 32)"
  else
    MASTER_KEY="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
DOCKER_GID=$gid
ARIMA_MASTER_KEY=$MASTER_KEY
ARIMA_WORKSPACES_DIR=$ARIMA_DIR/workspaces
ARIMA_HQ_IMAGE=${ARIMA_HQ_IMAGE:-ghcr.io/sachindots/arimaops-v2:latest}
ARIMA_AGENT_IMAGE=${ARIMA_AGENT_IMAGE:-ghcr.io/sachindots/arimaops-agent:latest}
HQ_HOST_PORT=$HQ_PORT
HQ_PREVIEW_HOST_PORT=$PREVIEW_PORT
EOF
  chmod 600 "$ENV_FILE"
fi

if [ "${ARIMA_SKIP_PULL:-0}" != "1" ]; then
  docker compose -f "$ARIMA_DIR/compose.yaml" --env-file "$ENV_FILE" pull
fi

docker compose -f "$ARIMA_DIR/compose.yaml" --env-file "$ENV_FILE" up -d

healthy=0
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:${HQ_PORT}/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

[ "$healthy" -eq 1 ] || fail "ArimaOps HQ did not respond on http://127.0.0.1:${HQ_PORT}/api/health within 60s"

printf '\nArimaOps HQ is running at http://127.0.0.1:%s\n' "$HQ_PORT"
printf 'Check startup link / logs: docker compose -f %s/compose.yaml logs arima-hq\n' "$ARIMA_DIR"
if [ -d "$HOME/.arima" ]; then
  printf 'Detected existing v1 state in %s/.arima. Preview migration (read-only):\n' "$HOME"
  printf '  docker compose -f %s/compose.yaml --env-file %s run --rm -v %s/.arima:/v1:ro arima-hq migrate-v1 --from /v1 --to /data --dry-run\n' "$ARIMA_DIR" "$ENV_FILE" "$HOME"
fi
