# ──────────────────────────────────────────────────────────────────────────────
# sfu.sideby.me — multi-stage build (Node 22, mediasoup worker build deps)
#
# Stage 1 (build): mediasoup's postinstall downloads a PREBUILT mediasoup-worker
# binary for the platform (the primary path). When the prebuilt download is
# unavailable, the postinstall falls back to compiling the C++ worker locally —
# which needs python3 + make + g++. We install that toolchain in the build stage
# only so the fallback never breaks the build (RESEARCH A2). The runtime stage
# carries no toolchain — only the already-built node_modules + dist.
#
# tini PID-1 is provided by `init: true` in docker-compose (reaps the mediasoup
# C++ worker subprocesses — Pitfall 4), so no ENTRYPOINT tini here.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

# mediasoup local-build fallback toolchain (prebuilt worker download is the primary path).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. `npm ci` runs the mediasoup postinstall
# (fetches/builds mediasoup-worker — expected/legitimate per the package audit).
COPY package*.json ./
RUN npm ci

# Compile TypeScript → dist (this is the authoritative `tsc` for the service;
# Plans 02/03/04 deferred their local typecheck to this stage).
COPY . .
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2 (runtime): slim Node 22 carrying only node_modules + dist.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]
