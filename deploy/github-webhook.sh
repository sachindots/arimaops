#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Lets GitHub reach HQ's webhook, and nothing else of HQ (docs/agent-engine.md section 6). Run on the server:
#   bash deploy/github-webhook.sh           # publish the webhook path with Tailscale Funnel
#   bash deploy/github-webhook.sh off       # stop
# Funnel makes a whole port public, so the webhook gets its own port (8443) with only /api/github/webhook on it:
# any other path there is a 404 from Tailscale. Never turn Funnel on for the port HQ's own pages are served on.
# HQ drops every delivery whose signature doesn't match the App's secret.
set -euo pipefail
HQ_PORT="${HQ_PORT:-7420}"
FUNNEL_PORT="${ARIMA_WEBHOOK_PORT:-8443}"
WEBHOOK_PATH="/api/github/webhook"
command -v tailscale >/dev/null || { echo "tailscale isn't installed here." >&2; exit 1; }
case "$FUNNEL_PORT" in 443|8443|10000) ;; *) echo "Funnel only serves ports 443, 8443 and 10000." >&2; exit 1 ;; esac

if [ "${1:-}" = "off" ]; then
  tailscale funnel --https="$FUNNEL_PORT" off || true
  echo "The GitHub webhook is no longer public. HQ falls back to polling GitHub."
  exit 0
fi

if tailscale serve status 2>/dev/null | grep -q ":$FUNNEL_PORT"; then
  echo "Something is already served on port $FUNNEL_PORT. Free it (or set ARIMA_WEBHOOK_PORT) so only the webhook is public there." >&2
  exit 1
fi
tailscale funnel --bg --https="$FUNNEL_PORT" --set-path="$WEBHOOK_PATH" "http://127.0.0.1:$HQ_PORT$WEBHOOK_PATH"
HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
cat <<MSG
GitHub webhook: https://$HOST:$FUNNEL_PORT$WEBHOOK_PATH (public, this path only)
In HQ: Settings → Workflow → GitHub App, enter https://$HOST:$FUNNEL_PORT as the public address, then Create GitHub App.
MSG
