"""Seed a demo network for Hyderabad.  Usage:  python -m kalisi.seed --reset

Everything here is illustrative. Places come from OpenStreetMap and the HMRL Metro feed (see data/hyderabad.json);
routes, timetables, vehicles, drivers and riders are invented for the prototype. Vehicle registration numbers
are 'DEMO nnn' and phone numbers start 00, so nothing can be mistaken for a real record or reach a real phone.

Synthetic riders buy passes through the real matching and payment code, so the seed doubles as a smoke test:
it reports how many riders could not be matched to the departure they were generated for.
"""
from __future__ import annotations

import argparse
import datetime as dt
import random

from sqlalchemy import select, text

from . import clock
from .config import get_settings
from .db import Base, SessionLocal, engine
from .geo import cell, haversine_km
from .models import (AuditLog, Booking, Campus, CommuteIntent, Driver, Operator, Rating, Route, RouteStop, Stop, Trip,
                     TripTemplate, User, Vehicle, VehicleClass)
from .services import passes
from .services.allocation import allocate
from .services.common import from_minutes, minutes
from .services.matching import nearest_campus, options_for_intent
from .services.planner import PLACES, campus_stop
from .services.simulator import advance_trip

rnd = random.Random(42)
S = get_settings()

CLASSES = [  # code, name, seats, ac, Rs/day, Rs/km  (costs are assumptions for the optimiser)
    ("mini12", "12-seat AC minibus", 12, True, 3200, 18),
    ("mini17", "17-seat AC minibus", 17, True, 4000, 22),
    ("bus26", "26-seat AC bus", 26, True, 5200, 28),
    ("bus26na", "26-seat non-AC bus", 26, False, 4200, 24),
    ("bus40", "40-seat AC bus", 40, True, 6800, 34),
]

