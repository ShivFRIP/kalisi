import datetime as dt

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock, ledger
from ..config import get_settings
from ..db import get_db
from ..geo import cell
from ..models import Booking, CommuteIntent, Duty, DutyItem, LedgerEntry, Payment, Rating, Subscription, Trip, User
from ..pricing import pass_price
from ..security import require
from ..services import passes
from ..services.common import days_to_mask, mask_to_days
from ..services.live import trip_live
from ..services.matching import nearest_campus, options_for_intent, similar_pooled

router = APIRouter(prefix="/rider", tags=["rider"])
Rider = require("rider")


class Place(BaseModel):
    lat: float = Field(ge=16.8, le=18.2)     # Hyderabad metropolitan region, generously
    lon: float = Field(ge=77.8, le=79.2)
    label: str = Field(default="", max_length=120)


class IntentIn(BaseModel):
    home: Place
    office: Place
    am_from: dt.time
    am_to: dt.time
    pm_from: dt.time | None = None
    pm_to: dt.time | None = None
    days: list[int] = Field(default=[0, 1, 2, 3, 4], min_length=1)
    ac_only: bool = True
    max_walk_m: int = Field(default=800, ge=200, le=2000)


class PassIn(BaseModel):
    intent_id: int
    am_option_id: str
    pm_option_id: str | None = None
    product: str = Field(pattern="^(monthly|weekly)$")
    method: str = Field(default="upi", pattern="^(upi|card)$")
    replace_pass_id: int | None = None     # switching commute: end this pass tonight, unused days become credit


class SkipIn(BaseModel):
    subscription_id: int
    date: dt.date
    leg: str = Field(pattern="^(AM|PM)$")


class RatingIn(BaseModel):
    driver_score: int = Field(ge=1, le=5)
    vehicle_score: int = Field(ge=1, le=5)
    tags: list[str] = Field(default=[], max_length=8)
    comment: str = Field(default="", max_length=500)


RATING_TAGS = {"ac_working", "clean", "courteous_driver", "smooth_driving", "felt_safe", "on_time",
               "ac_not_working", "dirty", "rash_driving", "felt_unsafe", "crowded", "rude"}


def intent_dict(it: CommuteIntent) -> dict:
    return {"id": it.id, "home": {"lat": it.home_lat, "lon": it.home_lon, "label": it.home_label},
            "office": {"lat": it.office_lat, "lon": it.office_lon, "label": it.office_label},
            "am_from": it.am_from.strftime("%H:%M"), "am_to": it.am_to.strftime("%H:%M"),
            "pm_from": it.pm_from.strftime("%H:%M") if it.pm_from else None, "pm_to": it.pm_to.strftime("%H:%M") if it.pm_to else None,
            "days": mask_to_days(it.days_mask), "ac_only": it.ac_only, "max_walk_m": it.max_walk_m, "status": it.status,
            "campus_id": it.campus_id}


def _options_payload(db: Session, it: CommuteIntent) -> dict:
    am, pm = options_for_intent(db, it, clock.today(db))
    return {"intent": intent_dict(it), "am_options": [o.as_dict() for o in am], "pm_options": [o.as_dict() for o in pm],
            "pooled": not am, "similar_nearby": similar_pooled(db, it) if not am else None,
            "credit_paise": ledger.liability_balance(db, ledger.rider_account(it.rider_id))}


@router.post("/intents")
def create_intent(body: IntentIn, user: User = Depends(Rider), db: Session = Depends(get_db)):
    if body.am_from >= body.am_to or (body.pm_from and body.pm_to and body.pm_from >= body.pm_to):
        raise HTTPException(422, "Window start must be before its end")
    if (body.pm_from is None) != (body.pm_to is None):
        raise HTTPException(422, "Give both ends of the evening window, or neither")
    it = CommuteIntent(rider_id=user.id, home_lat=body.home.lat, home_lon=body.home.lon, home_label=body.home.label,
                       home_h3_r9=cell(body.home.lat, body.home.lon), office_lat=body.office.lat, office_lon=body.office.lon,
                       office_label=body.office.label, am_from=body.am_from, am_to=body.am_to, pm_from=body.pm_from,
                       pm_to=body.pm_to, days_mask=days_to_mask(body.days), ac_only=body.ac_only, max_walk_m=body.max_walk_m)
    c = nearest_campus(db, (body.office.lat, body.office.lon))
    it.campus_id = c.id if c else None
    db.add(it)
    db.flush()
    payload = _options_payload(db, it)
    it.status = "pooled" if payload["pooled"] else "matched"
    payload["intent"]["status"] = it.status
    db.commit()
    return payload


