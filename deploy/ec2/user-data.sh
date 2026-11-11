#!/usr/bin/env bash
# First boot of an ArimaOps server (Ubuntu 24.04). Installs ArimaOps from GitHub and runs it under systemd,
# listening on 127.0.0.1 only. Devices reach it through Tailscale (HTTPS, your tailnet only): see README.md.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
REPO="https://github.com/sachindots/arimaops.git"

apt-get update
apt-get install -y ca-certificates curl git tmux jq unzip build-essential
# Node.js 22 (NodeSource) and pnpm.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pnpm@10
# GitHub CLI (pull requests and reviews).
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y gh
# Docker, for Container mode.
curl -fsSL https://get.docker.com | sh
# Tailscale: you sign it in after boot (README.md), nothing is exposed until then.
curl -fsSL https://tailscale.com/install.sh | sh

# The service user owns ArimaOps, its projects and ~/.arima.
id arima >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker arima
sudo -u arima bash -lc "
  set -e
  git clone --depth 1 $REPO ~/arimaops
  cd ~/arimaops && pnpm install --frozen-lockfile && pnpm build
  mkdir -p ~/projects/hq-home && cd ~/projects/hq-home && git init -q -b main && echo '# HQ home' > README.md && git add . && git -c user.name=arima -c user.email=arima@localhost commit -qm init
"
# Agent CLIs (each signs in once from its terminal in HQ).
npm install -g @anthropic-ai/claude-code @openai/codex || true

# The vault's master key: generated once, readable by root only, handed to the service by systemd.
install -d -m 700 /etc/arimaops
[ -f /etc/arimaops/env ] || { umask 077; echo "ARIMA_MASTER_KEY=$(openssl rand -hex 32)" > /etc/arimaops/env; }

cat > /etc/systemd/system/arimaops.service <<'UNIT'
[Unit]
Description=ArimaOps HQ
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=arima
WorkingDirectory=/home/arima/arimaops
EnvironmentFile=/etc/arimaops/env
ExecStart=/usr/bin/node bin/arimaops.mjs --repo /home/arima/projects/hq-home --port 7420 --remote --no-open
Restart=on-failure
RestartSec=5
# Agents run in tmux and outlive a restart of HQ.
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now arimaops
echo "ArimaOps installed" > /var/log/arimaops-ready
