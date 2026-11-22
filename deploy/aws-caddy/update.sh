#!/usr/bin/env bash
# Pulls the latest published HQ image and restarts the HQs that run on this host. Safe to rerun.
# Usage: sudo ./update.sh            (uses ARIMA_HQ_IMAGE from /opt/arimaops/.env)
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/arimaops}"
cd "$DEPLOY_DIR"

set -a
. ./.env
set +a
IMAGE="${ARIMA_HQ_IMAGE:?set ARIMA_HQ_IMAGE in .env, e.g. ghcr.io/sachindots/arimaops-v2:latest}"
PORT="${HQ_HOST_PORT:-7420}"

echo "Pulling ${IMAGE}"
docker pull "$IMAGE"

echo "Restarting HQ"
docker compose -f compose.aws.yaml --env-file .env up -d arima-hq
if [[ -f compose.demo.yaml ]]; then
  echo "Restarting demo HQ"
  docker compose -p arimaops-demo -f compose.demo.yaml --env-file .env up -d
fi

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "HQ is healthy: $(curl -fsS "http://127.0.0.1:${PORT}/api/health")"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done
echo "HQ did not become healthy; check: docker logs arimaops-hq-v2" >&2
exit 1
