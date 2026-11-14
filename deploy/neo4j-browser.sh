#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Puts the Neo4j Browser on your tailnet only (docs/memory-core.md section 9). Run on the server, once:
#   bash deploy/neo4j-browser.sh            # serve
#   bash deploy/neo4j-browser.sh off        # stop serving
# Neo4j binds 127.0.0.1 (compose.yaml), so the LAN and the internet never reach it; Tailscale adds HTTPS
# for the tailnet. The Browser page connects to Bolt from your own device, so Bolt is served too.
# Sign in with user neo4j and ARIMA_NEO4J_PASSWORD: tailnet members without it see only the login page.
set -euo pipefail
HTTP_PORT="${ARIMA_NEO4J_HTTP_PORT:-7474}"
BOLT_PORT="${ARIMA_NEO4J_PORT:-7687}"
command -v tailscale >/dev/null || { echo "tailscale isn't installed here." >&2; exit 1; }

if [ "${1:-}" = "off" ]; then
  tailscale serve --https="$HTTP_PORT" off || true
  tailscale serve --https="$BOLT_PORT" off || true
  echo "Neo4j Browser is no longer served on the tailnet."
  exit 0
fi

tailscale serve --bg --https="$HTTP_PORT" "http://127.0.0.1:$HTTP_PORT"
# Bolt over WebSocket, TLS ended by Tailscale: the Browser connects with neo4j+s://<this host>:BOLT_PORT.
tailscale serve --bg --https="$BOLT_PORT" "http://127.0.0.1:$BOLT_PORT"
HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
cat <<MSG
Neo4j Browser: https://$HOST:$HTTP_PORT/browser/
  Connect URL: neo4j+s://$HOST:$BOLT_PORT   user: neo4j   password: ARIMA_NEO4J_PASSWORD from .env
Set ARIMA_NEO4J_BROWSER_URL=https://$HOST:$HTTP_PORT/browser/ in .env to get a link in Settings → Memory.
MSG
