"""Driver app: the day's duty, trip manifests, and batched events (design doc section 4.4).

Events carry a client-generated id, so a phone that loses signal can resend a batch without double counting.
The driver confirms boarding with the rider's 4-digit code (or a tap); the driver never sees riders' codes,
phone numbers or home locations. A no-show can only be marked after waiting 2 minutes at the stop.
"""
from __future__ import annotations

import datetime as dt

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock
from ..models import Booking, Driver, Duty, DutyItem, GpsPing, Trip, TripEvent, User, VehiclePosition
from .common import first_name, stop_dict
from .live import delay_min, passed_stop_ids

NO_SHOW_WAIT = dt.timedelta(minutes=2)


class DriverEvent(BaseModel):
    client_event_id: str | None = Field(default=None, min_length=6, max_length=80)  # required except for pings
    trip_id: int
    type: str = Field(pattern="^(start|ping|arrive|depart|board|no_show|end)$")
    stop_id: int | None = None
    seq: int | None = None
    booking_id: int | None = None
    code: str | None = None
    lat: float | None = None
    lon: float | None = None
    speed_kmh: float | None = None
    heading: float | None = None
    device_ts: str | None = None


def driver_of(db: Session, user: User) -> Driver:
    d = db.scalar(select(Driver).where(Driver.user_id == user.id))
    if d is None:
        raise HTTPException(403, "This account is not a driver")
    return d


def _assigned(db: Session, driver: Driver, trip_id: int) -> Trip:
    ok = db.scalar(select(DutyItem.id).join(Duty).where(DutyItem.trip_id == trip_id, Duty.driver_id == driver.id))
    trip = db.get(Trip, trip_id)
    if not ok or trip is None:
        raise HTTPException(404, "This trip isn't on your duty")
    return trip


def duties(db: Session, driver: Driver, day: dt.date) -> dict:
    tz = clock.tz()
    out = []
    for d in db.execute(select(Duty).where(Duty.driver_id == driver.id, Duty.service_date == day).order_by(Duty.report_at)).scalars():
        items = []
        for i in d.items:
            row = {"kind": i.kind, "start": i.start_at.astimezone(tz).strftime("%H:%M"), "end": i.end_at.astimezone(tz).strftime("%H:%M"), "km": i.km}
            if i.trip:
                t = i.trip
                row.update({"trip_id": t.id, "route_code": t.route.code, "route_name": t.route.name, "direction": t.route.direction,
                            "status": t.status, "booked": t.booked, "stops": len(t.route.stops),
                            "length": "long" if (t.planned_end - t.planned_start) >= dt.timedelta(minutes=35) else "short"})
            items.append(row)
        out.append({"duty_id": d.id, "block": d.block, "vehicle": {"reg_no": d.vehicle.reg_no, "class": d.vehicle.vehicle_class.name,
                                                                   "seats": d.vehicle.vehicle_class.seats, "ac": d.vehicle.vehicle_class.ac},
                    "depot": d.vehicle.depot_name, "report": d.report_at.astimezone(tz).strftime("%H:%M"),
                    "sign_off": d.sign_off_at.astimezone(tz).strftime("%H:%M"), "worked_min": d.worked_min, "spread_min": d.spread_min,
                    "deadhead_km": d.deadhead_km, "items": items})
    return {"date": day.isoformat(), "driver": {"name": driver.user.name, "id": driver.id}, "duties": out}


def trip_detail(db: Session, driver: Driver, trip_id: int) -> dict:
    trip = _assigned(db, driver, trip_id)
    now = clock.now(db)
    tz = clock.tz()
    passed = passed_stop_ids(db, trip)
    bookings = db.execute(select(Booking).where(Booking.trip_id == trip.id).order_by(Booking.id)).scalars().all()
    arrivals = {e.stop_id: e.ts for e in db.execute(select(TripEvent).where(TripEvent.trip_id == trip.id, TripEvent.type == "arrive")).scalars()}
    departed = {((e.payload or {}).get("seq"), e.stop_id) for e in db.execute(select(TripEvent).where(TripEvent.trip_id == trip.id, TripEvent.type == "depart")).scalars()}
    stops = []
    for rs in trip.route.stops:
        planned = trip.planned_start + dt.timedelta(minutes=rs.offset_min)
        arr = arrivals.get(rs.stop_id)
        stops.append({**stop_dict(rs.stop), "seq": rs.seq, "action": rs.action, "planned": planned.astimezone(tz).strftime("%H:%M"),
                      "arrived": rs.stop_id in passed, "departed": (rs.seq, rs.stop_id) in departed or (None, rs.stop_id) in departed,
                      "no_show_allowed": bool(arr and now - arr >= NO_SHOW_WAIT),
                      "board": [{"booking_id": b.id, "name": first_name(b.rider.name), "status": b.status}
                                for b in bookings if b.pickup_stop_id == rs.stop_id],
                      "alight": [{"booking_id": b.id, "name": first_name(b.rider.name), "status": b.status}
                                 for b in bookings if b.drop_stop_id == rs.stop_id]})
    return {"trip_id": trip.id, "route_code": trip.route.code, "route_name": trip.route.name, "direction": trip.route.direction,
            "status": trip.status, "gps_source": trip.gps_source, "delay_min": round(delay_min(db, trip, now), 1),
            "vehicle": {"reg_no": trip.vehicle.reg_no, "class": trip.vehicle.vehicle_class.name} if trip.vehicle else None,
            "booked": trip.booked, "boarded": sum(1 for b in bookings if b.status in ("boarded", "completed")), "stops": stops}


