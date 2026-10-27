#!/usr/bin/env bash
# Kalisi demo installer for contabo1 (Ubuntu 24.04). Safe to re-run: it updates and restarts in place.
#
#   bash /root/kalisi/deploy/contabo1/install.sh            # asks before changing anything
#   bash /root/kalisi/deploy/contabo1/install.sh --yes      # no questions
#
# Options (environment variables):
#   KALISI_DOMAIN=kalisi.example.org   public name (default: kalisi.<ip-with-dashes>.sslip.io, needs no DNS setup)
#   PROXY=existing                      ports 80/443 belong to another web server: run Kalisi on 127.0.0.1:8100 only
#                                       and print a site config for that server instead of starting Caddy
#   PUBLIC_IP=80.65.208.51             override IP detection
#
# What it never does: touch the host's PostgreSQL, other databases, /root/ecourts_pg or other projects.
# Kalisi gets its own containers (project "kalisi"), its own database volume and capped CPU/memory.
set -euo pipefail

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DEPLOY/../.." && pwd)"
ENV_FILE="$DEPLOY/.env"
YES=0; [[ "${1:-}" == "--yes" ]] && YES=1
PROXY="${PROXY:-caddy}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash $0)"
[[ -f "$ROOT/Dockerfile" && -d "$ROOT/backend/kalisi" ]] || die "run this from inside a Kalisi checkout (expected $ROOT/Dockerfile)"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || warn "Written for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Continuing."

# ------------------------------------------------------------------ 1. look before touching anything
bold "1/6  Checking this server (read-only)"
PUBLIC_IP="${PUBLIC_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')}"
[[ -n "$PUBLIC_IP" ]] || die "could not detect the public IP; set PUBLIC_IP=..."
DOMAIN="${KALISI_DOMAIN:-kalisi.${PUBLIC_IP//./-}.sslip.io}"
if [[ -f "$ENV_FILE" ]] && [[ -z "${KALISI_DOMAIN:-}" ]]; then
  DOMAIN="$(grep -E '^KALISI_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"   # keep the name chosen on the first run
fi
echo "  Checkout:        $ROOT"
echo "  Public IP:       $PUBLIC_IP"
echo "  Web address:     https://$DOMAIN"
echo "  Free disk:       $(df -h --output=avail / | tail -1 | tr -d ' ')   Memory: $(free -h | awk '/Mem:/{print $2" total, "$7" available"}')"
if command -v docker >/dev/null 2>&1; then
  echo "  Docker:          $(docker --version 2>/dev/null)"
  echo "  Containers now:  $(docker ps --format '{{.Names}}' | tr '\n' ' ' | sed 's/ $//')"
else
  echo "  Docker:          not installed (will install Ubuntu's docker.io + docker-compose-v2 packages)"
fi
if command -v pg_lsclusters >/dev/null 2>&1 || ss -Htln '( sport = :5432 )' 2>/dev/null | grep -q .; then
  echo "  Host PostgreSQL: present. Kalisi will NOT use or modify it (it runs its own database in a container)."
fi

OURS_ON_WEB=0
docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^kalisi-caddy' && OURS_ON_WEB=1
WEB_USERS="$(ss -Htlnp '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
if [[ "$PROXY" == caddy && -n "$WEB_USERS" && $OURS_ON_WEB -eq 0 ]]; then
  echo "$WEB_USERS"
  die "ports 80/443 are already used by another web server (above). Nothing was changed.
  Re-run with PROXY=existing to run Kalisi on 127.0.0.1:8100 and get a site config for that server."
fi

UFW_CHANGE=""
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [[ "$PROXY" == caddy ]] && ! ufw status | grep -qE '^(80|443)(/tcp)?\s+ALLOW'; then UFW_CHANGE="allow 80/tcp and 443/tcp in ufw"; fi
fi

bold "Planned changes"
command -v docker >/dev/null 2>&1 || echo "  - apt install docker.io docker-compose-v2 (and enable the docker service)"
[[ -f "$ENV_FILE" ]] || echo "  - create $ENV_FILE with generated database password, sign-in secret and demo password (mode 600)"
echo "  - build and start containers kalisi-db, kalisi-app$([[ $PROXY == caddy ]] && echo ', kalisi-caddy (ports 80/443, automatic HTTPS)') (CPU/memory capped)"
[[ -n "$UFW_CHANGE" ]] && echo "  - $UFW_CHANGE"
echo "  - load the demo network if the Kalisi database is empty"
if [[ $YES -eq 0 ]]; then
  read -r -p $'\nProceed? [y/N] ' ans
  [[ "$ans" =~ ^[Yy]$ ]] || die "nothing changed"
