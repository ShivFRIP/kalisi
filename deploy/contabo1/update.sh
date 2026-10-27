#!/usr/bin/env bash
# Pull the latest Kalisi from GitHub and rebuild in place. Data is kept; database migrations run on start.
set -euo pipefail
DEPLOY="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DEPLOY/../.." && pwd)"
cd "$ROOT"
git pull --ff-only
PROFILE=()
[[ -f "$DEPLOY/Caddyfile.local" ]] && PROFILE=(--profile caddy)
docker compose --env-file "$DEPLOY/.env" -f "$DEPLOY/docker-compose.yml" "${PROFILE[@]}" up -d --build
docker image prune -f >/dev/null
echo "Updated to $(git log -1 --format='%h %s')"
