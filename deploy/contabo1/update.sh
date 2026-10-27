#!/usr/bin/env bash
# Pull the latest Kalisi from GitHub and re-run the installer (idempotent): rebuilds the app, the demo and survey
# pages and the web-server config. Data and settings in .env are kept; database migrations run on start.
set -euo pipefail
DEPLOY="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -d "$DEPLOY/../../.git" ]]; then
  echo "This copy was deployed by GitHub Actions (no git checkout here). To update, push to the deploy/contabo1 branch"
  echo "with [install] in the commit message, or run 'Deploy to contabo1' from the repository's Actions tab."
  exit 1
fi
git -C "$DEPLOY/../.." pull --ff-only
bash "$DEPLOY/install.sh" --yes
docker image prune -f >/dev/null
echo "Updated to $(git -C "$DEPLOY/../.." log -1 --format='%h %s')"