fi

# ------------------------------------------------------------------ 2. Docker
bold "2/6  Docker"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io docker-compose-v2
  systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-compose-v2 || DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-compose-plugin
fi
docker compose version

# ------------------------------------------------------------------ 3. secrets and config
bold "3/6  Configuration"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  DEMO_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 14)"
  cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -u +%F). Keep private.
KALISI_DOMAIN=$DOMAIN
KALISI_DB_PASSWORD=$(openssl rand -hex 24)
KALISI_JWT_SECRET=$(openssl rand -hex 32)
KALISI_LOCAL_PORT=8100
DEMO_USER=demo
DEMO_PASSWORD=$DEMO_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
  echo "  created $ENV_FILE"
else
  echo "  keeping existing $ENV_FILE"
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DEPLOY/docker-compose.yml")
if [[ "$PROXY" == caddy ]]; then
  COMPOSE+=(--profile caddy)
  # The password hash contains '$', so it is written straight into the Caddyfile rather than passed through .env.
  HASH="$(docker run --rm caddy:2.8 caddy hash-password --plaintext "$DEMO_PASSWORD")"
  sed -e "s|__KALISI_DOMAIN__|$KALISI_DOMAIN|" -e "s|__DEMO_USER__|$DEMO_USER|" -e "s|__DEMO_HASH__|$HASH|" "$DEPLOY/Caddyfile" > "$DEPLOY/Caddyfile.local"
  chmod 600 "$DEPLOY/Caddyfile.local"
  [[ -n "$UFW_CHANGE" ]] && { ufw allow 80/tcp; ufw allow 443/tcp; }
fi

# ------------------------------------------------------------------ 4. build and start
bold "4/6  Building and starting (the first build takes a few minutes)"
"${COMPOSE[@]}" up -d --build
echo -n "  waiting for the app"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${KALISI_LOCAL_PORT}/api/v1/health" >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."; sleep 2
done
curl -fsS "http://127.0.0.1:${KALISI_LOCAL_PORT}/api/v1/health" >/dev/null || { "${COMPOSE[@]}" logs --tail 60 app; die "the app did not become healthy (logs above)"; }

# ------------------------------------------------------------------ 5. demo data
bold "5/6  Demo data"
sql() { "${COMPOSE[@]}" exec -T db psql -U kalisi -d kalisi -Atc "$1" 2>/dev/null || echo 0; }
if [[ "$(sql "select count(*) from audit_log where action = 'seed'")" != "0" ]]; then
  echo "  demo network already loaded; leaving the data as it is"
elif [[ "$(sql 'select count(*) from users')" != "0" ]]; then
  echo "  an earlier demo load didn't finish; reloading it from scratch"
  "${COMPOSE[@]}" exec -T app python -m kalisi.seed --reset
else
  "${COMPOSE[@]}" exec -T app python -m kalisi.seed
fi

# ------------------------------------------------------------------ 6. done
bold "6/6  Done"
if [[ "$PROXY" == caddy ]]; then
  echo -n "  checking HTTPS (the certificate can take a minute)"
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "https://$KALISI_DOMAIN/manifest.webmanifest" || true)"
    [[ "$code" == 200 ]] && { echo " ok"; break; }
    echo -n "."; sleep 4
  done
  [[ "${code:-}" == 200 ]] || warn "  HTTPS isn't answering yet. Check: ${COMPOSE[*]} logs caddy"
  cat <<EOF

  Open:           https://$KALISI_DOMAIN
  Demo password:  user "$DEMO_USER", password "$DEMO_PASSWORD"   (also in $ENV_FILE)
EOF
else
  cat <<EOF

  Kalisi is running on http://127.0.0.1:${KALISI_LOCAL_PORT} (local only). Add a site to your web server, e.g. nginx:

    server {
        server_name $KALISI_DOMAIN;
        location / {
            proxy_pass http://127.0.0.1:${KALISI_LOCAL_PORT};
            proxy_set_header Host \$host;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
        }
    }

  then enable HTTPS for it (e.g. certbot --nginx -d $KALISI_DOMAIN). Browsers need HTTPS for GPS and app install.
EOF
fi
cat <<EOF
  Sign-in:        codes are shown on screen (demo mode). Control room 00000 00001, demo rider 00000 10001;
                  drivers are listed on the driver sign-in page.
  Update later:   bash $DEPLOY/update.sh
  Logs:           ${COMPOSE[*]} logs -f app
  Remove:         ${COMPOSE[*]} down -v      (deletes Kalisi's containers and its database only)
EOF
