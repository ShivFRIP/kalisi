#!/usr/bin/env bash
# Kalisi demo installer for contabo1 (Ubuntu 24.04). Safe to re-run: it updates and restarts in place.
#
#   bash /root/kalisi/deploy/contabo1/install.sh            # asks before changing anything
#   bash /root/kalisi/deploy/contabo1/install.sh --yes      # no questions
#   bash /root/kalisi/deploy/contabo1/install.sh --check    # only report what's there and what would change
#
# Publishes, on one HTTPS address:
#   /survey/   the commute survey             (open to anyone)
#   /demo/     the policymaker demo           (open; /demo/presenter.html has presenter notes)
#   /          the working prototype: rider, driver and control-room apps (behind one shared demo password)
#
# Web server: if nginx already owns ports 80/443 (as on contabo1), Kalisi is added to it as one more site with its
# own Let's Encrypt certificate; other sites are left alone. If nothing listens there, Kalisi runs its own Caddy.
#
# Options (environment variables):
#   KALISI_DOMAIN=kalisi.example.org   public name (default kalisi.<ip-with-dashes>.sslip.io: needs no DNS setup)
#   PROXY=nginx|caddy                  force the web-server mode instead of detecting it
#   LETSENCRYPT_EMAIL=you@example.org  certificate expiry notices (optional)
#   PUBLIC_IP=80.65.208.51            override IP detection
# Survey settings live in deploy/contabo1/.env (SURVEY_ENDPOINT, SURVEY_ORG_NAME, SURVEY_ORG_CONTACT, ...).
#
# What it never does: touch the host's PostgreSQL, other databases, other nginx sites, /root/ecourts_pg or other
# projects. Kalisi gets its own containers (project "kalisi"), its own database volume and capped CPU/memory.
set -euo pipefail

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DEPLOY/../.." && pwd)"
ENV_FILE="$DEPLOY/.env"
YES=0; [[ "${1:-}" == "--yes" ]] && YES=1
CHECK=0; [[ "${1:-}" == "--check" ]] && CHECK=1
NGINX_SITE=/etc/nginx/sites-available/kalisi
WEBROOT=/var/www/kalisi
MARK="# Managed by Kalisi deploy/contabo1/install.sh"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash $0)"
[[ -f "$ROOT/Dockerfile" && -d "$ROOT/backend/kalisi" ]] || die "run this from inside a Kalisi checkout (expected $ROOT/Dockerfile)"
command -v python3 >/dev/null || die "python3 is needed to build the demo and survey pages"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || warn "Written for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Continuing."

# ------------------------------------------------------------------ 1. look before touching anything
bold "1/7  Checking this server (read-only)"
PUBLIC_IP="${PUBLIC_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')}"
[[ -n "$PUBLIC_IP" ]] || die "could not detect the public IP; set PUBLIC_IP=..."
DOMAIN="${KALISI_DOMAIN:-kalisi.${PUBLIC_IP//./-}.sslip.io}"
if [[ -f "$ENV_FILE" && -z "${KALISI_DOMAIN:-}" ]]; then
  DOMAIN="$(grep -E '^KALISI_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"   # keep the name chosen on the first run
fi
WEB_USERS="$(ss -Htlnp '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
if [[ -z "${PROXY:-}" ]]; then
  if [[ -z "$WEB_USERS" ]] || docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^kalisi-caddy'; then PROXY=caddy
  elif ! grep -qv 'nginx' <<<"$WEB_USERS"; then PROXY=nginx
  else
    echo "$WEB_USERS"
    die "ports 80/443 are used by a web server other than nginx (above). Nothing was changed."
  fi
