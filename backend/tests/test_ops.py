"""Allocation invariants, planner, reassignment, GTFS, exceptions."""
import csv
import datetime as dt
import io
import zipfile

from sqlalchemy import select

from kalisi.config import get_settings
from kalisi.models import Driver, Duty, Route, Trip, TripTemplate, Vehicle
from kalisi.services.allocation import deadhead

from .conftest import DAY, login, new_phone

OPS = "/api/v1/ops"


def _ends(t: Trip):
    s = t.route.stops
    return (s[0].stop.lat, s[0].stop.lon), (s[-1].stop.lat, s[-1].stop.lon)


def test_allocation_invariants(db):
    s = get_settings()
    trips = db.execute(select(Trip).where(Trip.service_date == DAY)).scalars().all()
    running = [t for t in trips if t.status != "cancelled"]
    assert running
    by_vehicle = {}
    for t in running:
        assert t.vehicle is not None, f"{t.route.code} unassigned"
        assert t.vehicle.vehicle_class.seats >= t.booked > 0                       # nobody without a seat
        tpl = db.get(TripTemplate, t.template_id)
        assert t.vehicle.vehicle_class.ac or not tpl.ac_required                   # AC promise kept
        by_vehicle.setdefault(t.vehicle_id, []).append(t)
    for t in trips:
        if t.status == "cancelled":
            assert t.booked == 0 and t.vehicle_id is None
    for vid, ts in by_vehicle.items():                                              # one vehicle never in two places
        ts.sort(key=lambda t: t.planned_start)
        for a, b in zip(ts, ts[1:]):
            mins, _ = deadhead(_ends(a)[1], _ends(b)[0])
            assert a.planned_end + dt.timedelta(minutes=mins + s.turnaround_min) <= b.planned_start, (a.route.code, b.route.code)
    blocked = {v.id for v in db.execute(select(Vehicle).where(Vehicle.reg_no.in_(("DEMO 007", "DEMO 016")))).scalars()}
    assert not blocked & set(by_vehicle)                                            # expired fitness / maintenance never used
    duties = db.execute(select(Duty).where(Duty.service_date == DAY)).scalars().all()
    bad_drivers = {d.id for d in db.execute(select(Driver)).scalars() if d.licence_valid_to < DAY or d.status != "active"}
    for d in duties:
        assert d.driver_id not in bad_drivers
        assert d.spread_min <= s.max_spread_min
    assert any(d.block != "FULL" for d in duties)                                   # peak-heavy days produce split shifts
    assert any(t.vehicle.vehicle_class.seats < db.get(TripTemplate, t.template_id).vehicle_class.seats for t in running)  # right-sizing
    chained = [ts for ts in by_vehicle.values() if len(ts) >= 2]
    assert chained                                                                  # vehicles do more than one trip


def test_allocation_rerun_is_stable_and_refused_once_started(client, db):
    ops = login(client, "0000000001")
    thu = DAY + dt.timedelta(days=1)
    a = client.post(f"{OPS}/allocation/run", headers=ops, json={"date": thu.isoformat()}).json()
    b = client.post(f"{OPS}/allocation/run", headers=ops, json={"date": thu.isoformat()}).json()
    for k in ("departures_running", "departures_cancelled_no_bookings", "bookings", "unassigned_departures"):
        assert a[k] == b[k]
    view = client.get(f"{OPS}/allocation", headers=ops, params={"date": thu.isoformat()}).json()
    assert len(view["trips"]) == a["departures_running"] + a["departures_cancelled_no_bookings"]
    assert all(i["kind"] in ("check", "trip", "deadhead", "break") for d in view["duties"] for i in d["items"])
    t = db.scalar(select(Trip).where(Trip.service_date == thu, Trip.status == "planned").limit(1))
    t.status = "in_progress"
    db.commit()
    started_id = t.id
    assert client.post(f"{OPS}/allocation/run", headers=ops, json={"date": thu.isoformat()}).status_code == 409
    replay = client.post(f"{OPS}/allocation/run", headers=ops, json={"date": thu.isoformat(), "force": True})   # demo replay
    assert replay.status_code == 200 and replay.json()["departures_running"] == a["departures_running"]
    db.expire_all()
    db.expunge_all()
    assert db.get(Trip, started_id) is None                                                      # rebuilt from scratch


def test_planner_proposes_viable_routes_and_publish_matches_riders(client, db):
    ops = login(client, "0000000001")
    rider = login(client, new_phone())
    body = {"home": {"lat": 17.4982, "lon": 78.3568}, "office": {"lat": 17.3950, "lon": 78.3366},   # Miyapur -> Kokapet
            "am_from": "09:00", "am_to": "09:30", "pm_from": "18:00", "pm_to": "18:30", "days": [0, 1, 2, 3, 4]}
    j = client.post("/api/v1/rider/intents", headers=rider, json=body).json()
    assert j["pooled"] and j["similar_nearby"] is not None and j["similar_nearby"] >= 5
    r = client.post(f"{OPS}/planner/run", headers=ops).json()
    assert r["proposals"]
    for p in r["proposals"]:
        assert 0 < p["riders"] <= p["seats"]
        assert p["ride_min"] <= get_settings().planner_max_ride_min
    kok = next(p for p in r["proposals"] if p["campus"] == "Kokapet")
    route = db.scalar(select(Route).where(Route.code == kok["code"]))
    assert route.status == "proposed"
    assert any(not rs.stop.audited for rs in route.stops)                          # new stops need a field audit
    pub = client.post(f"{OPS}/routes/{route.id}/publish", headers=ops).json()
    assert kok["code"] in pub["published"] and pub["pooled_riders_now_matched"] >= 5
    j2 = client.get(f"/api/v1/rider/intents/{j['intent']['id']}/options", headers=rider).json()
    assert any(o["route_code"] == kok["code"] for o in j2["am_options"])
    # a second planner run doesn't touch live routes
    client.post(f"{OPS}/planner/run", headers=ops)
    db.expire_all()
    assert db.scalar(select(Route.status).where(Route.code == kok["code"])) == "live"