@router.get("/intents/{intent_id}/options")
def intent_options(intent_id: int, user: User = Depends(Rider), db: Session = Depends(get_db)):
    it = db.get(CommuteIntent, intent_id)
    if it is None or it.rider_id != user.id:
        raise HTTPException(404, "Commute not found")
    return _options_payload(db, it)


@router.get("/quote")
def quote(am_fare: int, pm_fare: int | None = None, user: User = Depends(Rider), db: Session = Depends(get_db)):
    """Pass prices for display. The price actually charged is recomputed from the chosen options at purchase."""
    return {"weekly": pass_price(am_fare, pm_fare, "weekly"), "monthly": pass_price(am_fare, pm_fare, "monthly"),
            "credit_paise": ledger.liability_balance(db, ledger.rider_account(user.id))}


@router.post("/passes")
def buy(body: PassIn, user: User = Depends(Rider), db: Session = Depends(get_db)):
    it = db.get(CommuteIntent, body.intent_id)
    if it is None:
        raise HTTPException(404, "Commute not found")
    sub = passes.buy_pass(db, user, it, body.am_option_id, body.pm_option_id, body.product, body.method, body.replace_pass_id)
    return pass_dict(db, sub)


def pass_dict(db: Session, s: Subscription) -> dict:
    from ..models import Stop, TripTemplate
    am_t = db.get(TripTemplate, s.am_template_id)
    pm_t = db.get(TripTemplate, s.pm_template_id) if s.pm_template_id else None
    pay = db.scalar(select(Payment).where(Payment.subscription_id == s.id))
    return {"id": s.id, "product": s.product, "valid_from": s.valid_from.isoformat(), "valid_to": s.valid_to.isoformat(),
            "price_paise": s.price_paise, "paid_paise": pay.amount_paise if pay else 0, "status": s.status,
            "days": mask_to_days(s.days_mask),
            "am": {"route_code": am_t.route.code, "route_name": am_t.route.name, "pickup": db.get(Stop, s.am_pickup_stop_id).name,
                   "drop": db.get(Stop, s.am_drop_stop_id).name, "fare": s.am_fare, "vehicle": am_t.vehicle_class.name},
            "pm": {"route_code": pm_t.route.code, "route_name": pm_t.route.name, "pickup": db.get(Stop, s.pm_pickup_stop_id).name,
                   "drop": db.get(Stop, s.pm_drop_stop_id).name, "fare": s.pm_fare, "vehicle": pm_t.vehicle_class.name} if pm_t else None}


def _current_booking(db: Session, user: User) -> Booking | None:
    """The rider's trip to show now: one in progress, else the next one today, else one just finished."""
    now = clock.now(db)
    today = clock.today(db)
    rows = db.execute(select(Booking).join(Trip).where(Booking.rider_id == user.id, Trip.service_date == today)
                      .order_by(Trip.planned_start)).scalars().all()
    live = [b for b in rows if b.trip.status == "in_progress" and b.status in ("confirmed", "boarded")]
    if live:
        return live[0]
    upcoming = [b for b in rows if b.trip.status == "planned" and b.status == "confirmed"]
    if upcoming:
        return upcoming[0]
    return None


def _pending_rating(db: Session, user: User) -> Booking | None:
    since = clock.today(db) - dt.timedelta(days=2)
    return db.scalar(select(Booking).join(Trip).outerjoin(Rating, Rating.booking_id == Booking.id)
                     .where(Booking.rider_id == user.id, Booking.status == "completed", Trip.service_date >= since, Rating.id.is_(None))
                     .order_by(Trip.planned_end.desc()).limit(1))


@router.get("/home")
def home(user: User = Depends(Rider), db: Session = Depends(get_db)):
    today = clock.today(db)
    subs = db.execute(select(Subscription).where(Subscription.rider_id == user.id, Subscription.status == "active",
                                                 Subscription.valid_to >= today).order_by(Subscription.valid_from)).scalars().all()
    intent = db.scalar(select(CommuteIntent).where(CommuteIntent.rider_id == user.id).order_by(CommuteIntent.id.desc()).limit(1))
    cur = _current_booking(db, user)
    pend = _pending_rating(db, user)
    return {"user": {"id": user.id, "name": user.name, "phone": user.phone},
            "credit_paise": ledger.liability_balance(db, ledger.rider_account(user.id)),
            "passes": [pass_dict(db, s) for s in subs], "intent": intent_dict(intent) if intent else None,
            "days": passes.rider_days(db, user, 7),
            "current": trip_live(db, cur.trip, clock.now(db), cur) if cur else None,
            "pending_rating": {"booking_id": pend.id, "route_code": pend.trip.route.code, "date": pend.trip.service_date.isoformat(),
                               "leg": pend.leg} if pend else None,
            "skip_cutoff": get_settings().skip_cutoff}