fi
echo "  Checkout:        $ROOT"
echo "  Public IP:       $PUBLIC_IP"
echo "  Web address:     https://$DOMAIN"
echo "  Web server:      $([[ $PROXY == nginx ]] && echo "existing nginx ($(nginx -v 2>&1 | cut -d/ -f2)): Kalisi is added as one more site" || echo "Kalisi's own Caddy on ports 80/443")"
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
if [[ $PROXY == nginx ]]; then
  [[ -f "$NGINX_SITE" ]] && ! grep -qF "$MARK" "$NGINX_SITE" && die "$NGINX_SITE exists and wasn't written by this installer. Nothing was changed."
  if grep -Rqs "autoindex on" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null; then
    warn "  Note: an existing nginx site has 'autoindex on' (a public file listing). Kalisi doesn't change it; review it separately."
  fi
fi
FW_CHANGE=""
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw status | grep -qE '^443(/tcp)?\s+ALLOW' || FW_CHANGE="allow 443/tcp in ufw"
  ufw status | grep -qE '^80(/tcp)?\s+ALLOW' || FW_CHANGE="${FW_CHANGE:+$FW_CHANGE, }allow 80/tcp in ufw"
fi

bold "Planned changes"
command -v docker >/dev/null 2>&1 || echo "  - apt install docker.io docker-compose-v2 (and enable the docker service)"
[[ -f "$ENV_FILE" ]] || echo "  - create $ENV_FILE with generated database password, sign-in secret and demo password (mode 600)"
echo "  - build and start containers kalisi-db and kalisi-app (CPU/memory capped; app on 127.0.0.1:8100 only)"
if [[ $PROXY == nginx ]]; then
  command -v certbot >/dev/null 2>&1 || echo "  - apt install certbot"
  echo "  - write $WEBROOT (demo and survey pages) and $NGINX_SITE, enable it, test the config, reload nginx"
  echo "  - get a Let's Encrypt certificate for $DOMAIN (webroot method; other sites untouched)"
else
  echo "  - start kalisi-caddy on ports 80/443 with automatic HTTPS"
fi
[[ -n "$FW_CHANGE" ]] && echo "  - $FW_CHANGE"
echo "  - load the demo network if the Kalisi database is empty"
if [[ $CHECK -eq 1 ]]; then
  echo; echo "Check only: nothing was changed. Run with --yes (or without options, to be asked) to install."
  exit 0
fi
if [[ $YES -eq 0 ]]; then
  read -r -p $'\nProceed? [y/N] ' ans
  [[ "$ans" =~ ^[Yy]$ ]] || die "nothing changed"
fi

# ------------------------------------------------------------------ 2. Docker
bold "2/7  Docker"
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
bold "3/7  Configuration"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  DEMO_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 14)"
  cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -u +%F). Keep private. Re-run install.sh after editing.
KALISI_DOMAIN=$DOMAIN
KALISI_DB_PASSWORD=$(openssl rand -hex 24)
KALISI_JWT_SECRET=$(openssl rand -hex 32)
KALISI_LOCAL_PORT=8100
DEMO_USER=demo
DEMO_PASSWORD=$DEMO_PASSWORD

# Survey (see docs/survey/SURVEY_SETUP.md). Without SURVEY_ENDPOINT the survey runs in preview mode and saves nothing.
SURVEY_ENDPOINT=
SURVEY_ORG_NAME=
SURVEY_ORG_CONTACT=
SURVEY_RETENTION=12 months
# Optional Google address search (restrict the key to https://$DOMAIN/*; see docs/survey/SETUP.md)
GOOGLE_MAPS_API_KEY=
EOF
  chmod 600 "$ENV_FILE"
  echo "  created $ENV_FILE"
else
  echo "  keeping existing $ENV_FILE"
fi
# Read KEY=VALUE lines literally (values may contain spaces, e.g. an organisation name; optional surrounding quotes
# are removed). Not `source`d, so nothing in the file is ever run as a command.
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  key="${line%%=*}"; val="${line#*=}"
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
  if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
  export "$key=$val"
done < "$ENV_FILE"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DEPLOY/docker-compose.yml")
[[ $PROXY == caddy ]] && COMPOSE+=(--profile caddy)
[[ -n "$FW_CHANGE" ]] && { ufw allow 80/tcp; ufw allow 443/tcp; }

