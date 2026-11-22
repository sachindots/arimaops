#!/usr/bin/env bash
# Hardened Ubuntu 22.04/24.04 EC2 bootstrap for ArimaOps v2.0 + Caddy HTTPS.
# Installs Docker Engine + Compose, locks UFW to 22/80/443 only, and prepares 0600 .env.

set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root (e.g. sudo ./setup-ec2.sh)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/arimaops}"

echo "[1/4] Installing base packages and Docker Engine..."
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

echo "[2/4] Configuring UFW firewall (SSH 22, HTTP 80, HTTPS 443 only)..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "SSH"
ufw allow 80/tcp comment "HTTP ACME redirect"
ufw allow 443/tcp comment "HTTPS Caddy"
ufw --force enable

echo "[3/4] Preparing ${DEPLOY_DIR} with strict permissions..."
install -d -m 0700 "${DEPLOY_DIR}" "${DEPLOY_DIR}/workspaces"
cp "${SCRIPT_DIR}/Caddyfile" "${DEPLOY_DIR}/Caddyfile"
cp "${SCRIPT_DIR}/compose.aws.yaml" "${DEPLOY_DIR}/compose.aws.yaml"
cp "${SCRIPT_DIR}/.env.aws.example" "${DEPLOY_DIR}/.env.aws.example"

if [[ ! -f "${DEPLOY_DIR}/.env" ]]; then
  install -m 0600 "${SCRIPT_DIR}/.env.aws.example" "${DEPLOY_DIR}/.env"
  echo "Created ${DEPLOY_DIR}/.env (mode 0600). Edit it before starting the stack."
else
  chmod 0600 "${DEPLOY_DIR}/.env"
  echo "Preserved existing ${DEPLOY_DIR}/.env (enforced mode 0600)."
fi

echo "[4/4] Bootstrap complete."
cat <<EOF

Next steps:
  1. Point DNS A records for hq.<domain> and *.<domain> to this EC2 instance's public IP.
  2. Edit ${DEPLOY_DIR}/.env (set ARIMA_DOMAIN, ACME_EMAIL, ARIMA_GITHUB_WEBHOOK_SECRET).
  3. Start ArimaOps v2 + Caddy:
       cd ${DEPLOY_DIR}
       docker compose -f compose.aws.yaml --env-file .env up -d
  4. Fetch the first-run bootstrap sign-in URL from logs:
       docker logs arimaops-hq-v2 | grep "token="
EOF