def apply_events(db: Session, driver: Driver, events: list[DriverEvent]) -> list[dict]:
    results = []
    for e in events:
        if e.type != "ping" and not e.client_event_id:
            results.append({"client_event_id": None, "status": "rejected", "reason": "client_event_id is required"})
            continue
        if e.type != "ping" and db.scalar(select(TripEvent.id).where(TripEvent.client_event_id == e.client_event_id)):
            results.append({"client_event_id": e.client_event_id, "status": "duplicate"})
            continue
        try:
            trip = _assigned(db, driver, e.trip_id)
            _apply(db, trip, e)
            db.commit()
            results.append({"client_event_id": e.client_event_id, "status": "applied"})
        except HTTPException as ex:
            db.rollback()
            results.append({"client_event_id": e.client_event_id, "status": "rejected", "reason": ex.detail})
    return results


def _record(db: Session, trip: Trip, e: DriverEvent, now: dt.datetime, **kw) -> None:
    db.add(TripEvent(trip_id=trip.id, ts=now, type=e.type, client_event_id=e.client_event_id, source="app",
                     payload={"device_ts": e.device_ts, "seq": e.seq, "lat": e.lat, "lon": e.lon}, **kw))


MAX_EVENT_AGE = dt.timedelta(minutes=15)


def event_time(db: Session, e: DriverEvent) -> dt.datetime:
    """When the driver actually tapped. Events queued offline arrive late; their age on the phone (capped at 15 min,
    never negative) is taken off the system clock, scaled by the demo-clock speed. Phone clocks may be wrong, so only
    the age is trusted, not the absolute device time, and only within the cap."""
    now = clock.now(db)
    if not e.device_ts:
        return now
    try:
        sent = dt.datetime.fromisoformat(e.device_ts.replace("Z", "+00:00"))
        if sent.tzinfo is None:
            return now
    except ValueError:
        return now
    age = dt.datetime.now(dt.timezone.utc) - sent
    age = min(max(age, dt.timedelta()), MAX_EVENT_AGE)
    return now - age * clock.speed(db)


def _apply(db: Session, trip: Trip, e: DriverEvent) -> None:
    now = event_time(db, e)
    if e.type == "start":
        if trip.status not in ("planned", "in_progress"):
            raise HTTPException(409, f"Trip is {trip.status}")
        if trip.status == "planned":
            trip.status, trip.actual_start = "in_progress", now
        trip.gps_source = "app"   # the phone takes over from the simulator
        _record(db, trip, e, now)
        return
    if trip.status != "in_progress":
        raise HTTPException(409, "Start the trip first")
    if e.type == "ping":
        if e.lat is None or e.lon is None:
            raise HTTPException(422, "ping needs lat and lon")
        pos = db.get(VehiclePosition, trip.vehicle_id) or VehiclePosition(vehicle_id=trip.vehicle_id, lat=e.lat, lon=e.lon, ts=now, source="app")
        pos.trip_id, pos.lat, pos.lon, pos.speed_kmh, pos.heading, pos.ts, pos.source = trip.id, e.lat, e.lon, e.speed_kmh, e.heading, now, "app"
        db.merge(pos)
        db.add(GpsPing(vehicle_id=trip.vehicle_id, trip_id=trip.id, ts=now, lat=e.lat, lon=e.lon, speed_kmh=e.speed_kmh, source="app"))
        return
    if e.type in ("arrive", "depart"):
        rs = next((x for x in trip.route.stops if x.stop_id == e.stop_id and (e.seq is None or x.seq == e.seq)), None)
        if rs is None:
            raise HTTPException(422, "That stop isn't on this trip")
        e.seq = rs.seq
        _record(db, trip, e, now, stop_id=rs.stop_id)
        return
    if e.type in ("board", "no_show"):
        b = db.get(Booking, e.booking_id) if e.booking_id else None
        if b is None or b.trip_id != trip.id:
            raise HTTPException(404, "Rider not on this trip")
        if b.status != "confirmed":
            raise HTTPException(409, f"Rider is already {b.status.replace('_', ' ')}")
        if e.type == "board":
            if e.code is not None and e.code.strip() != b.boarding_code:
                raise HTTPException(422, "Wrong boarding code")
            b.status, b.boarded_at = "boarded", now
        else:
            arrived = db.scalar(select(TripEvent.ts).where(TripEvent.trip_id == trip.id, TripEvent.type == "arrive",
                                                          TripEvent.stop_id == b.pickup_stop_id))
            if arrived is None or now - arrived < NO_SHOW_WAIT:
                raise HTTPException(409, "Wait 2 minutes at the stop before marking a no-show")
            b.status = "no_show"
        _record(db, trip, e, now, stop_id=b.pickup_stop_id, booking_id=b.id)
        return
    if e.type == "end":
        trip.status, trip.actual_end = "completed", now
        for b in db.execute(select(Booking).where(Booking.trip_id == trip.id)).scalars():
            if b.status == "boarded":
                b.status = "completed"
            elif b.status == "confirmed":
                b.status = "no_show"
        _record(db, trip, e, now)