# ------------------------------------------------------------------ 4. demo and survey pages
bold "4/7  Demo and survey pages"
STATIC_OUT="$([[ $PROXY == nginx ]] && echo "$WEBROOT" || echo "$DEPLOY/static.local")"
TMP_OUT="$(mktemp -d)"
python3 "$ROOT/static/build.py" --out "$TMP_OUT"
mkdir -p "$STATIC_OUT"
rm -rf "$STATIC_OUT/demo" "$STATIC_OUT/survey"
cp -r "$TMP_OUT/demo" "$TMP_OUT/survey" "$STATIC_OUT/"
rm -rf "$TMP_OUT"
chmod -R a+rX "$STATIC_OUT"
[[ -n "${SURVEY_ENDPOINT:-}" ]] || warn "  SURVEY_ENDPOINT is empty: the survey runs in PREVIEW mode and saves nothing. Set it in $ENV_FILE and re-run."
[[ -n "${SURVEY_ORG_NAME:-}" && -n "${SURVEY_ORG_CONTACT:-}" ]] || warn "  SURVEY_ORG_NAME / SURVEY_ORG_CONTACT are empty: the consent screen shows placeholders."

# ------------------------------------------------------------------ 5. app containers and web server
bold "5/7  Building and starting (the first build takes a few minutes)"
if [[ $PROXY == caddy ]]; then
  HASH="$(docker run --rm caddy:2.8 caddy hash-password --plaintext "$DEMO_PASSWORD")"
  sed -e "s|__KALISI_DOMAIN__|$KALISI_DOMAIN|" -e "s|__DEMO_USER__|$DEMO_USER|" -e "s|__DEMO_HASH__|$HASH|" "$DEPLOY/Caddyfile" > "$DEPLOY/Caddyfile.local"
  chmod 600 "$DEPLOY/Caddyfile.local"
fi
"${COMPOSE[@]}" up -d --build
echo -n "  waiting for the app"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${KALISI_LOCAL_PORT}/api/v1/health" >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."; sleep 2
done
curl -fsS "http://127.0.0.1:${KALISI_LOCAL_PORT}/api/v1/health" >/dev/null || { "${COMPOSE[@]}" logs --tail 60 app; die "the app did not become healthy (logs above)"; }

