"""One clock for the whole system, so a demo can run a 'morning peak' at any time of day.

mode 'real': wall clock. mode 'sim': time starts at anchor_sim when it was set and runs at `speed` x real time
(speed 0 freezes it, which the tests use). Every time-dependent rule (skip cut-off, trip progress) reads this clock.
"""
import datetime as dt
import time
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from .config import get_settings
from .models import SimClock

UTC = dt.timezone.utc
_cache: dict = {"at": 0.0, "snap": None}


def tz() -> ZoneInfo:
    return ZoneInfo(get_settings().timezone)


def invalidate() -> None:
    _cache["at"], _cache["snap"] = 0.0, None


def _snapshot(db: Session):
    if _cache["snap"] is not None and time.monotonic() - _cache["at"] < 1.0:
        return _cache["snap"]
    row = db.get(SimClock, 1)
    snap = (row.mode, row.anchor_real, row.anchor_sim, row.speed) if row else ("real", None, None, 1.0)
    _cache["at"], _cache["snap"] = time.monotonic(), snap
    return snap


def now(db: Session) -> dt.datetime:
    mode, anchor_real, anchor_sim, speed = _snapshot(db)
    real = dt.datetime.now(UTC)
    if mode != "sim" or anchor_real is None or anchor_sim is None:
        return real
    return anchor_sim + (real - anchor_real) * speed


def speed(db: Session) -> float:
    """1.0 on the wall clock; the demo-clock speed in sim mode."""
    mode, _, _, sp = _snapshot(db)
    return sp if mode == "sim" else 1.0


def local_now(db: Session) -> dt.datetime:
    return now(db).astimezone(tz())


def today(db: Session) -> dt.date:
    return local_now(db).date()


def at_local(day: dt.date, t: dt.time) -> dt.datetime:
    """A local date + time of day as an aware UTC instant."""
    return dt.datetime.combine(day, t, tzinfo=tz()).astimezone(UTC)


def set_clock(db: Session, mode: str, sim_start_local: dt.datetime | None = None, speed: float = 1.0) -> None:
    row = db.get(SimClock, 1) or SimClock(id=1)
    row.mode = mode
    row.speed = speed
    if mode == "sim":
        start = sim_start_local if sim_start_local is not None else local_now(db)
        if start.tzinfo is None:
            start = start.replace(tzinfo=tz())
        row.anchor_real = dt.datetime.now(UTC)
        row.anchor_sim = start.astimezone(UTC)
    else:
        row.anchor_real = row.anchor_sim = None
    db.merge(row)
    db.commit()
    invalidate()


def describe(db: Session) -> dict:
    mode, _, _, speed = _snapshot(db)
    return {"mode": mode, "speed": speed, "now": local_now(db).isoformat(timespec="seconds"), "timezone": get_settings().timezone}
