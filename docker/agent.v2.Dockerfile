# ArimaOps v2 agent image: the CLIs an agent runs, plus git and the usual tools.
# HQ starts it with the workspace's owner as the container user and HOME inside the workspace, so nothing here
# depends on a fixed user id. Published by .github/workflows/agent-image.yml.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh curl ca-certificates python3 python3-pip python3-venv ripgrep jq less openssh-client procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli @github/copilot opencode-ai \
 && npm cache clean --force

RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh \
 && bash /tmp/agy-install.sh --dir /usr/local/bin \
 && rm /tmp/agy-install.sh

RUN git config --system credential.https://github.com.helper '!gh auth git-credential' \
 && git config --system --add safe.directory '*'

# The codemode tool server (Tools as code), with its pinned dependencies from its lockfile.
COPY docker/codemode/package.json docker/codemode/package-lock.json /opt/arima-codemode/
RUN npm ci --prefix /opt/arima-codemode --omit=dev --ignore-scripts \
 && npm cache clean --force
COPY docker/codemode/server.mjs docker/codemode/run.mjs docker/codemode/child.cjs /opt/arima-codemode/

ENV NODE_USE_ENV_PROXY=1
WORKDIR /workspace
