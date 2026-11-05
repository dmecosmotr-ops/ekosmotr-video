#!/usr/bin/env bash
# Disposable CI data only. Never run this script against a company deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
export PILOT_IMAGE="${1:?Usage: bash deploy/container-smoke.sh IMAGE}"
project="camera-pilot-ci-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
temporary="$(mktemp -d)"
chmod 700 "$temporary"
export PILOT_PUBLIC_ORIGIN=https://camera-pilot-ci.example.invalid
export PILOT_ADMIN_EMAIL=ci-admin@example.invalid
export PILOT_ADMIN_PASSWORD_FILE_HOST="$temporary/admin-password.txt"
export PILOT_PUBLISHED_PORT=0
node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(36).toString("base64"));' > "$PILOT_ADMIN_PASSWORD_FILE_HOST"
# Local Compose file secrets keep host ownership; the isolated CI folder is 0700.
chmod 444 "$PILOT_ADMIN_PASSWORD_FILE_HOST"
cleanup() {
  docker compose -p "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$PILOT_ADMIN_PASSWORD_FILE_HOST"
  rmdir "$temporary"
}
trap cleanup EXIT
docker compose -p "$project" config --quiet
docker compose -p "$project" up --no-build --detach --wait --wait-timeout 90
docker compose -p "$project" exec -T camera-pilot node --input-type=module < deploy/server-smoke.mjs
