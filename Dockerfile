# syntax=docker/dockerfile:1
# Update deliberately after CI and review. A version tag is not a digest pin.
ARG NODE_IMAGE=node:24.22.2-bookworm-slim
FROM ${NODE_IMAGE} AS frontend-build
ARG PNPM_VERSION=10.28.2
WORKDIR /build/frontend
RUN npm install --global "pnpm@${PNPM_VERSION}" --ignore-scripts --no-audit --no-fund
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/index.html frontend/vite.config.js ./
COPY frontend/src ./src
RUN pnpm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PILOT_DEPLOYMENT=server \
    PILOT_HOST=0.0.0.0 \
    PILOT_PORT=3210 \
    PILOT_DB=/var/lib/camera-pilot/pilot.sqlite
WORKDIR /app
RUN mkdir -p /var/lib/camera-pilot && chown 1000:1000 /var/lib/camera-pilot
COPY --chown=1000:1000 backend ./backend
COPY --chown=1000:1000 data/stations.json ./data/stations.json
COPY --chown=1000:1000 --from=frontend-build /build/frontend/dist ./frontend/dist
COPY --chown=1000:1000 deploy/healthcheck.mjs deploy/database-backup.mjs deploy/database-restore.mjs ./deploy/
USER 1000:1000
VOLUME ["/var/lib/camera-pilot"]
EXPOSE 3210
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "backend/server.mjs"]

# Opt-in runtime for the cabinet and its Xiaomi catalog synchronizer.
FROM runtime AS xiaomi-runtime
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg openjdk-17-jdk-headless python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/xiaomi \
    && install -d -m 0700 -o 1000 -g 1000 /var/lib/xiaomi/private/catalog /run/private/runtime \
    && install -m 0600 -o 1000 -g 1000 /dev/null /var/lib/xiaomi/private/catalog/.volume-ready \
    && install -d /run/private/config /run/private/session /opt/relay /opt/vendor/classes
COPY tools/requirements-diagnostic.txt ./tools/
RUN /opt/xiaomi/bin/pip install --no-cache-dir -r tools/requirements-diagnostic.txt
COPY tools/xiaomi_cloud_probe.py tools/xiaomi_live_bridge.py tools/xiaomi_shared_inventory.py \
     tools/xiaomi_cabinet_bundle.py tools/xiaomi_sync.py tools/RelayLive.java ./tools/
COPY deploy/build-relay.sh ./deploy/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000:1000

# A plain Docker build continues to produce the original cabinet image.
FROM runtime AS default-runtime
