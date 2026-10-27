"""Small helpers shared by the services: times of day, weekday masks, route geometry."""
import datetime as dt

from ..geo import Point, path_km
from ..models import Route, RouteStop, Stop, Trip

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def minutes(t: dt.time) -> int:
    return t.hour * 60 + t.minute


def from_minutes(m: float) -> dt.time:
    m = int(round(m)) % (24 * 60)
    return dt.time(m // 60, m % 60)


def add_min(t: dt.time, m: float) -> dt.time:
    return from_minutes(minutes(t) + m)


def day_bit(d: dt.date) -> int:
    return 1 << d.weekday()


def runs_on(mask: int, d: dt.date) -> bool:
    return bool(mask & day_bit(d))


def mask_to_days(mask: int) -> list[int]:
    return [i for i in range(7) if mask & (1 << i)]


def days_to_mask(days: list[int]) -> int:
    m = 0
    for d in days:
        if not 0 <= d <= 6:
            raise ValueError("weekday must be 0 (Mon) to 6 (Sun)")
        m |= 1 << d
    return m


def stop_point(s: Stop) -> Point:
    return (s.lat, s.lon)


def segment_km(route: Route, from_seq: int, to_seq: int) -> float:
    pts = [stop_point(rs.stop) for rs in route.stops if from_seq <= rs.seq <= to_seq]
    return path_km(pts)


def stop_dict(s: Stop) -> dict:
    return {"id": s.id, "name": s.name, "lat": s.lat, "lon": s.lon, "kind": s.kind}


def trip_stop_times(trip: Trip) -> list[tuple[RouteStop, dt.datetime]]:
    return [(rs, trip.planned_start + dt.timedelta(minutes=rs.offset_min)) for rs in trip.route.stops]


def first_name(full: str) -> str:
    parts = (full or "Rider").split()
    return parts[0] + (f" {parts[-1][0]}." if len(parts) > 1 else "")
