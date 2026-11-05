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