if [[ $PROXY == nginx ]]; then
  command -v certbot >/dev/null 2>&1 || { apt-get update -q; DEBIAN_FRONTEND=noninteractive apt-get install -y -q certbot; }
  printf '%s:%s\n' "$DEMO_USER" "$(openssl passwd -apr1 "$DEMO_PASSWORD")" > /etc/nginx/kalisi.htpasswd
  chown root:www-data /etc/nginx/kalisi.htpasswd; chmod 640 /etc/nginx/kalisi.htpasswd
  mkdir -p "$WEBROOT/acme"
  V6=""; grep -Rqs 'listen \[::\]' /etc/nginx/sites-enabled/ && V6=1
  CERT="/etc/letsencrypt/live/$KALISI_DOMAIN"
  write_site() {   # $1 = with-tls | http-only
    local L80="listen 80;${V6:+ listen [::]:80;}" L443="listen 443 ssl;${V6:+ listen [::]:443 ssl;}"
    {
      echo "$MARK"
      echo "# Kalisi: survey and demo (open), prototype (demo password). Re-running the installer rewrites this file."
      if [[ $1 == with-tls ]]; then
        cat <<EOF
server {
    $L80
    server_name $KALISI_DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT/acme; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    $L443
    server_name $KALISI_DOMAIN;
    ssl_certificate     $CERT/fullchain.pem;
    ssl_certificate_key $CERT/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
EOF
      else
        cat <<EOF
server {
    $L80
    server_name $KALISI_DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT/acme; }
EOF
      fi
      cat <<EOF
    add_header X-Robots-Tag "noindex, nofollow" always;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml application/manifest+json;
    client_max_body_size 2m;

    location = /demo   { return 308 /demo/; }
    location = /survey { return 308 /survey/; }
    location ^~ /demo/   { alias $WEBROOT/demo/; }
    location ^~ /survey/ { alias $WEBROOT/survey/; }

    location ~ ^/(manifest[^/]*\\.webmanifest|icon[^/]*|sw\\.js)\$ {   # app install files stay open
        proxy_pass http://127.0.0.1:${KALISI_LOCAL_PORT};
    }
    location / {
        auth_basic "Kalisi prototype";
        auth_basic_user_file /etc/nginx/kalisi.htpasswd;
        proxy_pass http://127.0.0.1:${KALISI_LOCAL_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
    } > "$NGINX_SITE"
    ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/kalisi
    if ! nginx -t 2>/tmp/kalisi-nginx-test.txt; then
      cat /tmp/kalisi-nginx-test.txt
      rm -f /etc/nginx/sites-enabled/kalisi
      die "nginx rejected the Kalisi site (above). It was disabled again; other sites are unaffected."
    fi
    systemctl reload nginx
  }
  if [[ -f "$CERT/fullchain.pem" ]]; then
    write_site with-tls
  else
    write_site http-only
    EMAIL_ARGS=(--register-unsafely-without-email); [[ -n "${LETSENCRYPT_EMAIL:-}" ]] && EMAIL_ARGS=(-m "$LETSENCRYPT_EMAIL")
    if certbot certonly --webroot -w "$WEBROOT/acme" -d "$KALISI_DOMAIN" --non-interactive --agree-tos "${EMAIL_ARGS[@]}" \
         --deploy-hook "systemctl reload nginx"; then
      write_site with-tls
    else
      warn "  Certificate request failed, so the site is on plain http://$KALISI_DOMAIN for now (GPS and app install need HTTPS)."
      warn "  Check that port 80 is reachable from the internet, then re-run this installer."
    fi
  fi
fi

# ------------------------------------------------------------------ 6. demo data
bold "6/7  Demo data"
sql() { "${COMPOSE[@]}" exec -T db psql -U kalisi -d kalisi -Atc "$1" 2>/dev/null || echo 0; }
if [[ "$(sql "select count(*) from audit_log where action = 'seed'")" != "0" ]]; then
  echo "  demo network already loaded; leaving the data as it is"
elif [[ "$(sql 'select count(*) from users')" != "0" ]]; then
  echo "  an earlier demo load didn't finish; reloading it from scratch"
  "${COMPOSE[@]}" exec -T app python -m kalisi.seed --reset
else
  "${COMPOSE[@]}" exec -T app python -m kalisi.seed
fi

# ------------------------------------------------------------------ 7. done
bold "7/7  Done"
SCHEME=https
[[ $PROXY == nginx && ! -f "/etc/letsencrypt/live/$KALISI_DOMAIN/fullchain.pem" ]] && SCHEME=http
echo -n "  checking $SCHEME://$KALISI_DOMAIN/survey/"
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$SCHEME://$KALISI_DOMAIN/survey/" || true)"
  [[ "$code" == 200 ]] && { echo " ok"; break; }
  echo -n "."; sleep 4
done
[[ "${code:-}" == 200 ]] || warn "  Not answering yet from this server. Check the web server logs, and that the name resolves to $PUBLIC_IP."
cat <<EOF

  Survey (share this):     $SCHEME://$KALISI_DOMAIN/survey/        add ?src=<channel> to tag where people came from
  Demo for policymakers:   $SCHEME://$KALISI_DOMAIN/demo/          presenter version: $SCHEME://$KALISI_DOMAIN/demo/presenter.html
  Working prototype:       $SCHEME://$KALISI_DOMAIN/               user "$DEMO_USER", password "$DEMO_PASSWORD" (also in $ENV_FILE)
                           sign-in codes show on screen; control room 00000 00001, demo rider 00000 10001

  Update later:   bash $DEPLOY/update.sh
  Logs:           ${COMPOSE[*]} logs -f app
  Remove:         ${COMPOSE[*]} down -v   (Kalisi's containers and database only)$([[ $PROXY == nginx ]] && echo "
                  then: rm /etc/nginx/sites-enabled/kalisi $NGINX_SITE && systemctl reload nginx")
EOF
