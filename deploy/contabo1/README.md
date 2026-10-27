# Deploying the Kalisi demo on contabo1

Everything runs in Docker containers under the project name `kalisi`:

| Container | Role | Limits |
|---|---|---|
| `kalisi-db` | Kalisi's own database (PostgreSQL 16 + PostGIS) | 1 CPU, 1 GB |
| `kalisi-app` | API, background simulator, and the three web apps | 2 CPU, 2 GB |
| `kalisi-caddy` | Public HTTPS on ports 80/443, with one shared demo password | 0.5 CPU, 256 MB |

It does **not** use or change the host's PostgreSQL, `ecourts_india`, `/root/ecourts_pg` or anything else on the box.

## First install (about 10 minutes, most of it the first build)

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

### What the installer does

1. **Checks the server, read-only.** It reports the public IP, disk, memory, Docker, existing containers and the host PostgreSQL. It **stops without changing anything** if ports 80 or 443 are already in use.
2. **Shows the planned changes and asks before continuing.**
3. **Installs Docker if missing,** using Ubuntu's `docker.io` and `docker-compose-v2` packages.
4. **Creates secrets.** It writes `deploy/contabo1/.env` (mode 600) with a generated database password, sign-in secret and **demo password**.
5. **Builds and starts the containers,** then waits for the app to report healthy.
6. **Loads the demo Hyderabad network** if the database is empty, or reloads it if an earlier load didn't finish.
7. **Prints the address and the demo password.**

### The web address

The default is `https://kalisi.80-65-208-51.sslip.io`. sslip.io is a free public DNS service that maps that name to the IP inside it, so no DNS setup is needed, and Caddy gets a free Let's Encrypt certificate automatically. HTTPS matters: browsers only allow GPS sharing and app install on HTTPS pages.

To use your own name, point a DNS **A** record at 80.65.208.51 first, then run:

```bash
KALISI_DOMAIN=kalisi.yourdomain.org bash /root/kalisi/deploy/contabo1/install.sh
```

**If ports 80/443 are already used** by another web server (e.g. nginx):
1. Run with `PROXY=existing`.
2. Kalisi then listens only on `127.0.0.1:8100`.
3. The installer prints an nginx site block to add.
4. Get the certificate with your usual tool, e.g. certbot.

## Using it

- Open the address and enter the demo user `demo` with the printed password. Share these with the people you demo to.
- **Sign-in codes appear on screen (demo mode).**
  - Control room: `0000000001`.
  - Demo rider: `0000010001`.
  - Drivers are listed on the driver sign-in page.
- See the main README's "A 10-minute demo for policymakers" for a walkthrough. Use **Control room → Clock** to run a morning peak at any time of day.

## Day-to-day

```bash
bash /root/kalisi/deploy/contabo1/update.sh            # pull the latest code from GitHub and rebuild; data is kept
cd /root/kalisi/deploy/contabo1
docker compose --env-file .env logs -f app             # logs
docker compose --env-file .env ps                      # status
docker compose --env-file .env exec app python -m kalisi.seed --reset   # wipe and reload the demo data
docker compose --env-file .env --profile caddy down -v # remove Kalisi completely (its containers and database only)
```

The containers restart automatically after a reboot.

## Tested, and not tested

- **Run end to end in the development sandbox:**
  - the Docker build, the database migrations, the app, Caddy with the demo password, and the installer's first run, reload and update paths;
  - a browser test across the three apps through the password-protected HTTPS proxy.
- **Not tested:**
  - issuing a public certificate (the sandbox has no public IP);
  - running on contabo1 itself.
- **Watch on the first run:**
  - the HTTPS check at the end;
  - `docker compose --env-file .env logs caddy` if it doesn't come up.
