"""Moves vehicles along their routes for demos, and runs the nightly allocation.

A trip is simulated unless a driver phone has taken it over (trip.gps_source == 'app'). The simulator writes the
same arrive/depart/board events the driver app would, so ETAs, the ops console and ratings work identically.
Each trip runs late by its deterministic `sim_delay_min`. About 1 in 20 synthetic riders (phone numbers starting
+9100009) is a no-show; demo accounts never are.
"""
from __future__ import annotations

import datetime as dt
import logging

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .. import clock
from ..config import get_settings
from ..geo import bearing, haversine_km
from ..models import Booking, GpsPing, Route, Trip, TripEvent, TripTemplate, VehiclePosition
from .common import runs_on, stop_point

log = logging.getLogger(__name__)
SYNTHETIC_PREFIX = "+9100009"
DWELL_MIN = 0.5


def _no_show(b: Booking) -> bool:
    return b.rider.phone.startswith(SYNTHETIC_PREFIX) and (b.id * 7919) % 20 == 0


def _event(db: Session, have: set[str], trip: Trip, cid: str, type_: str, ts: dt.datetime, stop_id=None, booking_id=None, payload=None):
    if cid in have:
        return False
    db.add(TripEvent(trip_id=trip.id, ts=ts, type=type_, stop_id=stop_id, booking_id=booking_id, client_event_id=cid,
                     source="sim", payload=payload or {}))
    have.add(cid)
    return True


def advance_trip(db: Session, trip: Trip, now: dt.datetime) -> None:
    start = trip.planned_start + dt.timedelta(minutes=trip.sim_delay_min)
    if now < start:
        return
    stops = trip.route.stops
    have = set(db.execute(select(TripEvent.client_event_id).where(TripEvent.trip_id == trip.id)).scalars())
    elapsed = (now - start).total_seconds() / 60
    total = stops[-1].offset_min
    if trip.status == "planned":
        trip.status, trip.actual_start = "in_progress", start
        _event(db, have, trip, f"sim:{trip.id}:start", "start", start)
    bookings = db.execute(select(Booking).where(Booking.trip_id == trip.id)).scalars().all()
    for rs in stops:
        if rs.offset_min > elapsed:
            break
        t_arr = start + dt.timedelta(minutes=rs.offset_min)
        if _event(db, have, trip, f"sim:{trip.id}:{rs.seq}:arrive", "arrive", t_arr, rs.stop_id, payload={"seq": rs.seq}):
            for b in bookings:
                if b.pickup_stop_id == rs.stop_id and b.status == "confirmed":
                    if _no_show(b):
                        b.status = "no_show"
                        _event(db, have, trip, f"sim:{trip.id}:noshow:{b.id}", "no_show", t_arr + dt.timedelta(minutes=2), rs.stop_id, b.id)
                    else:
                        b.status, b.boarded_at = "boarded", t_arr
                        _event(db, have, trip, f"sim:{trip.id}:board:{b.id}", "board", t_arr, rs.stop_id, b.id)
                elif b.drop_stop_id == rs.stop_id and b.status == "boarded":
                    b.status = "completed"
        if rs is not stops[-1] and elapsed >= rs.offset_min + DWELL_MIN:
            _event(db, have, trip, f"sim:{trip.id}:{rs.seq}:depart", "depart", t_arr + dt.timedelta(minutes=DWELL_MIN), rs.stop_id, payload={"seq": rs.seq})

    if elapsed >= total:
        trip.status, trip.actual_end = "completed", start + dt.timedelta(minutes=total)
        for b in bookings:
            if b.status == "boarded":
                b.status = "completed"
            elif b.status == "confirmed":
                b.status = "no_show"
        _event(db, have, trip, f"sim:{trip.id}:end", "end", trip.actual_end)
        lat, lon, head, speed = stops[-1].stop.lat, stops[-1].stop.lon, None, 0.0
    else:
        k = max(i for i, rs in enumerate(stops) if rs.offset_min <= elapsed)
        a, b = stops[k], stops[k + 1]
        seg = b.offset_min - a.offset_min - DWELL_MIN
        frac = min(1.0, max(0.0, (elapsed - a.offset_min - DWELL_MIN) / seg)) if seg > 0 else 1.0
        pa, pb = stop_point(a.stop), stop_point(b.stop)
        lat, lon = pa[0] + (pb[0] - pa[0]) * frac, pa[1] + (pb[1] - pa[1]) * frac
        head = bearing(pa, pb)
        speed = 0.0 if frac == 0 else round(haversine_km(pa, pb) * get_settings().path_road_factor / max(seg, 0.1) * 60, 1)
    pos = db.get(VehiclePosition, trip.vehicle_id)
    if pos is None:
        pos = VehiclePosition(vehicle_id=trip.vehicle_id, lat=lat, lon=lon, ts=now, source="sim")
        db.add(pos)
        db.flush()
    if pos.trip_id is None or pos.trip_id == trip.id or trip.status == "in_progress":
        pos.trip_id, pos.lat, pos.lon, pos.heading, pos.speed_kmh, pos.ts, pos.source = trip.id, lat, lon, head, speed, now, "sim"
        db.add(GpsPing(vehicle_id=trip.vehicle_id, trip_id=trip.id, ts=now, lat=lat, lon=lon, speed_kmh=speed, source="sim"))


def tick(db: Session) -> None:
    """One simulation step. Safe to call from several processes: only the holder of the advisory lock works."""
    if not db.execute(text("select pg_try_advisory_xact_lock(4242)")).scalar():
        return
    now = clock.now(db)
    day = clock.local_now(db).date()
    trips = db.execute(select(Trip).where(Trip.service_date.in_((day - dt.timedelta(days=1), day)),
                                          Trip.status.in_(("planned", "in_progress")), Trip.vehicle_id.is_not(None),
                                          Trip.gps_source == "sim").order_by(Trip.planned_start)).scalars().all()
    for trip in trips:
        advance_trip(db, trip, now)
    _maybe_allocate(db)
    db.commit()


def _maybe_allocate(db: Session) -> None:
    """After the cut-off, allocate tomorrow if nobody has yet. Before it, make sure today exists (fresh installs)."""
    from .allocation import allocate
    s = get_settings()
    ln = clock.local_now(db)
    target = ln.date() + dt.timedelta(days=1) if ln.time() >= dt.time.fromisoformat(s.skip_cutoff) else ln.date()
    if db.scalar(select(Trip.id).where(Trip.service_date == target).limit(1)):
        return
    masks = db.execute(select(TripTemplate.days_mask).join(Route).where(Route.status == "live", TripTemplate.active.is_(True))).scalars()
    if not any(runs_on(m, target) for m in masks):
        return   # nothing runs that day (e.g. a Saturday)
    log.info("scheduled allocation for %s", target)
    allocate(db, target)
