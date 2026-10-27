"""Read models for the operations console: KPIs, live map, exceptions, demand, fleet compliance (design doc 4.5)."""
from __future__ import annotations

import datetime as dt
from collections import Counter, defaultdict

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import clock
from ..config import get_settings
from ..geo import cell_boundary, cell_center, parent
from ..models import (AuditLog, Booking, Campus, CommuteIntent, Driver, Duty, DutyItem, Incident, Operator, Rating, Route, Subscription,
                      Trip, TripTemplate, Vehicle, VehiclePosition)
from .allocation import compliant_driver, compliant_vehicle, deadhead
from .common import first_name
from .live import delay_min

DELAY_ALERT_MIN = 5


def overview(db: Session, day: dt.date) -> dict:
    now = clock.now(db)
    trips = db.execute(select(Trip).where(Trip.service_date == day)).scalars().all()
    running = [t for t in trips if t.status != "cancelled"]
    tids = [t.id for t in running]
    bk = db.execute(select(Booking.status, func.count()).where(Booking.trip_id.in_(tids)).group_by(Booking.status)).all() if tids else []
    b = Counter({s: n for s, n in bk})
    done = [t for t in running if t.status == "completed"]
    on_time = sum(1 for t in done if t.actual_end and (t.actual_end - t.planned_end) <= dt.timedelta(minutes=DELAY_ALERT_MIN))
    seats = sum(t.vehicle.vehicle_class.seats for t in running if t.vehicle)
    booked = sum(t.booked for t in running)
    ratings = db.execute(select(func.avg(Rating.driver_score), func.avg(Rating.vehicle_score), func.count())
                         .join(Booking, Booking.id == Rating.booking_id).join(Trip).where(Trip.service_date == day)).one()
    return {
        "date": day.isoformat(), "now": clock.local_now(db).isoformat(timespec="seconds"),
        "trips": {"scheduled": len(running), "cancelled_no_bookings": len(trips) - len(running),
                  "in_progress": sum(1 for t in running if t.status == "in_progress"), "completed": len(done),
                  "unassigned": sum(1 for t in running if not t.vehicle_id)},
        "riders": {"booked": booked, "boarded_or_done": b["boarded"] + b["completed"], "no_show": b["no_show"],
                   "skipped_after_cutoff": b["skipped"]},
        "on_time_pct": round(100 * on_time / len(done)) if done else None,
        "load_factor_pct": round(100 * booked / seats) if seats else None,
        "vehicles_in_service": len({t.vehicle_id for t in running if t.vehicle_id}),
        "fleet": db.scalar(select(func.count()).select_from(Vehicle)),
        "active_passes": db.scalar(select(func.count()).select_from(Subscription).where(Subscription.status == "active", Subscription.valid_to >= day)),
        "pooled_riders": db.scalar(select(func.count()).select_from(CommuteIntent).where(CommuteIntent.status == "pooled")),
        "ratings": {"driver_avg": round(float(ratings[0]), 2) if ratings[0] else None,
                    "vehicle_avg": round(float(ratings[1]), 2) if ratings[1] else None, "count": ratings[2]},
        "open_incidents": db.scalar(select(func.count()).select_from(Incident).where(Incident.status != "closed")),
        "delayed_now": sum(1 for t in running if t.status == "in_progress" and delay_min(db, t, now) > DELAY_ALERT_MIN),
    }


def live_vehicles(db: Session) -> list[dict]:
    now = clock.now(db)
    out = []
    for pos in db.execute(select(VehiclePosition)).scalars():
        trip = db.get(Trip, pos.trip_id) if pos.trip_id else None
        v = db.get(Vehicle, pos.vehicle_id)
        d = delay_min(db, trip, now) if trip else 0
        boarded = db.scalar(select(func.count()).select_from(Booking).where(Booking.trip_id == trip.id, Booking.status == "boarded")) if trip else 0
        out.append({"vehicle_id": v.id, "reg_no": v.reg_no, "class": v.vehicle_class.name, "seats": v.vehicle_class.seats,
                    "lat": pos.lat, "lon": pos.lon, "heading": pos.heading, "speed_kmh": pos.speed_kmh, "source": pos.source,
                    "trip_id": trip.id if trip else None, "route_code": trip.route.code if trip else None,
                    "trip_status": trip.status if trip else "idle", "delay_min": round(d, 1),
                    "state": "idle" if not trip or trip.status != "in_progress" else ("late" if d > DELAY_ALERT_MIN else "on_time"),
                    "boarded": boarded, "booked": trip.booked if trip else 0})
    return out


