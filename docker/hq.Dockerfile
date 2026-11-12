# ArimaOps HQ as one image: the server, tmux, git, gh, the Docker CLI and the agent CLIs.
# Built from the repo root:   docker build -f docker/hq.Dockerfile -t arimaops .
# Run it with compose.yaml (host network, Docker socket, your home folder at the same path).

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/fix-node-pty.mjs scripts/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git tmux jq less openssh-client procps ripgrep python3 \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/github.gpg \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/github.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh docker-ce-cli docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs for Local mode (Container mode uses the arimaops-agent image, which HQ builds on first use).
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli @github/copilot opencode-ai \
 && npm cache clean --force
RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh \
 && bash /tmp/agy-install.sh --dir /usr/local/bin \
 && rm /tmp/agy-install.sh

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/bin bin
COPY --from=build /app/dist dist
COPY --from=build /app/dist-server dist-server
COPY --from=build /app/docker docker
COPY LICENSE NOTICE TRADEMARKS.md README.md ./

# Any user id works (compose runs it as yours); git trusts the mounted repos.
RUN git config --system --add safe.directory '*' \
 && git config --system credential.https://github.com.helper '!gh auth git-credential'

ENTRYPOINT ["node", "/app/bin/arimaops.mjs"]
CMD ["--help"]
