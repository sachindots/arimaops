# .hq agent image for Container mode (plain Docker). Built once on the host:
#   docker build -t dothq-agent --build-arg UID=$(id -u) --build-arg GID=$(id -g) -f docker/agent.Dockerfile docker
# Runs as your user id, so files in the agent's folder stay yours.
FROM node:22-bookworm-slim

ARG UID=1000
ARG GID=1000

RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh curl ca-certificates python3 python3-pip python3-venv ripgrep jq less openssh-client procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli @github/copilot opencode-ai \
 && npm cache clean --force

# A user with your ids (the base image's "node" user may already own 1000). Login volumes mount over these folders;
# an empty named volume takes the folder's owner from the image, so the CLIs can write their sign-in.
RUN (getent group "$GID" >/dev/null || groupadd -g "$GID" agent) \
 && (getent passwd "$UID" >/dev/null || useradd -u "$UID" -g "$GID" -d /home/agent -M -s /bin/bash agent) \
 && mkdir -p /home/agent/.gemini /home/agent/.copilot /home/agent/.local/share/opencode /auth/claude /auth/codex /work \
 && chown -R "$UID:$GID" /home/agent /auth /work \
 && git config --system credential.https://github.com.helper '!gh auth git-credential' \
 && git config --system --add safe.directory /work

ENV HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/auth/claude \
    CODEX_HOME=/auth/codex \
    NODE_USE_ENV_PROXY=1

USER ${UID}:${GID}
WORKDIR /work
