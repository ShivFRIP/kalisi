"""GTFS (static) export of live routes, so the service can appear in third-party journey planners (design doc section 8).

Pickup-only stops are exported with drop_off_type=1 and drop-only stops with pickup_type=1. Seats must be
booked in advance; a later version could express that with GTFS-Flex booking rules.
"""
import csv
import datetime as dt
import io
import zipfile

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import clock
from ..models import Route, Stop
from .common import DAY_NAMES, minutes


def _csv(rows: list[list]) -> str:
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerows(rows)
    return buf.getvalue()


def _hms(total_min: int) -> str:
    return f"{total_min // 60:02d}:{total_min % 60:02d}:00"


def build_feed(db: Session, agency_name: str, agency_url: str) -> bytes:
    routes = db.execute(select(Route).where(Route.status == "live").options(selectinload(Route.stops), selectinload(Route.templates))
                        ).scalars().all()
    stop_ids = {rs.stop_id for r in routes for rs in r.stops}
    stops = db.execute(select(Stop).where(Stop.id.in_(stop_ids))).scalars().all() if stop_ids else []
    start = clock.today(db)
    end = start + dt.timedelta(days=365)
    files = {
        "agency.txt": [["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang"],
                       ["kalisi", agency_name, agency_url, "Asia/Kolkata", "en"]],
        "stops.txt": [["stop_id", "stop_name", "stop_lat", "stop_lon"]] +
                     [[f"S{s.id}", s.name, f"{s.lat:.6f}", f"{s.lon:.6f}"] for s in stops],
        "routes.txt": [["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"]] +
                      [[f"R{r.id}", "kalisi", r.code, r.name, 3] for r in routes],
        "calendar.txt": [["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
                          "start_date", "end_date"]],
        "trips.txt": [["route_id", "service_id", "trip_id", "direction_id", "trip_headsign"]],
        "stop_times.txt": [["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type", "drop_off_type"]],
    }
    masks = sorted({t.days_mask for r in routes for t in r.templates if t.active})
    for m in masks:
        files["calendar.txt"].append([f"D{m}"] + [1 if m & (1 << i) else 0 for i in range(len(DAY_NAMES))] +
                                     [start.strftime("%Y%m%d"), end.strftime("%Y%m%d")])
    for r in routes:
        for t in r.templates:
            if not t.active:
                continue
            tid = f"T{t.id}"
            files["trips.txt"].append([f"R{r.id}", f"D{t.days_mask}", tid, 1 if r.direction == "PM" else 0, r.stops[-1].stop.name])
            for rs in r.stops:
                hms = _hms(minutes(t.start_time) + rs.offset_min)
                files["stop_times.txt"].append([tid, hms, hms, f"S{rs.stop_id}", rs.seq + 1,
                                                1 if rs.action == "drop" else 0, 1 if rs.action == "pickup" else 0])
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, rows in files.items():
            z.writestr(name, _csv(rows))
    return out.getvalue()