# (code, name, direction, express, [(place, action)], [(start HH:MM, class code)], ac_required)
ROUTES = [
    ("K1", "Kompally → Financial District", "AM", False,
     [("Kompally", "pickup"), ("Balanagar Metro", "pickup"), ("Kukatpally Metro", "pickup"), ("@hitec", "drop"),
      ("@gachibowli", "drop"), ("@waverock", "drop"), ("@fd", "drop")], [("07:20", "bus26"), ("07:50", "bus26"), ("08:20", "mini17")], True),
    ("K1X", "Kompally → Financial District Express", "AM", True,
     [("Kompally", "pickup"), ("Kukatpally Metro", "pickup"), ("@waverock", "drop"), ("@fd", "drop")], [("07:45", "mini12")], True),
    ("M2", "Bachupally → Financial District", "AM", False,
     [("Bachupally", "pickup"), ("Nizampet", "pickup"), ("Miyapur", "pickup"), ("Kondapur", "pickup"), ("@gachibowli", "drop"),
      ("@waverock", "drop"), ("@fd", "drop")], [("07:55", "mini17"), ("08:25", "bus26")], True),
    ("U3", "Uppal → HITEC City", "AM", False,
     [("Uppal", "pickup"), ("Tarnaka Metro", "pickup"), ("Begumpet", "pickup"), ("Ameerpet", "pickup"), ("@hitec", "drop"),
      ("@gachibowli", "drop")], [("07:40", "bus26"), ("08:10", "mini17")], True),
    ("L4", "LB Nagar → Financial District", "AM", False,
     [("LB Nagar", "pickup"), ("Dilsukh Nagar Metro", "pickup"), ("Mehdipatnam", "pickup"), ("Tolichowki", "pickup"),
      ("Manikonda", "pickup"), ("@fd", "drop"), ("@waverock", "drop")], [("07:35", "bus40"), ("08:05", "bus26")], True),
    ("N5", "Chandanagar → Financial District", "AM", False,
     [("Chandanagar", "pickup"), ("Nallagandla", "pickup"), ("@gachibowli", "drop"), ("@waverock", "drop"), ("@fd", "drop")],
     [("08:25", "mini12"), ("08:55", "mini17")], True),
    ("E6", "Secunderabad → Pocharam IT SEZ", "AM", False,
     [("Secunderabad", "pickup"), ("Tarnaka Metro", "pickup"), ("Uppal", "pickup"), ("@pocharam", "drop")], [("08:10", "bus26na")], False),
    ("F1", "Raidurg Metro → Financial District shuttle", "AM", False,
     [("Raidurg Metro", "pickup"), ("@gachibowli", "both"), ("@waverock", "drop"), ("@fd", "drop")],
     [("08:50", "mini17"), ("09:10", "mini17"), ("09:30", "mini17"), ("09:50", "mini17"), ("10:10", "mini17")], True),
    # evening returns
    ("K1R", "Financial District → Kompally", "PM", False,
     [("@fd", "pickup"), ("@waverock", "pickup"), ("@gachibowli", "pickup"), ("@hitec", "pickup"), ("Kukatpally Metro", "drop"),
      ("Balanagar Metro", "drop"), ("Kompally", "drop")], [("17:45", "bus40"), ("18:30", "bus26"), ("19:15", "mini17"), ("21:00", "mini17")], True),
    ("M2R", "Financial District → Bachupally", "PM", False,
     [("@fd", "pickup"), ("@waverock", "pickup"), ("@gachibowli", "pickup"), ("Kondapur", "drop"), ("Miyapur", "drop"),
      ("Nizampet", "drop"), ("Bachupally", "drop")], [("18:00", "bus26"), ("18:45", "mini17")], True),
    ("U3R", "HITEC City → Uppal", "PM", False,
     [("@gachibowli", "pickup"), ("@hitec", "pickup"), ("Ameerpet", "drop"), ("Begumpet", "drop"), ("Tarnaka Metro", "drop"),
      ("Uppal", "drop")], [("17:50", "bus26"), ("18:40", "mini17")], True),
    ("L4R", "Financial District → LB Nagar", "PM", False,
     [("@waverock", "pickup"), ("@fd", "pickup"), ("Manikonda", "drop"), ("Tolichowki", "drop"), ("Mehdipatnam", "drop"),
      ("Dilsukh Nagar Metro", "drop"), ("LB Nagar", "drop")], [("17:40", "bus40"), ("18:30", "bus26")], True),
    ("N5R", "Financial District → Chandanagar", "PM", False,
     [("@fd", "pickup"), ("@waverock", "pickup"), ("@gachibowli", "pickup"), ("Nallagandla", "drop"), ("Chandanagar", "drop")],
     [("18:15", "mini17")], True),
    ("E6R", "Pocharam IT SEZ → Secunderabad", "PM", False,
     [("@pocharam", "pickup"), ("Uppal", "drop"), ("Tarnaka Metro", "drop"), ("Secunderabad", "drop")], [("17:45", "bus26na")], False),
    ("F1R", "Financial District → Raidurg Metro shuttle", "PM", False,
     [("@fd", "pickup"), ("@waverock", "pickup"), ("@gachibowli", "both"), ("Raidurg Metro", "drop")],
     [("17:15", "mini17"), ("17:35", "mini17"), ("17:55", "mini17"), ("18:15", "mini17")], True),
]
PM_OF = {"K1": "K1R", "K1X": "K1R", "M2": "M2R", "U3": "U3R", "L4": "L4R", "N5": "N5R", "E6": "E6R", "F1": "F1R"}

DEPOTS = {"Kompally": "Kompally", "Miyapur": "Miyapur", "Uppal": "Uppal", "LB Nagar": "LB Nagar", "Gachibowli": "Gachibowli"}
FLEET = [  # (class, depot, operator index)
    ("bus26", "Kompally", 0), ("bus26", "Kompally", 0), ("mini17", "Kompally", 0), ("mini12", "Kompally", 0),
    ("mini17", "Miyapur", 0), ("bus26", "Miyapur", 0), ("mini12", "Miyapur", 0), ("mini17", "Gachibowli", 0),
    ("bus26", "Uppal", 1), ("mini17", "Uppal", 1), ("bus26na", "Uppal", 1), ("bus40", "LB Nagar", 1),
    ("bus26", "LB Nagar", 1), ("mini17", "Gachibowli", 1), ("mini12", "Gachibowli", 1), ("bus26na", "Uppal", 1),
    ("mini17", "Miyapur", 0),   # peak standby (design doc 6.5)
]
DRIVER_NAMES = ["Ramesh Kumar", "Srinivas Rao", "Mahesh Goud", "Venkatesh Reddy", "Anil Babu", "Ravi Teja", "Suresh Yadav",
                "Naresh Devarakonda", "Prakash Varma", "Kiran Sagar", "Raju Naik", "Sai Kumar", "Yadagiri Chary", "Imran Shaik",
                "Joseph Mathew", "Lakshmi Prasanna", "Shabana Begum", "Narsimha Reddy", "Gopal Jadhav", "Shankar Lingam",
                "Praveen Hegde", "Mallesh Kurma", "Rajesh Pillai", "Saritha Devi", "Kumar Swamy", "Abdul Rahman"]
