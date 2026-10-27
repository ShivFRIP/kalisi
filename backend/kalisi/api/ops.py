import datetime as dt

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import clock
from ..db import get_db
from ..models import AuditLog, Incident, Route, Trip, User
from ..security import require
from ..services import ops as svc
from ..services.allocation import allocate
from ..services.live import trip_live
from ..services.planner import publish, run_planner

router = APIRouter(prefix="/ops", tags=["ops"])
Ops = require("ops")


class DateIn(BaseModel):
    date: dt.date | None = None
    force: bool = False          # demo servers only: replay a day whose trips already ran


class ReassignIn(BaseModel):
    vehicle_id: int


class AssignDriverIn(BaseModel):
    driver_id: int


class ClockIn(BaseModel):
    mode: str = Field(pattern="^(real|sim)$")
    start: dt.datetime | None = None      # local time, e.g. 2026-10-28T07:30
    speed: float = Field(default=1.0, ge=0, le=120)


class IncidentStatusIn(BaseModel):
    status: str = Field(pattern="^(ack|closed)$")


def _day(db: Session, date: dt.date | None) -> dt.date:
    return date or clock.today(db)


@router.get("/overview")
def overview(date: dt.date | None = None, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.overview(db, _day(db, date))


@router.get("/live")
def live(user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.live_vehicles(db)


@router.get("/exceptions")
def exceptions(date: dt.date | None = None, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.exceptions(db, _day(db, date))


@router.get("/routes")
def routes(user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.routes_view(db, clock.today(db))


@router.post("/routes/{route_id}/publish")
def publish_route(route_id: int, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return publish(db, route_id, user.id)


@router.post("/routes/{route_id}/retire")
def retire_route(route_id: int, user: User = Depends(Ops), db: Session = Depends(get_db)):
    r = db.get(Route, route_id)
    if r is None:
        raise HTTPException(404, "Route not found")
    r.status = "retired"
    db.add(AuditLog(user_id=user.id, action="retire_route", detail={"route": r.code}))
    db.commit()
    return {"ok": True}


@router.post("/planner/run")
def planner(user: User = Depends(Ops), db: Session = Depends(get_db)):
    return run_planner(db, user.id)


@router.post("/allocation/run")
def run_allocation(body: DateIn, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return allocate(db, _day(db, body.date), user.id, force=body.force)


@router.get("/allocation")
def allocation(date: dt.date | None = None, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.allocation_view(db, _day(db, date))


@router.post("/trips/{trip_id}/reassign")
def reassign(trip_id: int, body: ReassignIn, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.reassign(db, trip_id, body.vehicle_id, user.id)


@router.post("/duties/{duty_id}/driver")
def assign_driver(duty_id: int, body: AssignDriverIn, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.assign_driver(db, duty_id, body.driver_id, user.id)


@router.get("/trips/{trip_id}/live")
def trip_live_view(trip_id: int, user: User = Depends(Ops), db: Session = Depends(get_db)):
    t = db.get(Trip, trip_id)
    if t is None:
        raise HTTPException(404, "Trip not found")
    return trip_live(db, t, clock.now(db))


@router.get("/fleet")
def fleet(date: dt.date | None = None, user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.fleet(db, _day(db, date))


@router.get("/demand")
def demand(user: User = Depends(Ops), db: Session = Depends(get_db)):
    return svc.demand(db)


@router.post("/clock")
def set_clock(body: ClockIn, user: User = Depends(Ops), db: Session = Depends(get_db)):
    start = body.start.replace(tzinfo=clock.tz()) if body.start and body.start.tzinfo is None else body.start
    clock.set_clock(db, body.mode, start, body.speed)
    db.add(AuditLog(user_id=user.id, action="set_clock", detail={"mode": body.mode, "start": str(body.start), "speed": body.speed}))
    db.commit()
    now, day = clock.now(db), clock.today(db)
    ahead = db.scalar(select(func.count()).select_from(Trip).where(Trip.service_date == day, Trip.status.in_(("in_progress", "completed")),
                                                                  Trip.planned_start > now))
    warning = (f"{ahead} trips on this day already ran past this time, so they won't replay by themselves. "
               "Reset the day to replay it from the new time.") if ahead else None
    return {**clock.describe(db), "warning": warning, "replay_date": day.isoformat()}


@router.post("/incidents/{incident_id}/status")
def incident_status(incident_id: int, body: IncidentStatusIn, user: User = Depends(Ops), db: Session = Depends(get_db)):
    inc = db.get(Incident, incident_id)
    if inc is None:
        raise HTTPException(404, "Incident not found")
    inc.status = body.status
    db.add(AuditLog(user_id=user.id, action="incident_" + body.status, detail={"incident": inc.id}))
    db.commit()
    return {"ok": True}
