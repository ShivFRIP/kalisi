"""Live trip state and ETAs (design doc section 5.4).

The delay is measured from the last stop the vehicle reached (arrive/depart events from the driver app or the
simulator). If the vehicle is overdue at its next stop, the delay is at least that overdue time. ETAs are shown
as a range (-1/+2 minutes), never as a falsely precise number.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..geo import haversine_km
from ..models import Booking, Duty, DutyItem, Trip, TripEvent, VehiclePosition
from .common import first_name, stop_dict

DEPART_DWELL = dt.timedelta(minutes=0.5)


def _minutes(td: dt.timedelta) -> float:
    return td.total_seconds() / 60


def delay_min(db: Session, trip: Trip, now: dt.datetime) -> float:
    if trip.status == "cancelled":
        return 0.0
    if trip.status == "completed" and trip.actual_end:
        return _minutes(trip.actual_end - trip.planned_end)
    if trip.status == "planned":
        return max(0.0, _minutes(now - trip.planned_start))
    stops = trip.route.stops
    ev = db.scalar(select(TripEvent).where(TripEvent.trip_id == trip.id, TripEvent.type.in_(("arrive", "depart")))
                   .order_by(TripEvent.ts.desc(), TripEvent.id.desc()).limit(1))
    if ev is None:
        base = _minutes((trip.actual_start or now) - trip.planned_start)
        nxt = stops[0]
    else:
        k = next((i for i, rs in enumerate(stops) if rs.stop_id == ev.stop_id and (ev.payload or {}).get("seq", rs.seq) == rs.seq), 0)
        planned_k = trip.planned_start + dt.timedelta(minutes=stops[k].offset_min) + (DEPART_DWELL if ev.type == "depart" else dt.timedelta())
        base = _minutes(ev.ts - planned_k)
        nxt = stops[k + 1] if k + 1 < len(stops) else None
    if nxt is not None:
        overdue = _minutes(now - (trip.planned_start + dt.timedelta(minutes=nxt.offset_min)))
        base = max(base, overdue)
    return base


def passed_stop_ids(db: Session, trip: Trip) -> set[int]:
    return set(db.execute(select(TripEvent.stop_id).where(TripEvent.trip_id == trip.id, TripEvent.type == "arrive")).scalars())


def driver_for_trip(db: Session, trip: Trip):
    duty = db.scalar(select(Duty).join(DutyItem).where(DutyItem.trip_id == trip.id))
    return duty.driver if duty else None


def eta_range(planned: dt.datetime, delay: float) -> tuple[dt.datetime, dt.datetime]:
    eta = planned + dt.timedelta(minutes=max(delay, 0))
    return eta - dt.timedelta(minutes=1), eta + dt.timedelta(minutes=2)


def trip_live(db: Session, trip: Trip, now: dt.datetime, booking: Booking | None = None) -> dict:
    delay = delay_min(db, trip, now)
    pos = db.get(VehiclePosition, trip.vehicle_id) if trip.vehicle_id else None
    if pos is not None and pos.trip_id != trip.id:
        pos = None
    passed = passed_stop_ids(db, trip)
    stops = []
    for rs in trip.route.stops:
        planned = trip.planned_start + dt.timedelta(minutes=rs.offset_min)
        lo, hi = eta_range(planned, delay)
        stops.append({**stop_dict(rs.stop), "seq": rs.seq, "planned": planned.isoformat(), "eta_from": lo.isoformat(),
                      "eta_to": hi.isoformat(), "passed": rs.stop_id in passed, "action": rs.action})
    drv = driver_for_trip(db, trip)
    out = {
        "trip_id": trip.id, "status": trip.status, "route_code": trip.route.code, "route_name": trip.route.name,
        "direction": trip.route.direction, "service_date": trip.service_date.isoformat(),
        "planned_start": trip.planned_start.isoformat(), "planned_end": trip.planned_end.isoformat(),
        "delay_min": round(delay, 1), "stops": stops,
        "vehicle": {"reg_no": trip.vehicle.reg_no, "class": trip.vehicle.vehicle_class.name, "seats": trip.vehicle.vehicle_class.seats,
                    "ac": trip.vehicle.vehicle_class.ac} if trip.vehicle else None,
        "driver": {"first_name": first_name(drv.user.name).split()[0]} if drv else None,
        "position": {"lat": pos.lat, "lon": pos.lon, "heading": pos.heading, "speed_kmh": pos.speed_kmh,
                     "ts": pos.ts.isoformat(), "source": pos.source} if pos else None,
        "booked": trip.booked,
    }
    if booking is not None:
        pick = next(s for s in stops if s["id"] == booking.pickup_stop_id)
        drop = next(s for s in stops if s["id"] == booking.drop_stop_id)
        eta_pick = dt.datetime.fromisoformat(pick["eta_from"]) + dt.timedelta(minutes=1)
        out["booking"] = {
            "id": booking.id, "status": booking.status, "boarding_code": booking.boarding_code, "leg": booking.leg,
            "pickup": pick, "drop": drop,
            "minutes_to_pickup": round(_minutes(eta_pick - now)) if booking.status == "confirmed" else None,
            "km_to_pickup": round(haversine_km((pos.lat, pos.lon), (pick["lat"], pick["lon"])), 1) if pos and booking.status == "confirmed" else None,
        }
    return out
