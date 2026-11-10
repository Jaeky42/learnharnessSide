# LearnHarness server image (side-tutor fork, cloud sync Phase 1;
# docs/cloud-sync.md). Builds the same standalone server the desktop app
# runs, then runs it in server mode: password login gate on, data in the
# /data volume. Deploy with deploy/compose.yaml (Caddy in front for HTTPS).

# ── build ────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
# The fork's lockfile is written by npm 11 (docs/side-tutor.md).
RUN npm install -g npm@11
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG LH_BUILD_VERSION=""
ARG LH_BUILD_HOMEPAGE=""
ENV LH_BUILD_VERSION=${LH_BUILD_VERSION} LH_BUILD_HOMEPAGE=${LH_BUILD_HOMEPAGE}
RUN npx next build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs

# ── run ──────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim
# curl + CA certificates: the entrypoint installs Claude Code onto the volume.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LH_SERVER_MODE=1 \
    LH_DATA_DIR=/data/data \
    LH_AUTH_FILE=/data/secrets/auth.json \
    HOME=/data/home \
    PATH=/data/home/.local/bin:$PATH
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/scripts/server-reset-password.mjs ./scripts/server-reset-password.mjs
COPY deploy/docker-entrypoint.sh /usr/local/bin/lh-entrypoint
# `docker compose exec lh reset-password`: the forgot-password path.
RUN printf '#!/bin/sh\nexec node /app/scripts/server-reset-password.mjs "$@"\n' > /usr/local/bin/reset-password \
 && chmod 755 /usr/local/bin/reset-password \
 && chmod 755 /usr/local/bin/lh-entrypoint \
 && mkdir -p /data/data /data/secrets /data/home \
 && chown -R node:node /data \
 && chmod 700 /data/secrets
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["lh-entrypoint"]
