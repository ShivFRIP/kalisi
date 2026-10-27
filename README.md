# Kalisi (కలిసి): shared office commutes for Hyderabad

A **working prototype** of the platform described in `docs/architecture-design.md`. One backend and three web apps:

| App | Who | What it does |
|---|---|---|
| **Rider** (`/rider`) | Commuters | Enter home, office, arrival and leaving windows and office days once; see matching departures; buy a weekly or monthly pass; track the bus live with an ETA range; show a 4-digit boarding code; mark "not joining"; rate rides; raise SOS. |
| **Driver** (`/driver`) | Drivers | The day's duty (a long run, then short loops), stop-by-stop manifest, boarding by rider code, no-show after a 2-minute wait, GPS sharing, offline event queue, SOS. |
| **Control room** (`/ops`) | Operations staff | KPIs and exceptions, live vehicle map, daily allocation and driver duties (Gantt), route planner and publishing, demand hex map, fleet and driver compliance, demo clock. |

All three are installable web apps (PWAs), so no app-store release is needed for a pilot. The backend is Python (FastAPI) with PostgreSQL/PostGIS. Google OR-Tools does the route planning and vehicle allocation.

> **Status: prototype.** It runs end to end on a seeded demo network. Payments and SMS are stand-ins, and travel times are estimates. See [What is real and what is simulated](#what-is-real-and-what-is-simulated) before showing it as anything more.

## How the original requirements map to the code

| Requirement | Where |
|---|---|
| Commuters enter home, office, start/end time and weekdays | `POST /rider/intents` (`backend/kalisi/api/rider.py`); rider onboarding screens |
| Matched to others going to the same or nearby place | `services/matching.py`. Walk distance to a stop, arrival window, direction, a detour cap (in-vehicle time ≤ min(1.6 × direct, direct + 25 min)), AC preference, weekdays and seats left. Riders with no match join a **demand pool**. `services/planner.py` turns pooled demand into proposed routes; publishing one re-matches waiting riders. |
| Track the vehicle: time to arrive, time to destination | `services/live.py`. Delay is measured from the last stop reached; ETAs are shown as a range (−1/+2 min). Positions come from the driver phone or the simulator. |
| Rate vehicle and driver | `POST /rider/bookings/{id}/rating`. Stars plus tags for what GPS can't measure (AC, cleanliness, felt safe…). |
| Payments | `services/passes.py` + `ledger.py`. Weekly and monthly passes, ride credits applied first, double-entry ledger. **Sandbox gateway: no real money moves.** Changing your commute replaces the pass. Unused travel days come back as ride credit pro rata, net of skip credits already given; this is a policy default, see below. |
| "Not joining today" | `services/passes.py`. Before the D-1 cut-off (20:00) the seat is released and a ride credit is earned; after it, until 30 min before pickup, the seat is released with no credit; later is refused. |
| Trips allocated to vehicles of different capacity, AC or not | `services/allocation.py`. Each departure gets the smallest vehicle class that seats its bookings (12/17/26/40 seats, AC and non-AC). Departures with no bookings are cancelled. Vehicles with expired permit, fitness, insurance or pollution certificate are never assigned. |
| Driver app with the journey details | `services/driver.py`, `/driver`. |
| A driver does several trips: long, then short | Vehicle chaining is a CP-SAT model: a vehicle takes the next trip only if it can get there in time. The usual result is a long morning run, then short Metro-feeder loops, then the evening run. Duties are split into morning and evening shifts when the spread-over would exceed 12 hours. |

## Quick start (local)

Prerequisites: Python 3.11+, Node 22, PostgreSQL 16 with PostGIS 3.

```bash
# 1. Database (as a PostgreSQL superuser)
createuser -P kalisi            # password: kalisi (or set KALISI_DATABASE_URL)
createdb -O kalisi kalisi
psql -d kalisi -c "CREATE EXTENSION postgis;"

# 2. Backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
alembic upgrade head                       # or: python -m kalisi.seed --reset (creates tables itself)
python -m kalisi.seed --at 07:40           # demo network; the demo clock starts at 07:40 today
uvicorn kalisi.main:app --reload           # http://localhost:8000/docs

# 3. Web apps (another terminal)
cd frontend
npm install
npm run dev                                # http://localhost:5173
```

Open http://localhost:5173 and pick an app. In dev mode the sign-in code is shown on screen, and each sign-in page lists demo accounts:
- **control room:** `0000000001`;
- **demo rider (Priya):** `0000010001`;
- **drivers:** listed with today's duty.

Any number starting `00` creates a new demo rider. Numbers starting `00` are not valid Indian mobile numbers, so a misconfigured SMS provider can never text a real person.

**Single process:**
1. Run `npm run build` in `frontend/`.
2. `uvicorn kalisi.main:app` then serves the built apps from the same port as the API.

### Docker

```bash
cp .env.example .env    # set KALISI_JWT_SECRET
docker compose up -d --build
docker compose run --rm app python -m kalisi.seed --at 07:40
```

The Docker files follow standard patterns but **have not been run**: the environment this was built in had no Docker daemon. Everything else here was run and tested.

## A 10-minute demo for policymakers

1. **Control room → Clock.** Set the demo clock to 07:40 at 1× (or 10× to watch a whole peak in minutes). The amber strip on every app shows that time is simulated. If you move the clock backwards past trips that already ran, the page offers **Reset day** to replay them. This works on demo servers only.
2. **Control room → Overview and Live map.** Buses leave the corridors (Kompally, Bachupally, Uppal, LB Nagar, Chandanagar) for the western IT cluster. Exceptions show:
   - a minibus blocked by an expired fitness certificate;
   - a driver blocked by an expired licence;
   - an insurance renewal due in 5 days;
   - a duty left without a driver because split shifts need more drivers.
3. **Rider (Priya).** Today's K1 bus to Waverock: pickup at Kukatpally Metro, live ETA range, boarding code, driver and vehicle. Mark tomorrow "not joining" before 20:00 and a ride credit appears in the pass tab.
4. **Driver.** Pick a driver from the list. Their duty shows a long morning run followed by short feeder loops. Start a trip, arrive, board a rider with their code, and see the rider's app update.
5. **Control room → Allocation.** For tomorrow:
   - skips shrink departures, so a 26-seat bus becomes a 17-seater;
   - empty departures are cancelled;
   - the Gantt shows each vehicle's chain of trips and the split shifts.
6. **Control room → Network → Run planner.** Riders who couldn't be matched (Miyapur/Chandanagar → Kokapet; Ameerpet/Begumpet → Financial District) get proposed routes with projected load. Publish one and the waiting riders are matched at once.
7. **Open data.** `/api/v1/public/gtfs.zip` exports live routes in GTFS, the format journey planners read.

## What is real and what is simulated

| Area | In this prototype | Needed for a pilot |
|---|---|---|
| Sign-in | Phone + OTP; in dev the code is shown on screen | An SMS provider wired into `security.send_sms`, plus whatever sender/template registration Indian telecom rules currently require |
| Payments | Sandbox gateway that always succeeds; real double-entry ledger | A payment-gateway adapter (UPI AutoPay / cards), refunds, reconciliation, invoices with GST |
| Travel times | Straight-line distance × 1.35 road factor at 24 km/h peak (the demo's assumptions); optional OSRM for the planner | Self-hosted OSRM or Valhalla on an OSM India extract, then learned speeds from the platform's own GPS |
| Vehicle positions | Driver phone GPS or the built-in simulator | AIS-140 tracking-device feed as a second source; map-matching |
| Stops | Locality centroids and Metro stations; planner stops marked "proposed" and unaudited | Field audit of every stop (lighting, footpath, safe bay) |
| Notifications | None; apps poll every 5–20 s | Push/SMS/WhatsApp; WebSocket or MQTT for live positions |
| Base map | OpenStreetMap's public tile server (usage policy limits apply) | A tile provider or self-hosted tiles |
| Scale | Single Postgres; positions in a table | Redis for live state, a time-series store for pings, load testing |
| Languages | English | Telugu and Hindi (driver app first) |

Other things deliberately not built yet:
- employer portal;
- operator settlement;
- KYC;
- guaranteed-ride-home;
- women-preferred seating;
- accessibility for wheelchair users;
- a rider waitlist with pre-commitment deposits.

## Policy parameters

All in `backend/kalisi/config.py`, settable by environment variable (`KALISI_<NAME>`). They are policy choices, so review them rather than treat the defaults as recommendations:

| Parameter | Default | Meaning |
|---|---|---|
| `max_walk_m_default` / `office_walk_m` | 800 / 1000 m | Walking limits to a stop |
| `detour_alpha`, `detour_beta_min` | 1.6, 25 | In-vehicle time ≤ min(α × direct, direct + β) |
| `skip_cutoff`, `skip_credit_pct` | 20:00, 100 % | D-1 cut-off for a credited skip |
| `late_skip_min_before_departure` | 30 | Last skip time before pickup |
| `allocation_buffer_pct` | 10 % | Spare seats kept when right-sizing (capped at seats sold) |
| `max_spread_min`, `max_worked_min` | 720, 480 | Driver spread-over and working-time caps. Set these from applicable labour law and operator contracts; the defaults are not legal advice. |
| `k_anonymity` | 5 | Minimum group size before counts are shown to riders |
| Pass switch/cancel refund | Pro rata by unused travel days, as ride credit | A policy choice in `passes.end_pass`. Alternatives: refund to the payment method, a cancellation fee, or no refund after the first week. |
| `planner_min_group`, `planner_max_ride_min`, `planner_target_load_pct` | 6, 75, 60 % | When the planner proposes a route and whether it counts as viable |

Fares use the demo's formula, ₹45 + ₹4/km rounded to a price ending in 9, with a ₹49 minimum. Express is +30%, and a monthly pass is 20 days at 28% off. These are placeholders for a pricing study.

## Privacy by design

- **Drivers** see a rider's first name and initial, pickup and drop stop. They never see phone numbers, home locations or boarding codes; the server checks the code.
- **Homes** are stored as points for matching, and summarised for planners as H3 hexagons. Counts shown to riders ("N people near you") are suppressed below k = 5.
- **Money** moves only through balanced ledger transactions (`ledger.trial_balance()` is 0 after every test).
- **Data protection law.** Under India's DPDP Act 2023 and Rules 2025 this is personal data. The consent wording, retention and deletion flows still need to be written for a pilot (the survey's consent screen is a starting point).

## Tests

```bash
cd backend && pytest -q        # needs PostgreSQL+PostGIS; creates the kalisi_test database
```

25 tests cover:
- pricing against the demo formula;
- OTP limits and role access;
- ledger balance;
- matching rules;
- buying a pass and rejection of a forged option;
- skip credits and late skips;
- allocation rules (no vehicle in two places, no blocked vehicles or drivers, right-sizing, split shifts, chaining);
- the planner and publishing;
- reassignment, GTFS consistency, and the driver event flow (wrong code, duplicate resend, the 2-minute no-show rule, tap time kept for events queued offline);
- simulator ETAs, ratings and SOS scoping;
- switching passes with pro-rata credit;
- replaying a demo day.

`scripts/e2e-cross-app.js` runs the three apps together in a browser: the driver boards the demo rider with the code shown in the rider's app, and the rider's app switches to "On board".

CI (`.github/workflows/ci.yml`) also checks that migrations match the models and that the web apps build.

## Repository layout

```
backend/
  kalisi/
    api/          HTTP endpoints: auth, rider, driver, ops, public (GTFS, places, SOS)
    services/     matching, passes (payments, skips), allocation (CP-SAT), planner (OR-Tools VRP),
                  live (ETA), simulator, driver events, ops read models, GTFS export
    models.py     PostgreSQL/PostGIS schema (design doc section 5.2)
    seed.py       demo network for Hyderabad
    data/hyderabad.json  places with sources
  alembic/        migrations
  tests/
frontend/
  src/rider, src/driver, src/ops   the three apps
  src/api.ts, ui.tsx, MapView.tsx  shared client, components, map
docs/             architecture and design notes
scripts/          cross-app browser check
```

## Data sources and licences

- **Places:** © OpenStreetMap contributors, Open Database License (ODbL) 1.0. Telangana extract dated 27 Oct 2026, from the gazetteer built for the Kalisi demo.
- **Metro stations:** Hyderabad Metro Rail timetable feed (GTFS), Open Data Telangana, July 2026.
- **Base map tiles:** © OpenStreetMap contributors.
- **Fonts:** Hanken Grotesk, Bricolage Grotesque, Noto Sans Telugu and JetBrains Mono under the SIL Open Font License 1.1, bundled via @fontsource. No requests go to Google Fonts.
- **Dependency licences:** checked from installed package metadata:
  - MIT: FastAPI, SQLAlchemy, GeoAlchemy2, Alembic, Pydantic, PyJWT, React, React Router, Vite;
  - BSD: Uvicorn (BSD-3-Clause), Leaflet (BSD-2-Clause);
  - Apache 2.0: OR-Tools, h3;
  - LGPL-3.0: psycopg.
- **Licence for this code:** not chosen yet. That is a decision for the owner, e.g. Apache-2.0 for maximum reuse, or AGPL-3.0 like Namma Yatri if changes by operators must stay open.
