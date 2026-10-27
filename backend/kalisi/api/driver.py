import datetime as dt
from typing import Annotated

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from .. import clock
from ..db import get_db
from ..models import User
from ..security import require
from ..services import driver as svc

router = APIRouter(prefix="/driver", tags=["driver"])
DriverUser = require("driver")


@router.get("/today")
def today(date: dt.date | None = None, user: User = Depends(DriverUser), db: Session = Depends(get_db)):
    return svc.duties(db, svc.driver_of(db, user), date or clock.today(db))


@router.get("/trips/{trip_id}")
def trip(trip_id: int, user: User = Depends(DriverUser), db: Session = Depends(get_db)):
    return svc.trip_detail(db, svc.driver_of(db, user), trip_id)


@router.post("/events")
def events(body: Annotated[list[svc.DriverEvent], Body(max_length=200)], user: User = Depends(DriverUser), db: Session = Depends(get_db)):
    return {"results": svc.apply_events(db, svc.driver_of(db, user), body)}