def test_reassign_checks_compliance_seats_and_conflicts(client, db):
    ops = login(client, "0000000001")
    trip = db.scalar(select(Trip).where(Trip.service_date == DAY, Trip.status == "planned", Trip.vehicle_id.is_not(None))
                     .order_by(Trip.booked.desc()).limit(1))
    blocked = db.scalar(select(Vehicle).where(Vehicle.reg_no == "DEMO 007"))
    r = client.post(f"{OPS}/trips/{trip.id}/reassign", headers=ops, json={"vehicle_id": blocked.id})
    assert r.status_code == 409 and "blocked" in r.json()["detail"]
    small = db.scalar(select(Vehicle).join(Vehicle.vehicle_class).where(Vehicle.status == "active").order_by(Vehicle.class_id).limit(1))
    if small.vehicle_class.seats < trip.booked:
        r = client.post(f"{OPS}/trips/{trip.id}/reassign", headers=ops, json={"vehicle_id": small.id})
        assert r.status_code == 409 and "seats" in r.json()["detail"]
    codes = []
    for v in db.execute(select(Vehicle).order_by(Vehicle.id)).scalars():
        if v.id == trip.vehicle_id:
            continue
        rr = client.post(f"{OPS}/trips/{trip.id}/reassign", headers=ops, json={"vehicle_id": v.id})
        codes.append(rr.status_code)
        if rr.status_code == 200:
            assert rr.json()["to"] == v.reg_no
            break
    assert set(codes) <= {200, 409}


def test_gtfs_feed_is_consistent(client):
    r = client.get("/api/v1/public/gtfs.zip")
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    rows = {n: list(csv.DictReader(io.StringIO(z.read(n).decode()))) for n in z.namelist()}
    assert set(rows) == {"agency.txt", "stops.txt", "routes.txt", "calendar.txt", "trips.txt", "stop_times.txt"}
    stops, trips = {s["stop_id"] for s in rows["stops.txt"]}, {t["trip_id"] for t in rows["trips.txt"]}
    services = {c["service_id"] for c in rows["calendar.txt"]}
    assert all(t["service_id"] in services for t in rows["trips.txt"])
    by_trip = {}
    for st in rows["stop_times.txt"]:
        assert st["stop_id"] in stops and st["trip_id"] in trips
        by_trip.setdefault(st["trip_id"], []).append(st)
    for sts in by_trip.values():
        sts.sort(key=lambda x: int(x["stop_sequence"]))
        times = [x["arrival_time"] for x in sts]
        assert times == sorted(times) and len(times) >= 2


def test_overview_exceptions_and_fleet(client):
    ops = login(client, "0000000001")
    o = client.get(f"{OPS}/overview", headers=ops).json()
    assert o["trips"]["scheduled"] > 0 and o["active_passes"] > 0 and o["fleet"] == 17
    ex = client.get(f"{OPS}/exceptions", headers=ops).json()
    titles = " | ".join(e["title"] for e in ex)
    assert "DEMO 007: fitness expired" in titles and "licence expired" in titles and "DEMO 012: insurance expires" in titles
    sev = [e["severity"] for e in ex]
    assert sev == sorted(sev, key=lambda x: {"critical": 0, "high": 1, "normal": 2}[x])
    f = client.get(f"{OPS}/fleet", headers=ops).json()
    assert any(v["blocked"] for v in f["vehicles"]) and any(d["blocked"] for d in f["drivers"])
    d = client.get(f"{OPS}/demand", headers=ops).json()
    assert d["hexes"] and all(len(h["boundary"]) == 6 for h in d["hexes"] if h["h3"])


def test_assign_driver_rules(client, db):
    ops = login(client, "0000000001")
    duty = db.scalar(select(Duty).where(Duty.service_date == DAY).order_by(Duty.id).limit(1))
    expired = db.scalar(select(Driver).where(Driver.licence_valid_to < DAY))
    r = client.post(f"{OPS}/duties/{duty.id}/driver", headers=ops, json={"driver_id": expired.id})
    assert r.status_code == 409 and "licence" in r.json()["detail"]
    busy = {d.driver_id for d in db.execute(select(Duty).where(Duty.service_date == DAY)).scalars()}
    free = db.scalar(select(Driver).where(Driver.status == "active", Driver.licence_valid_to >= DAY, Driver.id.not_in(busy)).limit(1))
    if free:
        r = client.post(f"{OPS}/duties/{duty.id}/driver", headers=ops, json={"driver_id": free.id})
        assert r.status_code == 200

