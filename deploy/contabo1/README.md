# Deploying Kalisi on contabo1

One installer publishes three things on one HTTPS address:

| Link | What | Access |
|---|---|---|
| `https://<address>/survey/` | The commute survey (`?src=<channel>` tags where people came from) | Open to anyone |
| `https://<address>/demo/` | The policymaker demo; `/demo/presenter.html` adds presenter notes and controls | Open to anyone |
| `https://<address>/` | The working prototype: rider, driver and control-room apps | One shared demo password |

The default address is `kalisi.80-65-208-51.sslip.io`. sslip.io is a public DNS service that resolves that name to 80.65.208.51 (checked on 27 Oct 2026), so no DNS setup is needed.

## How it fits on contabo1

contabo1 already runs **nginx** on port 80, so the installer adds Kalisi as **one more nginx site**:
- It writes `/etc/nginx/sites-available/kalisi` and the demo/survey pages in `/var/www/kalisi`.
- It tests the nginx config and reloads nginx (a reload, not a restart). If the test fails, it disables its own site again and stops.
- It gets a Let's Encrypt certificate for Kalisi's name with `certbot certonly --webroot`, so certbot never edits nginx files. Renewal is automatic (Ubuntu's certbot timer), and nginx reloads after each renewal.
- **Other nginx sites are not modified.**

The app and its database run in Docker containers with capped resources:

| Container | Role | Limits |
|---|---|---|
| `kalisi-db` | Kalisi's own database (PostgreSQL 16 + PostGIS) | 1 CPU, 1 GB |
| `kalisi-app` | API, simulator and web apps; on 127.0.0.1:8100 only | 2 CPU, 2 GB |

The installer does **not** use or change the host's PostgreSQL, `ecourts_india`, `/root/ecourts_pg` or other projects.

**A note about the existing nginx site.** Today, port 80 on 80.65.208.51 shows a public directory listing ("Index of /") of `proxy.py`, `setup_mac.sh` and `setup_windows.ps1`. Anyone can download those files. Kalisi doesn't change that site, but it's worth checking those files and turning the listing off.

## First install (about 10 minutes, mostly the first build)

On contabo1, as root:

```bash
# 1. A read-only deploy key, so the server can pull this private repository
ssh-keygen -t ed25519 -N "" -f ~/.ssh/kalisi_deploy -C "contabo1 kalisi deploy"
cat ~/.ssh/kalisi_deploy.pub
```

2. On GitHub, open ShivFRIP/kalisi → **Settings → Deploy keys → Add deploy key**:
   - paste that line;
   - leave **Allow write access** unticked.

```bash
# 3. Clone into its own folder and install
export GIT_SSH_COMMAND="ssh -i ~/.ssh/kalisi_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git clone git@github.com:ShivFRIP/kalisi.git /root/kalisi
git -C /root/kalisi config core.sshCommand "$GIT_SSH_COMMAND"
bash /root/kalisi/deploy/contabo1/install.sh
```

The installer:
1. Reports what's on the server.
2. Lists its planned changes and asks before making them.
3. Prints the three links and the demo password at the end.

## Make the survey save answers

Out of the box the survey runs in **preview mode**: it works, but tells people nothing was saved. To collect answers:

1. **Create the receiver.** Set up the Google Sheet and the Apps Script receiver: `docs/survey/SURVEY_SETUP.md`, section 1. Copy the web-app URL (it ends in `/exec`).
2. **Fill in the settings.** Edit `/root/kalisi/deploy/contabo1/.env`:
   ```
   SURVEY_ENDPOINT=https://script.google.com/macros/s/…/exec
   SURVEY_ORG_NAME=Your organisation's name
   SURVEY_ORG_CONTACT=privacy@yourorg.org
   SURVEY_RETENTION=12 months
   ```
   Spaces are fine and quotes aren't needed.
3. **Apply them.** Run `bash /root/kalisi/deploy/contabo1/install.sh --yes`, which rebuilds the pages with these settings.
4. **Check it end to end.** Submit one test response and confirm it appears in the Sheet.

**Optional Google address search:** set `GOOGLE_MAPS_API_KEY` and restrict the key to `https://<address>/*` (`docs/survey/SETUP.md`). Without it, address search uses the built-in OpenStreetMap data.

## Your own address instead of sslip.io

1. Point a DNS **A** record (e.g. `kalisi.yourdomain.org`) at 80.65.208.51.
2. Set `KALISI_DOMAIN` in `.env` to the new name.
3. Re-run the installer.

It gets a certificate for the new name; links shared under the old name stop working.

## Day-to-day

```bash
bash /root/kalisi/deploy/contabo1/update.sh     # pull the latest code from GitHub and re-run the installer; data and .env are kept
cd /root/kalisi/deploy/contabo1
docker compose --env-file .env logs -f app      # app logs
docker compose --env-file .env exec app python -m kalisi.seed --reset   # wipe and reload the prototype's demo data
```

**To remove Kalisi:**
```bash
docker compose --env-file .env down -v
rm /etc/nginx/sites-enabled/kalisi /etc/nginx/sites-available/kalisi && systemctl reload nginx
```

**If nothing listens on ports 80/443** (a fresh server), the installer runs its own Caddy web server with automatic HTTPS instead of using nginx. It publishes the same three links.

## Tested, and not tested

**Run end to end in the development sandbox** (Ubuntu 24.04 container):
- both web-server modes:
  - nginx 1.24 with an existing catch-all site serving a file listing, as on contabo1;
  - Caddy;
- the Docker build, migrations and demo data;
- the open/protected split, the HTTP→HTTPS redirect with a stand-in certificate, and the existing site left unchanged;
- the installer's first-run, re-run and update paths;
- the survey and demo in a browser through the web server;
- the cross-app prototype test through the password.

**Not tested:**
- getting the real Let's Encrypt certificate (the sandbox isn't reachable from the internet, and its certbot install was broken);
- running on contabo1 itself.

If the certificate step fails, the site stays on plain `http://` and the installer says so. Re-run it once port 80 is reachable.