def exceptions(db: Session, day: dt.date) -> list[dict]:
    now = clock.now(db)
    out = []
    for inc in db.execute(select(Incident).where(Incident.status != "closed").order_by(Incident.created_at.desc())).scalars():
        out.append({"kind": inc.kind, "severity": inc.severity, "title": f"{inc.kind.upper()} reported" + (f" on trip {inc.trip_id}" if inc.trip_id else ""),
                    "detail": inc.note, "at": inc.created_at.isoformat(), "incident_id": inc.id, "trip_id": inc.trip_id})
    for t in db.execute(select(Trip).where(Trip.service_date == day, Trip.status.in_(("planned", "in_progress")))).scalars():
        if t.vehicle_id is None:
            out.append({"kind": "unassigned", "severity": "high", "title": f"{t.route.code} {t.planned_start.astimezone(clock.tz()):%H:%M} has no vehicle",
                        "detail": "Reassign a standby vehicle.", "trip_id": t.id})
            continue
        d = delay_min(db, t, now)
        if t.status == "in_progress" and d > DELAY_ALERT_MIN:
            out.append({"kind": "delay", "severity": "high" if d > 10 else "normal",
                        "title": f"{t.route.code} running {round(d)} min late", "detail": f"Vehicle {t.vehicle.reg_no}", "trip_id": t.id})
    for duty in db.execute(select(Duty).where(Duty.service_date == day, Duty.driver_id.is_(None))).scalars():
        shift = {"AM": "morning shift", "PM": "evening shift"}.get(duty.block, "full day")
        out.append({"kind": "no_driver", "severity": "high", "title": f"No driver for {duty.vehicle.reg_no} ({shift})",
                    "detail": f"Reports {duty.report_at.astimezone(clock.tz()):%H:%M}.", "duty_id": duty.id})
    soon = day + dt.timedelta(days=7)
    for v in db.execute(select(Vehicle)).scalars():
        for doc, until in v.documents().items():
            if until < day:
                out.append({"kind": "document", "severity": "high", "title": f"{v.reg_no}: {doc} expired {until:%d %b}",
                            "detail": "Blocked from allocation until renewed."})
            elif until <= soon:
                out.append({"kind": "document", "severity": "normal", "title": f"{v.reg_no}: {doc} expires {until:%d %b}", "detail": ""})
    for d in db.execute(select(Driver)).scalars():
        if d.licence_valid_to < day:
            out.append({"kind": "document", "severity": "high", "title": f"Driver {d.user.name}: licence expired {d.licence_valid_to:%d %b}",
                        "detail": "Blocked from duties until renewed."})
    order = {"critical": 0, "high": 1, "normal": 2}
    return sorted(out, key=lambda e: order.get(e["severity"], 3))


def demand(db: Session) -> dict:
    """Riders by home hexagon (H3 res 8) x office cluster. Internal view: small counts are shown but flagged."""
    k = get_settings().k_anonymity
    campuses = {c.id: c.name for c in db.execute(select(Campus)).scalars()}
    cells: dict[str, dict] = defaultdict(lambda: {"total": 0, "pooled": 0, "subscribed": 0, "by_campus": Counter()})
    for it in db.execute(select(CommuteIntent)).scalars():
        c = cells[parent(it.home_h3_r9, 8)]
        c["total"] += 1
        if it.status in ("pooled", "subscribed"):
            c[it.status] += 1
        c["by_campus"][campuses.get(it.campus_id, "Other")] += 1
    hexes = [{"h3": h, "boundary": cell_boundary(h), "center": cell_center(h), "total": v["total"], "pooled": v["pooled"],
              "subscribed": v["subscribed"], "top_campus": v["by_campus"].most_common(1)[0][0], "below_k": v["total"] < k}
             for h, v in cells.items()]
    pooled_groups = Counter()
    for it in db.execute(select(CommuteIntent).where(CommuteIntent.status == "pooled")).scalars():
        pooled_groups[(campuses.get(it.campus_id, "Other"), it.am_from.strftime("%H:%M"))] += 1
    return {"k": k, "hexes": sorted(hexes, key=lambda h: -h["total"]),
            "pooled_by_campus_time": [{"campus": c, "arrive_from": t, "riders": n} for (c, t), n in pooled_groups.most_common()]}


