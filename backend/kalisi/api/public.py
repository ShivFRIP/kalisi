from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import clock
from ..db import get_db
from ..models import Booking, Campus, Driver, Duty, DutyItem, Incident, Route, Trip, User
from ..security import current_user
from ..services.gtfs import build_feed
from ..services.planner import PLACES

router = APIRouter(tags=["public"])


class SosIn(BaseModel):
    trip_id: int | None = None
    lat: float | None = None
    lon: float | None = None
    note: str = Field(default="", max_length=500)


@router.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(select(1))
    return {"ok": True}


@router.get("/clock")
def get_clock(db: Session = Depends(get_db)):
    return clock.describe(db)


@router.get("/public/places")
def places(db: Session = Depends(get_db)):
    """Quick picks for address entry: office clusters, localities and Metro stations (OSM / HMRL GTFS)."""
    out = [{"name": c.name, "kind": "office", "lat": c.lat, "lon": c.lon} for c in db.execute(select(Campus)).scalars()]
    out += [{"name": n, "kind": "area", "lat": p[0], "lon": p[1]} for n, p in PLACES["localities"].items()]
    out += [{"name": s["name"] + " Metro", "kind": "metro", "lat": s["point"][0], "lon": s["point"][1]}
            for line in PLACES["metro"].values() for s in line]
    return {"sources": PLACES["_sources"], "places": out}


@router.get("/public/network")
def network(db: Session = Depends(get_db)):
    routes = db.execute(select(Route).where(Route.status == "live").options(selectinload(Route.stops))).scalars().all()
    return [{"code": r.code, "name": r.name, "direction": r.direction, "express": r.express,
             "stops": [{"name": rs.stop.name, "lat": rs.stop.lat, "lon": rs.stop.lon} for rs in r.stops]} for r in routes]


@router.get("/public/gtfs.zip")
def gtfs(db: Session = Depends(get_db)):
    data = build_feed(db, "Kalisi (prototype)", "https://example.org/kalisi")
    return Response(data, media_type="application/zip", headers={"Content-Disposition": "attachment; filename=kalisi-gtfs.zip"})


@router.post("/sos")
def sos(body: SosIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.trip_id is not None:
        trip = db.get(Trip, body.trip_id)
        mine = trip and (user.role == "ops" or
                         (user.role == "driver" and db.scalar(select(DutyItem.id).join(Duty).join(Driver)
                                                              .where(DutyItem.trip_id == trip.id, Driver.user_id == user.id))) or
                         db.scalar(select(Booking.id).where(Booking.trip_id == trip.id, Booking.rider_id == user.id)))
        if not mine:
            raise HTTPException(404, "Trip not found")
    inc = Incident(trip_id=body.trip_id, reported_by=user.id, kind="sos", severity="critical", lat=body.lat, lon=body.lon,
                   note=f"{user.role} {user.name or user.phone}: {body.note}".strip())
    db.add(inc)
    db.commit()
    return {"incident_id": inc.id, "message": "Alert sent to the control room with your trip and location."}
