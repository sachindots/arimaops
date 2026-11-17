# ArimaOps verifier image (docs/factory.md section 7): the agent image plus Playwright and Chromium, for the verifier
# role only, so no other agent carries a browser. Build after the agent image:
#   docker build -t arimaops-verifier --build-arg UID=$(id -u) --build-arg GID=$(id -g) -f docker/verifier.Dockerfile docker
FROM arimaops-agent

ARG UID=1000
ARG GID=1000

USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright@1.49.1 \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

USER ${UID}:${GID}
WORKDIR /work