def fleet(db: Session, day: dt.date) -> dict:
    duties = db.execute(select(Duty).where(Duty.service_date == day)).scalars().all()
    dv = defaultdict(list)
    for d in duties:
        dv[d.vehicle_id].append(d)
    vehicles = [{"id": v.id, "reg_no": v.reg_no, "operator": v.operator.name, "class": v.vehicle_class.name, "seats": v.vehicle_class.seats,
                 "ac": v.vehicle_class.ac, "depot": v.depot_name, "status": v.status,
                 "documents": {k: x.isoformat() for k, x in v.documents().items()}, "blocked": compliant_vehicle(v, day),
                 "duties_today": [{"block": d.block, "driver": d.driver.user.name if d.driver else None,
                                   "report": d.report_at.isoformat(), "sign_off": d.sign_off_at.isoformat()} for d in dv[v.id]]}
                for v in db.execute(select(Vehicle).order_by(Vehicle.id)).scalars()]
    rating = {r[0]: (round(float(r[1]), 2), r[2]) for r in db.execute(select(Rating.driver_id, func.avg(Rating.driver_score), func.count())
                                                                         .group_by(Rating.driver_id)).all()}
    operators = {o.id: o.name for o in db.execute(select(Operator)).scalars()}
    drivers = [{"id": d.id, "name": d.user.name, "phone": d.user.phone, "operator_id": d.operator_id, "operator": operators.get(d.operator_id, ""),
                "licence_valid_to": d.licence_valid_to.isoformat(), "status": d.status, "blocked": compliant_driver(d, day),
                "rating": rating.get(d.id, (None, 0))[0], "ratings": rating.get(d.id, (None, 0))[1],
                "duty_today": next(({"vehicle": x.vehicle.reg_no, "block": x.block, "report": x.report_at.isoformat()} for x in duties if x.driver_id == d.id), None)}
               for d in db.execute(select(Driver).order_by(Driver.id)).scalars()]
    return {"vehicles": vehicles, "drivers": drivers}


def allocation_view(db: Session, day: dt.date) -> dict:
    trips = db.execute(select(Trip).where(Trip.service_date == day).order_by(Trip.planned_start)).scalars().all()
    duties = db.execute(select(Duty).where(Duty.service_date == day).order_by(Duty.report_at)).scalars().all()
    tz = clock.tz()
    return {
        "date": day.isoformat(),
        "trips": [{"id": t.id, "route_code": t.route.code, "route_name": t.route.name, "direction": t.route.direction,
                   "start": t.planned_start.astimezone(tz).strftime("%H:%M"), "end": t.planned_end.astimezone(tz).strftime("%H:%M"),
                   "status": t.status, "booked": t.booked, "class": t.vehicle_class.name, "seats": t.vehicle_class.seats,
                   "vehicle": t.vehicle.reg_no if t.vehicle else None,
                   "planned_class": db.get(TripTemplate, t.template_id).vehicle_class.name}
                  for t in trips],
        "duties": [{"id": d.id, "vehicle": d.vehicle.reg_no, "vehicle_class": d.vehicle.vehicle_class.name, "block": d.block,
                    "driver": first_name(d.driver.user.name) if d.driver else None,
                    "report": d.report_at.astimezone(tz).strftime("%H:%M"), "sign_off": d.sign_off_at.astimezone(tz).strftime("%H:%M"),
                    "worked_min": d.worked_min, "spread_min": d.spread_min, "deadhead_km": d.deadhead_km,
                    "items": [{"kind": i.kind, "start": i.start_at.astimezone(tz).strftime("%H:%M"), "end": i.end_at.astimezone(tz).strftime("%H:%M"),
                               "trip_id": i.trip_id, "route_code": i.trip.route.code if i.trip else None,
                               "booked": i.trip.booked if i.trip else None, "km": i.km} for i in d.items]}
                   for d in duties],
    }


