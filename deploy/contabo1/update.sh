#!/usr/bin/env bash
# Pull the latest Kalisi from GitHub and re-run the installer (idempotent): rebuilds the app, the demo and survey
# pages and the web-server config. Data and settings in .env are kept; database migrations run on start.
set -euo pipefail
DEPLOY="$(cd "$(dirname "$0")" && pwd)"
git -C "$DEPLOY/../.." pull --ff-only
bash "$DEPLOY/install.sh" --yes
docker image prune -f >/dev/null
echo "Updated to $(git -C "$DEPLOY/../.." log -1 --format='%h %s')"
