"""Match a commuter to existing departures (design doc section 4.2).

An option is a (trip template, pickup stop, drop stop) triple. Its id encodes the triple, and the server
re-derives it at purchase time, so prices and seat counts are never taken from the client.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import asdict, dataclass

from geoalchemy2 import Geography
from sqlalchemy import cast, func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..config import get_settings
from ..geo import Point, drive_min, haversine_km, walk_m
from ..models import Campus, CommuteIntent, Route, Stop, Subscription, TripTemplate
from ..pricing import express_fare, ride_fare
from .common import add_min, minutes, segment_km, stop_dict

WALK_M_PER_MIN = 80


@dataclass
class Option:
    option_id: str
    leg: str
    template_id: int
    route_code: str
    route_name: str
    express: bool
    pickup: dict
    drop: dict
    walk_to_pickup_m: int
    walk_from_drop_m: int
    depart: str          # HH:MM at the pickup stop
    arrive: str          # HH:MM at the drop stop
    ride_min: int
    road_km: float
    fare: int
    vehicle: str
    seats: int
    ac: bool
    seats_left: int
    score: float

    def as_dict(self) -> dict:
        return asdict(self)


def option_id(template_id: int, pickup_id: int, drop_id: int) -> str:
    return f"{template_id}:{pickup_id}:{drop_id}"


def parse_option_id(oid: str) -> tuple[int, int, int]:
    try:
        a, b, c = (int(x) for x in oid.split(":"))
        return a, b, c
    except ValueError:
        raise ValueError("bad option id")


def seats_sold(db: Session, template_id: int, on: dt.date) -> int:
    q = select(func.count()).select_from(Subscription).where(
        Subscription.status == "active", Subscription.valid_to >= on,
        or_(Subscription.am_template_id == template_id, Subscription.pm_template_id == template_id))
    return int(db.scalar(q))


def _stops_near(db: Session, p: Point, walk_cap_m: int) -> dict[int, int]:
    """stop id -> estimated walking metres, for active stops within the walking cap."""
    radius = walk_cap_m / get_settings().walk_factor
    here = cast(func.ST_SetSRID(func.ST_MakePoint(p[1], p[0]), 4326), Geography)
    rows = db.execute(select(Stop).where(Stop.active.is_(True), func.ST_DWithin(Stop.geom, here, radius))).scalars()
    return {s.id: walk_m(p, (s.lat, s.lon)) for s in rows}


def find_options(db: Session, *, leg: str, origin: Point, dest: Point, window: tuple[dt.time, dt.time],
                 days_mask: int, ac_only: bool, origin_walk_m: int, dest_walk_m: int, today: dt.date,
                 limit: int | None = 3) -> list[Option]:
    """leg 'AM': origin=home, dest=office, window = arrival window at the office.
       leg 'PM': origin=office, dest=home, window = departure window from the office."""
    s = get_settings()
    near_o, near_d = _stops_near(db, origin, origin_walk_m), _stops_near(db, dest, dest_walk_m)
    if not near_o or not near_d:
        return []
    direct = drive_min(origin, dest)
    ride_cap = min(s.detour_alpha * direct, direct + s.detour_beta_min)
    w_from, w_to = minutes(window[0]), minutes(window[1])
    if leg == "AM":
        lo, hi, target = w_from - s.early_arrival_tolerance_min, w_to, (w_from + w_to) / 2
    else:
        lo, hi, target = w_from, w_to + s.late_departure_tolerance_min, w_from + 10

    routes = db.execute(select(Route).where(Route.status == "live", Route.direction == leg)
                        .options(selectinload(Route.stops), selectinload(Route.templates))).scalars().all()
    best: dict[int, Option] = {}
    for r in routes:
        pickups = [rs for rs in r.stops if rs.stop_id in near_o and rs.action in ("pickup", "both")]
        drops = [rs for rs in r.stops if rs.stop_id in near_d and rs.action in ("drop", "both")]
        pairs = [(p, d) for p in pickups for d in drops if d.seq > p.seq]
        if not pairs:
            continue
        for t in r.templates:
            if not t.active or (days_mask & ~t.days_mask):
                continue
            if ac_only and not (t.ac_required and t.vehicle_class.ac):
                continue
            for p, d in pairs:
                depart, arrive = minutes(t.start_time) + p.offset_min, minutes(t.start_time) + d.offset_min
                key_time = arrive if leg == "AM" else depart
                if not lo <= key_time <= hi:
                    continue
                ride = d.offset_min - p.offset_min
                if ride > max(ride_cap, 15):
                    continue
                km = round(segment_km(r, p.seq, d.seq), 1)
                wo, wd = near_o[p.stop_id], near_d[d.stop_id]
                fare = express_fare(ride_fare(km)) if r.express else ride_fare(km)
                score = (wo + wd) / WALK_M_PER_MIN + 0.5 * abs(key_time - target) + 0.3 * ride + 0.05 * fare
                if t.id in best and best[t.id].score <= score:
                    continue
                best[t.id] = Option(
                    option_id=option_id(t.id, p.stop_id, d.stop_id), leg=leg, template_id=t.id,
                    route_code=r.code, route_name=r.name, express=r.express,
                    pickup=stop_dict(p.stop), drop=stop_dict(d.stop), walk_to_pickup_m=wo, walk_from_drop_m=wd,
                    depart=add_min(t.start_time, p.offset_min).strftime("%H:%M"),
                    arrive=add_min(t.start_time, d.offset_min).strftime("%H:%M"),
                    ride_min=ride, road_km=km, fare=fare, vehicle=t.vehicle_class.name, seats=t.vehicle_class.seats,
                    ac=t.vehicle_class.ac, seats_left=0, score=round(score, 2))
    out = []
    for o in sorted(best.values(), key=lambda o: o.score):
        left = next(t.vehicle_class.seats for r in routes for t in r.templates if t.id == o.template_id) - seats_sold(db, o.template_id, today)
        if left > 0:
            o.seats_left = left
            out.append(o)
        if limit and len(out) >= limit:
            break
    return out


def options_for_intent(db: Session, intent: CommuteIntent, today: dt.date, limit: int | None = 3) -> tuple[list[Option], list[Option]]:
    s = get_settings()
    home, office = (intent.home_lat, intent.home_lon), (intent.office_lat, intent.office_lon)
    am = find_options(db, leg="AM", origin=home, dest=office, window=(intent.am_from, intent.am_to), days_mask=intent.days_mask,
                      ac_only=intent.ac_only, origin_walk_m=intent.max_walk_m, dest_walk_m=s.office_walk_m, today=today, limit=limit)
    pm = []
    if intent.pm_from and intent.pm_to:
        pm = find_options(db, leg="PM", origin=office, dest=home, window=(intent.pm_from, intent.pm_to), days_mask=intent.days_mask,
                          ac_only=intent.ac_only, origin_walk_m=s.office_walk_m, dest_walk_m=intent.max_walk_m, today=today, limit=limit)
    return am, pm


def nearest_campus(db: Session, p: Point, within_km: float = 2.5) -> Campus | None:
    best, best_d = None, within_km
    for c in db.execute(select(Campus)).scalars():
        d = haversine_km(p, (c.lat, c.lon))
        if d <= best_d:
            best, best_d = c, d
    return best


def similar_pooled(db: Session, intent: CommuteIntent) -> int | None:
    """How many pooled riders want a similar trip: home in the same H3 res-7 zone (about 5 km^2), same office
    cluster, arrival window starting within 30 minutes. Returned only when >= k, so neighbours can't be inferred."""
    from ..geo import parent
    if intent.campus_id is None:
        return None
    zone = parent(intent.home_h3_r9, 7)
    rows = db.execute(select(CommuteIntent.home_h3_r9, CommuteIntent.am_from).where(
        CommuteIntent.status == "pooled", CommuteIntent.campus_id == intent.campus_id)).all()
    n = sum(1 for c, t in rows if parent(c, 7) == zone and abs(minutes(t) - minutes(intent.am_from)) <= 30)
    return n if n >= get_settings().k_anonymity else None
