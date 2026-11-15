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
# Upstream 0.6.0: the core plugins are built from plugins/ into core-plugins/
# (their own dependencies first), and build-server.mjs refuses without them.
RUN npm run plugins:setup && npm run build && node scripts/smoke-provider-runtime.mjs && node scripts/build-server.mjs
# Multi-account: the gateway and the maker, two single-file bundles
# (docs/multi-account-build.md). Not part of the standalone server.
RUN node scripts/build-gateway.mjs

# ── run ──────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim
# curl + CA certificates: the entrypoint installs Claude Code onto the volume.
# Chromium: the demo agent runs every demo in a browser before it is shown
# (src/agent/subagents/headless.ts). The desktop app uses its own Electron
# for that; the server has none, so without a browser every demo failed with
# "No render engine available". /usr/bin/chromium is on the checker's own
# list of places to look. A font, so a demo's text has a size when measured.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LH_SERVER_MODE=1 \
    LH_DATA_DIR=/data/data \
    LH_AUTH_FILE=/data/secrets/auth.json \
    LH_VAULT_DIR=/data/vault \
    HOME=/data/home \
    PATH=/data/home/.local/bin:$PATH
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/scripts/server-reset-password.mjs ./scripts/server-reset-password.mjs
COPY --from=build /src/gateway-dist/gateway.mjs /src/gateway-dist/maker.mjs /app/gateway/
COPY deploy/docker-entrypoint.sh /usr/local/bin/lh-entrypoint
# `docker compose exec lh reset-password`: the forgot-password path. Where a
# gateway runs (LH_GATEWAY_FILE set, its container) it resets the owner's
# account there instead; everywhere else it is the single-copy reset as ever.
# `lh-gateway` and `lh-maker` start the two multi-account programs.
RUN printf '#!/bin/sh\nif [ -n "${LH_GATEWAY_FILE:-}" ]; then exec lh-gateway reset-owner "$@"; fi\nexec node /app/scripts/server-reset-password.mjs "$@"\n' > /usr/local/bin/reset-password \
 && printf '#!/bin/sh\nexec node /app/gateway/gateway.mjs "$@"\n' > /usr/local/bin/lh-gateway \
 && printf '#!/bin/sh\nexec node /app/gateway/maker.mjs "$@"\n' > /usr/local/bin/lh-maker \
 && chmod 755 /usr/local/bin/reset-password /usr/local/bin/lh-gateway /usr/local/bin/lh-maker \
 && chmod 755 /usr/local/bin/lh-entrypoint \
 && mkdir -p /data/data /data/secrets /data/home /data/vault /gateway \
 && chown -R node:node /data /gateway \
 && chmod 700 /data/secrets /gateway
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["lh-entrypoint"]