@router.post("/passes/{pass_id}/cancel")
def cancel_pass(pass_id: int, user: User = Depends(Rider), db: Session = Depends(get_db)):
    """End a pass tonight. Unused travel days come back as ride credit, pro rata to the price."""
    sub = db.get(Subscription, pass_id)
    if sub is None or sub.rider_id != user.id or sub.status != "active":
        raise HTTPException(404, "Pass not found")
    credit = passes.end_pass(db, sub, clock.today(db), memo=f"cancelled pass #{sub.id}")
    db.commit()
    return {"credit_paise": credit, "valid_to": sub.valid_to.isoformat()}


@router.post("/skips")
def skip(body: SkipIn, user: User = Depends(Rider), db: Session = Depends(get_db)):
    sk = passes.skip(db, user, body.subscription_id, body.date, body.leg)
    return {"skip_id": sk.id, "on_time": sk.on_time, "credit_paise": sk.credit_paise}


@router.delete("/skips/{skip_id}")
def unskip(skip_id: int, user: User = Depends(Rider), db: Session = Depends(get_db)):
    passes.unskip(db, user, skip_id)
    return {"ok": True}


@router.get("/bookings/{booking_id}/live")
def booking_live(booking_id: int, user: User = Depends(Rider), db: Session = Depends(get_db)):
    b = db.get(Booking, booking_id)
    if b is None or b.rider_id != user.id:
        raise HTTPException(404, "Booking not found")
    return trip_live(db, b.trip, clock.now(db), b)


@router.post("/bookings/{booking_id}/rating")
def rate(booking_id: int, body: RatingIn, user: User = Depends(Rider), db: Session = Depends(get_db)):
    b = db.get(Booking, booking_id)
    if b is None or b.rider_id != user.id:
        raise HTTPException(404, "Booking not found")
    if b.status != "completed":
        raise HTTPException(409, "You can rate a trip once you've completed it")
    if db.scalar(select(Rating.id).where(Rating.booking_id == b.id)):
        raise HTTPException(409, "Already rated")
    bad = set(body.tags) - RATING_TAGS
    if bad:
        raise HTTPException(422, f"Unknown tags: {', '.join(sorted(bad))}")
    duty = db.scalar(select(Duty).join(DutyItem).where(DutyItem.trip_id == b.trip_id))
    db.add(Rating(booking_id=b.id, rider_id=user.id, driver_id=duty.driver_id if duty else None, vehicle_id=b.trip.vehicle_id,
                  driver_score=body.driver_score, vehicle_score=body.vehicle_score, tags=body.tags, comment=body.comment.strip()))
    db.commit()
    return {"ok": True}


@router.get("/history")
def history(user: User = Depends(Rider), db: Session = Depends(get_db)):
    rows = db.execute(select(Booking, Rating).join(Trip).outerjoin(Rating, Rating.booking_id == Booking.id)
                      .where(Booking.rider_id == user.id, Trip.service_date <= clock.today(db))
                      .order_by(Trip.planned_start.desc()).limit(40)).all()
    tz = clock.tz()
    def pickup_at(b: Booking) -> str:
        off = next((rs.offset_min for rs in b.trip.route.stops if rs.stop_id == b.pickup_stop_id), 0)
        return (b.trip.planned_start + dt.timedelta(minutes=off)).astimezone(tz).strftime("%H:%M")
    return [{"booking_id": b.id, "date": b.trip.service_date.isoformat(), "leg": b.leg, "route_code": b.trip.route.code,
             "pickup": b.pickup_stop.name, "drop": b.drop_stop.name, "status": b.status,
             "planned": b.trip.planned_start.astimezone(tz).strftime("%H:%M"), "pickup_time": pickup_at(b),
             "rating": {"driver": r.driver_score, "vehicle": r.vehicle_score} if r else None} for b, r in rows]


@router.get("/wallet")
def wallet(user: User = Depends(Rider), db: Session = Depends(get_db)):
    acct = ledger.rider_account(user.id)
    lines = db.execute(select(LedgerEntry).where(LedgerEntry.account == acct).order_by(LedgerEntry.id.desc()).limit(50)).scalars()
    pays = db.execute(select(Payment).where(Payment.rider_id == user.id).order_by(Payment.id.desc())).scalars()
    return {"credit_paise": ledger.liability_balance(db, acct),
            "credit_lines": [{"at": e.created_at.isoformat(), "memo": e.memo, "paise": e.credit_paise - e.debit_paise} for e in lines],
            "payments": [{"at": p.created_at.isoformat(), "amount_paise": p.amount_paise, "method": p.method, "gateway": p.gateway,
                          "ref": p.gateway_ref, "status": p.status} for p in pays]}