RIDER_FIRST = ["Aditya", "Divya", "Harsha", "Keerthi", "Manoj", "Meghana", "Nikhil", "Pooja", "Rahul", "Sneha", "Tejaswi", "Vamsi",
               "Ayesha", "Farhan", "Lavanya", "Rohit", "Sravya", "Karthik", "Bhavana", "Sameer", "Anusha", "Charan", "Deepika", "Gautham"]
RIDER_LAST = ["Reddy", "Rao", "Sharma", "Naidu", "Khan", "Varma", "Iyer", "Goud", "Patel", "Chowdary", "Menon", "Ali"]


def place(name: str) -> tuple[float, float]:
    if name in PLACES["localities"]:
        return tuple(PLACES["localities"][name])
    base = name.removesuffix(" Metro")
    for line in PLACES["metro"].values():
        for s in line:
            if s["name"] == base:
                return tuple(s["point"])
    raise KeyError(name)


def jitter(p: tuple[float, float], metres: float) -> tuple[float, float]:
    import math
    r, a = metres * math.sqrt(rnd.random()), rnd.random() * 2 * math.pi
    return (round(p[0] + r * math.cos(a) / 111_320, 6), round(p[1] + r * math.sin(a) / (111_320 * math.cos(math.radians(p[0]))), 6))


def reset() -> None:
    with engine.begin() as c:   # needs a superuser the first time; afterwards the extension already exists
        if not c.execute(text("select 1 from pg_extension where extname = 'postgis'")).scalar():
            c.execute(text("CREATE EXTENSION postgis"))
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)


def weekday_on_or_after(d: dt.date) -> dt.date:
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d


def prev_weekday(d: dt.date) -> dt.date:
    d -= dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def main(reset_db: bool, day: dt.date | None = None, at: dt.time | None = None, speed: float = 1.0) -> None:
    """Seed for service day `day` (default: today, or next Monday at weekends). If that isn't today, or `at` is
    given, the demo clock is set to that day and time (running at `speed`) so the network has trips to show."""
    # Hold the lock the background loop uses (simulator.tick), so a running server can't allocate or advance
    # trips while the demo network is half-built. Released when this connection closes.
    lock = engine.connect()
    lock.execute(text("select pg_advisory_lock(4242)"))
    try:
        _seed(reset_db, day, at, speed)
    finally:
        lock.execute(text("select pg_advisory_unlock(4242)"))
        lock.close()