def reassign(db: Session, trip_id: int, vehicle_id: int, user_id: int) -> dict:
    """Move one trip to another vehicle (breakdown, late vehicle). Checks compliance, seats and timing conflicts."""
    s = get_settings()
    trip, v = db.get(Trip, trip_id), db.get(Vehicle, vehicle_id)
    if trip is None or v is None:
        raise HTTPException(404, "Trip or vehicle not found")
    if trip.status not in ("planned", "in_progress"):
        raise HTTPException(409, "Only planned or running trips can be reassigned")
    problems = compliant_vehicle(v, trip.service_date)
    if problems:
        raise HTTPException(409, f"{v.reg_no} is blocked: {', '.join(problems)}")
    if v.vehicle_class.seats < trip.booked:
        raise HTTPException(409, f"{v.reg_no} has {v.vehicle_class.seats} seats; {trip.booked} riders are booked")
    others = db.execute(select(Trip).where(Trip.service_date == trip.service_date, Trip.vehicle_id == v.id, Trip.id != trip.id,
                                           Trip.status != "cancelled")).scalars().all()
    pts = lambda t: ((t.route.stops[0].stop.lat, t.route.stops[0].stop.lon), (t.route.stops[-1].stop.lat, t.route.stops[-1].stop.lon))
    for o in others:
        (os_, oe), (ts_, te) = pts(o), pts(trip)
        gap = dt.timedelta(minutes=s.turnaround_min)
        fits_before = o.planned_end + dt.timedelta(minutes=deadhead(oe, ts_)[0]) + gap <= trip.planned_start
        fits_after = trip.planned_end + dt.timedelta(minutes=deadhead(te, os_)[0]) + gap <= o.planned_start
        if not (fits_before or fits_after):
            raise HTTPException(409, f"{v.reg_no} is busy with {o.route.code} at that time")
    old = trip.vehicle.reg_no if trip.vehicle else None
    # Move the duty item: drop it from the old duty, add it to (or create) the new vehicle's duty.
    item = db.scalar(select(DutyItem).where(DutyItem.trip_id == trip.id))
    if item:
        db.delete(item)
    trip.vehicle_id, trip.vehicle_class_id = v.id, v.class_id
    db.flush()
    duty = db.scalar(select(Duty).where(Duty.service_date == trip.service_date, Duty.vehicle_id == v.id).order_by(Duty.report_at))
    if duty is None:
        duty = Duty(service_date=trip.service_date, vehicle_id=v.id, driver_id=None, block="FULL", report_at=trip.planned_start,
                    sign_off_at=trip.planned_end, worked_min=0, spread_min=0)
        db.add(duty)
    duty.items.append(DutyItem(seq=len(duty.items), kind="trip", trip_id=trip.id, start_at=trip.planned_start, end_at=trip.planned_end))
    duty.report_at = min(duty.report_at, trip.planned_start - dt.timedelta(minutes=s.pretrip_check_min))
    duty.sign_off_at = max(duty.sign_off_at, trip.planned_end)
    duty.spread_min = round((duty.sign_off_at - duty.report_at).total_seconds() / 60)
    db.add(AuditLog(user_id=user_id, action="reassign", detail={"trip": trip.id, "from": old, "to": v.reg_no}))
    db.commit()
    return {"trip_id": trip.id, "from": old, "to": v.reg_no, "duty_id": duty.id, "duty_has_driver": duty.driver_id is not None}


def routes_view(db: Session, today: dt.date) -> list[dict]:
    from .matching import seats_sold
    out = []
    for r in db.execute(select(Route).where(Route.status != "retired").order_by(Route.status, Route.code)).scalars():
        out.append({"id": r.id, "code": r.code, "name": r.name, "direction": r.direction, "status": r.status, "express": r.express,
                    "notes": r.notes, "campus": r.campus.name if r.campus else None,
                    "stops": [{"id": rs.stop_id, "name": rs.stop.name, "lat": rs.stop.lat, "lon": rs.stop.lon, "offset_min": rs.offset_min,
                               "action": rs.action, "kind": rs.stop.kind, "audited": rs.stop.audited} for rs in r.stops],
                    "departures": [{"template_id": t.id, "start": t.start_time.strftime("%H:%M"), "vehicle": t.vehicle_class.name,
                                    "seats": t.vehicle_class.seats, "sold": seats_sold(db, t.id, today), "days_mask": t.days_mask}
                                   for t in sorted(r.templates, key=lambda t: t.start_time)]})
    return out



def assign_driver(db: Session, duty_id: int, driver_id: int, user_id: int) -> dict:
    """Give a duty a driver (e.g. one left without a driver after split shifts). Checks documents and overlaps."""
    duty, drv = db.get(Duty, duty_id), db.get(Driver, driver_id)
    if duty is None or drv is None:
        raise HTTPException(404, "Duty or driver not found")
    problems = compliant_driver(drv, duty.service_date)
    if problems:
        raise HTTPException(409, f"{drv.user.name} can't drive: {', '.join(problems)}")
    for other in db.execute(select(Duty).where(Duty.service_date == duty.service_date, Duty.driver_id == drv.id, Duty.id != duty.id)).scalars():
        start, end = min(other.report_at, duty.report_at), max(other.sign_off_at, duty.sign_off_at)
        if (end - start).total_seconds() / 60 > get_settings().max_spread_min or not (other.sign_off_at <= duty.report_at or duty.sign_off_at <= other.report_at):
            raise HTTPException(409, f"{drv.user.name} already has a duty that day; together they break the overlap or spread-over rule")
    duty.driver_id = drv.id
    db.add(AuditLog(user_id=user_id, action="assign_driver", detail={"duty": duty.id, "driver": drv.id}))
    db.commit()
    return {"duty_id": duty.id, "driver": drv.user.name}