def _seed(reset_db: bool, day: dt.date | None, at: dt.time | None, speed: float) -> None:
    if reset_db:
        reset()
    db = SessionLocal()
    real_today = dt.datetime.now(clock.tz()).date()
    today = day or weekday_on_or_after(real_today)
    if today != real_today or at is not None:
        clock.set_clock(db, "sim", dt.datetime.combine(today, at or dt.time(7, 0), tzinfo=clock.tz()), speed)
        print(f"demo clock set to {today} {(at or dt.time(7, 0)).strftime('%H:%M')} at {speed}x (ops console: Clock)")
    else:
        clock.set_clock(db, "real")

    classes = {code: VehicleClass(code=code, name=n, seats=s, ac=ac, day_cost=dc, km_cost=kc) for code, n, s, ac, dc, kc in CLASSES}
    db.add_all(classes.values())
    campuses = {c["code"]: Campus(code=c["code"], name=c["name"], lat=c["point"][0], lon=c["point"][1]) for c in PLACES["campuses"]}
    db.add_all(campuses.values())
    db.flush()

    stops: dict[str, Stop] = {}

    def stop_for(name: str) -> Stop:
        if name not in stops:
            if name.startswith("@"):
                stops[name] = campus_stop(db, campuses[name[1:]])
                stops[name].audited = True
            else:
                lat, lon = place(name)
                stops[name] = Stop(name=name, lat=lat, lon=lon, h3_r9=cell(lat, lon), kind="metro" if name.endswith("Metro") else "landmark",
                                   audited=True)
                db.add(stops[name])
                db.flush()
        return stops[name]

    routes: dict[str, Route] = {}
    for code, name, direction, express, seq, deps, ac_req in ROUTES:
        st = [stop_for(n) for n, _ in seq]
        offs, t = [0], 0.0
        for a, b in zip(st, st[1:]):
            t += haversine_km((a.lat, a.lon), (b.lat, b.lon)) * S.path_road_factor / S.peak_speed_kmh * 60 + S.dwell_min_per_stop
            offs.append(round(t))
        campus = next((campuses[n[1:]] for n, _ in reversed(seq) if n.startswith("@")), None) if direction == "AM" else \
            next((campuses[n[1:]] for n, _ in seq if n.startswith("@")), None)
        r = Route(code=code, name=name, direction=direction, express=express, status="live", campus_id=campus.id if campus else None)
        r.stops = [RouteStop(seq=i, stop_id=s.id, offset_min=offs[i], action=a) for i, (s, (_, a)) in enumerate(zip(st, seq))]
        r.templates = [TripTemplate(start_time=dt.time.fromisoformat(h), days_mask=0b0011111, vehicle_class_id=classes[c].id,
                                    ac_required=ac_req) for h, c in deps]
        db.add(r)
        routes[code] = r
    db.flush()

    ops_user = User(phone="+910000000001", name="Control Room (demo)", role="ops")
    demo = User(phone="+910000010001", name="Priya (demo rider)", role="rider")
    db.add_all([ops_user, demo])
    operators = [Operator(name="Operator A (demo)"), Operator(name="Operator B (demo)")]
    db.add_all(operators)
    db.flush()
    for i, (cc, depot, op) in enumerate(FLEET, start=1):
        lat, lon = place(DEPOTS[depot])
        far = lambda: today + dt.timedelta(days=rnd.randint(40, 400))
        v = Vehicle(operator_id=operators[op].id, reg_no=f"DEMO {i:03d}", class_id=classes[cc].id, depot_name=depot, depot_lat=lat,
                    depot_lon=lon, permit_valid_to=far(), fitness_valid_to=far(), insurance_valid_to=far(), puc_valid_to=far())
        if i == 7:
            v.fitness_valid_to = today - dt.timedelta(days=3)      # demonstrates the compliance block
        if i == 12:
            v.insurance_valid_to = today + dt.timedelta(days=5)    # demonstrates an expiry warning
        if i == 16:
            v.status = "maintenance"
        db.add(v)
    for i, name in enumerate(DRIVER_NAMES, start=1):
        u = User(phone=f"+9100000200{i:02d}", name=name, role="driver")
        db.add(u)
        db.flush()
        base = place(list(DEPOTS.values())[i % len(DEPOTS)])
        d = Driver(user_id=u.id, operator_id=operators[0 if i <= 15 else 1].id, licence_valid_to=today + dt.timedelta(days=rnd.randint(60, 900)),
                   base_lat=base[0], base_lon=base[1])
        if i == 5:
            d.licence_valid_to = today - dt.timedelta(days=10)
        if i == 9:
            d.status = "leave"
        db.add(d)
    db.commit()

    # ---------------------------------------------------------------- riders who match existing departures
    n_user = 0

    def new_rider() -> User:
        nonlocal n_user
        n_user += 1
        u = User(phone=f"+9100009{n_user:05d}", name=f"{rnd.choice(RIDER_FIRST)} {rnd.choice(RIDER_LAST)}", role="rider")
        db.add(u)
        db.flush()
        return u

    def window_around(t_min: int) -> tuple[dt.time, dt.time]:
        lo = t_min // 30 * 30
        return from_minutes(lo), from_minutes(lo + 30)

    def make_intent(u: User, home, office, am_win, pm_win, days=0b0011111, ac_only=True) -> CommuteIntent:
        c = nearest_campus(db, office)
        it = CommuteIntent(rider_id=u.id, home_lat=home[0], home_lon=home[1], home_label="", home_h3_r9=cell(*home),
                           office_lat=office[0], office_lon=office[1], office_label=c.name if c else "", campus_id=c.id if c else None,
                           am_from=am_win[0], am_to=am_win[1], pm_from=pm_win[0] if pm_win else None, pm_to=pm_win[1] if pm_win else None,
                           days_mask=days, ac_only=ac_only, max_walk_m=900)
        db.add(it)
        db.flush()
        return it

    # the demo rider: near Kukatpally Metro, works at Waverock
    km, wv = place("Kukatpally Metro"), (campuses["waverock"].lat, campuses["waverock"].lon)
    it = make_intent(demo, jitter(km, 250), jitter(wv, 150), (dt.time(8, 30), dt.time(9, 30)), (dt.time(17, 30), dt.time(18, 30)))
    it.home_label, it.office_label = "Near Kukatpally Metro", "Waverock, Nanakramguda"
    am_opts, pm_opts = options_for_intent(db, it, today, limit=None)
    am = next(o for o in am_opts if o.route_code == "K1")
    pm = next(o for o in pm_opts if o.route_code == "K1R")
    sub = passes.buy_pass(db, demo, it, am.option_id, pm.option_id, "monthly", "upi")
    sub.valid_from = today - dt.timedelta(days=5)
    db.commit()

    unmatched, sold = 0, 0
    for code, r in routes.items():
        if r.direction != "AM":
            continue
        pm_route = routes[PM_OF[code]]
        pickups = [rs for rs in r.stops if rs.action in ("pickup", "both")]
        drops = [rs for rs in r.stops if rs.action in ("drop", "both")]
        for t in r.templates:
            n = round(t.vehicle_class.seats * rnd.uniform(0.55, 0.85))
            for _ in range(n):
                p = rnd.choice(pickups)
                d = rnd.choice([x for x in drops if x.seq > p.seq])
                home = jitter((p.stop.lat, p.stop.lon), 450)
                office = jitter((d.stop.lat, d.stop.lon), 300)
                arr = minutes(t.start_time) + d.offset_min
                pm_t = rnd.choice([x for x in pm_route.templates if x.start_time < dt.time(20, 0)])
                pm_pick = next((x for x in pm_route.stops if x.stop_id == d.stop_id and x.action in ("pickup", "both")), pm_route.stops[0])
                pm_dep = minutes(pm_t.start_time) + pm_pick.offset_min
                days = 0b0011111 if rnd.random() > 0.15 else 0b0001110   # some hybrid workers: Tue-Thu
                u = new_rider()
                it = make_intent(u, home, office, window_around(arr), window_around(pm_dep), days, ac_only=t.ac_required)
                am_opts, pm_opts = options_for_intent(db, it, today, limit=None)
                am = next((o for o in am_opts if o.template_id == t.id), None)
                pm = next((o for o in pm_opts if o.template_id == pm_t.id), None) or (pm_opts[0] if pm_opts else None)
                if am is None:
                    unmatched += 1
                    it.status = "pooled"
                    continue
                try:
                    sub = passes.buy_pass(db, u, it, am.option_id, pm.option_id if pm else None, rnd.choice(["monthly"] * 4 + ["weekly"]), "upi")
                    sub.valid_from = today - dt.timedelta(days=rnd.randint(3, 12))
                    db.commit()
                    sold += 1
                except Exception as e:  # e.g. sold out
                    db.rollback()
                    unmatched += 1
                    print("  could not buy:", getattr(e, "detail", e))

    # ---------------------------------------------------------------- pooled demand for the planner
    groups = [  # (homes around, n, office campus, arrive window, evening window)
        (["Miyapur", "Chandanagar"], 16, "kokapet", ("09:00", "09:30"), ("18:00", "18:30")),
        (["Ameerpet", "Begumpet"], 11, "fd", ("09:30", "10:00"), ("18:30", "19:00")),
        (["Secunderabad"], 4, "gachibowli", ("10:00", "10:30"), ("19:00", "19:30")),
    ]
    pooled = 0
    for areas, n, cc, aw, pw in groups:
        for _ in range(n):
            u = new_rider()
            home = jitter(place(rnd.choice(areas)), 900)
            office = jitter((campuses[cc].lat, campuses[cc].lon), 250)
            it = make_intent(u, home, office, tuple(dt.time.fromisoformat(x) for x in aw), tuple(dt.time.fromisoformat(x) for x in pw))
            am_opts, _ = options_for_intent(db, it, today, limit=1)
            it.status = "matched" if am_opts else "pooled"
            pooled += it.status == "pooled"
    db.commit()

    # ---------------------------------------------------------------- yesterday: run and rate, for the dashboards
    yesterday = prev_weekday(today)
    allocate(db, yesterday)
    for trip in db.execute(select(Trip).where(Trip.service_date == yesterday, Trip.vehicle_id.is_not(None))).scalars():
        advance_trip(db, trip, trip.planned_end + dt.timedelta(hours=1))
    db.commit()
    tags_good = ["ac_working", "clean", "courteous_driver", "smooth_driving", "felt_safe", "on_time"]
    tags_bad = ["ac_not_working", "rash_driving", "crowded", "dirty"]
    from .models import Duty, DutyItem
    for b in db.execute(select(Booking).join(Trip).where(Trip.service_date == yesterday, Booking.status == "completed")).scalars():
        if b.rider_id != demo.id and rnd.random() < 0.45:   # the demo rider keeps a ride to rate
            good = rnd.random() > 0.12
            duty = db.scalar(select(Duty).join(DutyItem).where(DutyItem.trip_id == b.trip_id))
            db.add(Rating(booking_id=b.id, rider_id=b.rider_id, driver_id=duty.driver_id if duty else None, vehicle_id=b.trip.vehicle_id,
                          driver_score=rnd.choice([4, 5, 5, 5]) if good else rnd.choice([2, 3]),
                          vehicle_score=rnd.choice([4, 4, 5]) if good else rnd.choice([2, 3]),
                          tags=rnd.sample(tags_good, 2) if good else rnd.sample(tags_bad, 1)))
    db.commit()

    # ---------------------------------------------------------------- some riders are not joining tomorrow
    tomorrow = weekday_on_or_after(today + dt.timedelta(days=1))
    skips = 0
    subs = db.execute(select(passes.Subscription).where(passes.Subscription.rider_id != demo.id)).scalars().all()
    for s_ in rnd.sample(subs, k=len(subs) // 8):
        try:
            passes.skip(db, db.get(User, s_.rider_id), s_.id, tomorrow, "AM")
            skips += 1
        except Exception:
            db.rollback()

    today_summary = allocate(db, today)
    db.add(AuditLog(action="seed", detail={"service_day": today.isoformat()}))   # marks a complete seed (see deploy/)
    db.commit()
    db.close()
    print(f"routes {len(routes)}, stops {len(stops)}, vehicles {len(FLEET)}, drivers {len(DRIVER_NAMES)}")
    print(f"riders with passes {sold + 1} (incl. demo), could not match {unmatched}, pooled for planner {pooled}, skips tomorrow {skips}")
    print("today:", {k: today_summary[k] for k in ("departures_running", "departures_cancelled_no_bookings", "bookings", "seats_offered",
                                                   "load_factor_pct", "downsized", "vehicles_used", "duties", "split_duties",
                                                   "duties_without_driver", "unassigned_departures")})
    print("blocked:", today_summary["vehicles_blocked"], today_summary["drivers_blocked"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="drop and recreate all tables first")
    ap.add_argument("--date", type=dt.date.fromisoformat, help="service day to seed (default: today, or next Monday at weekends)")
    ap.add_argument("--at", type=dt.time.fromisoformat, help="start the demo clock at this local time, e.g. 07:30")
    ap.add_argument("--speed", type=float, default=1.0, help="demo clock speed (1 = real time)")
    a = ap.parse_args()
    main(a.reset, a.date, a.at, a.speed)
