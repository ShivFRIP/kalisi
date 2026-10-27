"""Passes, payments and 'not joining' (design doc section 4.3).

Skip rules for a leg on day D:
  before the D-1 cut-off (default 20:00)        -> seat released, ride credit earned
  after the cut-off, until 30 min before pickup -> seat released, no credit
  later than that                               -> refused (the vehicle is already on its way)
"""
from __future__ import annotations

import datetime as dt
import secrets
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock, ledger
from ..config import get_settings
from ..models import Booking, CommuteIntent, Payment, Skip, Subscription, Trip, TripTemplate, User
from ..pricing import PRODUCT_DAYS, pass_price
from .common import add_min, runs_on
from .matching import options_for_intent, parse_option_id, seats_sold


def boarding_code() -> str:
    return f"{secrets.randbelow(10**4):04d}"


class SandboxGateway:
    """Stands in for a payment gateway (UPI / card). Always succeeds. Replace with a real adapter for a pilot."""
    name = "sandbox"

    def charge(self, amount_paise: int, method: str) -> str:
        return "sbx_" + uuid.uuid4().hex[:16]


GATEWAY = SandboxGateway()


def travel_days(sub: Subscription, start: dt.date, end: dt.date) -> int:
    return sum(1 for i in range((end - start).days + 1) if runs_on(sub.days_mask, start + dt.timedelta(days=i)))


def end_pass(db: Session, sub: Subscription, last_day: dt.date, memo: str) -> int:
    """End a pass after `last_day`. Unused travel days come back as ride credit, pro rata to the price
    (policy default; see README). Bookings already made for later days are released. Returns the credit in paise."""
    if sub.valid_to <= last_day:
        return 0
    total = travel_days(sub, sub.valid_from, sub.valid_to)
    unused = travel_days(sub, max(sub.valid_from, last_day + dt.timedelta(days=1)), sub.valid_to)
    # skip credits already given for those later days are part of the refund, not extra to it
    already = sum(k.credit_paise for k in db.execute(select(Skip).where(Skip.subscription_id == sub.id, Skip.service_date > last_day)).scalars())
    credit = max(0, (sub.price_paise * unused // total if total else 0) - already)
    if credit:
        ledger.post(db, [("deferred_revenue", credit, 0), (ledger.rider_account(sub.rider_id), 0, credit)], memo=memo)
    for b in db.execute(select(Booking).join(Trip).where(Booking.subscription_id == sub.id, Trip.service_date > last_day,
                                                          Trip.status == "planned")).scalars():
        if b.status == "confirmed":
            b.trip.booked -= 1
        db.delete(b)
    sub.valid_to = last_day
    if sub.valid_to < sub.valid_from:
        sub.status = "cancelled"
    return credit


def active_passes(db: Session, rider: User, from_day: dt.date) -> list[Subscription]:
    return db.execute(select(Subscription).where(Subscription.rider_id == rider.id, Subscription.status == "active",
                                                 Subscription.valid_to >= from_day)).scalars().all()


def buy_pass(db: Session, rider: User, intent: CommuteIntent, am_option_id: str, pm_option_id: str | None,
             product: str, method: str, replace_pass_id: int | None = None) -> Subscription:
    if product not in PRODUCT_DAYS:
        raise HTTPException(422, "product must be monthly or weekly")
    if intent.rider_id != rider.id:
        raise HTTPException(404, "Commute not found")
    today = clock.today(db)
    starts = today + dt.timedelta(days=1)
    if replace_pass_id is not None:
        old = db.get(Subscription, replace_pass_id)
        if old is None or old.rider_id != rider.id:
            raise HTTPException(404, "Pass to replace not found")
        if old.status == "active" and old.valid_to >= starts:      # a pass already ending tonight needs nothing
            end_pass(db, old, today, memo=f"switched from pass #{old.id}")
            db.flush()
    current = active_passes(db, rider, starts)
    if current:
        raise HTTPException(409, f"You already have a pass until {current[0].valid_to:%-d %b}. Switch to the new one instead of adding a second.")
    am_opts, pm_opts = options_for_intent(db, intent, today, limit=None)
    am = next((o for o in am_opts if o.option_id == am_option_id), None)
    if am is None:
        raise HTTPException(409, "That morning option is no longer available. Refresh to see current options.")
    pm = None
    if pm_option_id:
        pm = next((o for o in pm_opts if o.option_id == pm_option_id), None)
        if pm is None:
            raise HTTPException(409, "That evening option is no longer available. Refresh to see current options.")

    # Lock the departures so two buyers can't both take the last seat.
    ids = [am.template_id] + ([pm.template_id] if pm else [])
    templates = {t.id: t for t in db.execute(select(TripTemplate).where(TripTemplate.id.in_(ids)).with_for_update(of=TripTemplate)).scalars()}
    for tid in ids:
        if seats_sold(db, tid, today) >= templates[tid].vehicle_class.seats:
            db.rollback()
            raise HTTPException(409, "Sorry, the last seat was just taken.")

    price = pass_price(am.fare, pm.fare if pm else None, product) * 100
    use_credit = min(ledger.liability_balance(db, ledger.rider_account(rider.id)), price)
    to_pay = price - use_credit
    valid_from = starts
    sub = Subscription(
        rider_id=rider.id, intent_id=intent.id, product=product,
        am_template_id=am.template_id, am_pickup_stop_id=parse_option_id(am.option_id)[1],
        am_drop_stop_id=parse_option_id(am.option_id)[2], am_fare=am.fare,
        pm_template_id=pm.template_id if pm else None,
        pm_pickup_stop_id=parse_option_id(pm.option_id)[1] if pm else None,
        pm_drop_stop_id=parse_option_id(pm.option_id)[2] if pm else None, pm_fare=pm.fare if pm else None,
        days_mask=intent.days_mask, valid_from=valid_from,
        valid_to=valid_from + dt.timedelta(days=PRODUCT_DAYS[product] - 1), price_paise=price)
    db.add(sub)
    db.flush()
    if to_pay:
        db.add(Payment(rider_id=rider.id, subscription_id=sub.id, amount_paise=to_pay, method=method,
                       gateway=GATEWAY.name, gateway_ref=GATEWAY.charge(to_pay, method), status="captured"))
    elif use_credit:
        db.add(Payment(rider_id=rider.id, subscription_id=sub.id, amount_paise=0, method="credit_only",
                       gateway="none", gateway_ref="credit", status="captured"))
    ledger.post(db, [("gateway_clearing", to_pay, 0), (ledger.rider_account(rider.id), use_credit, 0),
                     ("deferred_revenue", 0, price)], memo=f"{product} pass #{sub.id}")
    intent.status = "subscribed"
    sync_bookings(db, sub)
    db.commit()
    return sub


def sync_bookings(db: Session, sub: Subscription) -> int:
    """Add this pass's bookings to departures that were already allocated (e.g. bought after the cut-off)."""
    added = 0
    for tid, leg, pick, drop in ((sub.am_template_id, "AM", sub.am_pickup_stop_id, sub.am_drop_stop_id),
                                 (sub.pm_template_id, "PM", sub.pm_pickup_stop_id, sub.pm_drop_stop_id)):
        if tid is None:
            continue
        trips = db.execute(select(Trip).where(Trip.template_id == tid, Trip.service_date >= sub.valid_from,
                                              Trip.service_date <= sub.valid_to, Trip.status == "planned")).scalars()
        for trip in trips:
            if not runs_on(sub.days_mask, trip.service_date):
                continue
            skipped = db.scalar(select(Skip.id).where(Skip.subscription_id == sub.id, Skip.service_date == trip.service_date, Skip.leg == leg))
            exists = db.scalar(select(Booking.id).where(Booking.trip_id == trip.id, Booking.subscription_id == sub.id))
            if skipped or exists or trip.booked >= trip.vehicle_class.seats:
                continue
            db.add(Booking(trip_id=trip.id, rider_id=sub.rider_id, subscription_id=sub.id, leg=leg,
                           pickup_stop_id=pick, drop_stop_id=drop, boarding_code=boarding_code()))
            trip.booked += 1
            added += 1
    return added


# ------------------------------------------------------------------------------------------
# Not joining
# ------------------------------------------------------------------------------------------
def pickup_time(db: Session, sub: Subscription, leg: str) -> dt.time:
    tid, stop_id = (sub.am_template_id, sub.am_pickup_stop_id) if leg == "AM" else (sub.pm_template_id, sub.pm_pickup_stop_id)
    t = db.get(TripTemplate, tid)
    off = next(rs.offset_min for rs in t.route.stops if rs.stop_id == stop_id)
    return add_min(t.start_time, off)


def skip_terms(db: Session, sub: Subscription, day: dt.date, leg: str) -> dict:
    s = get_settings()
    now = clock.local_now(db)
    cutoff = dt.datetime.combine(day - dt.timedelta(days=1), dt.time.fromisoformat(s.skip_cutoff), tzinfo=clock.tz())
    pickup = dt.datetime.combine(day, pickup_time(db, sub, leg), tzinfo=clock.tz())
    last_late = pickup - dt.timedelta(minutes=s.late_skip_min_before_departure)
    fare = sub.am_fare if leg == "AM" else (sub.pm_fare or 0)
    if now < cutoff:
        return {"allowed": True, "on_time": True, "credit_paise": fare * s.skip_credit_pct, "deadline": cutoff.isoformat(),
                "note": f"Skip before {cutoff:%-I:%M %p} on {cutoff:%a %-d %b} to get a ₹{fare * s.skip_credit_pct // 100} ride credit."}
    if now < last_late:
        return {"allowed": True, "on_time": False, "credit_paise": 0, "deadline": last_late.isoformat(),
                "note": f"No credit after the {cutoff:%-I:%M %p} cut-off, but skipping frees your seat. Possible until {last_late:%-I:%M %p}."}
    return {"allowed": False, "on_time": False, "credit_paise": 0, "deadline": last_late.isoformat(),
            "note": "Too late to skip: the vehicle is already on its way."}


def _check_leg(sub: Subscription, day: dt.date, leg: str) -> None:
    if leg not in ("AM", "PM") or (leg == "PM" and sub.pm_template_id is None):
        raise HTTPException(422, "This pass has no such leg")
    if not (sub.valid_from <= day <= sub.valid_to) or not runs_on(sub.days_mask, day):
        raise HTTPException(422, "You aren't booked to travel that day")


def skip(db: Session, rider: User, sub_id: int, day: dt.date, leg: str) -> Skip:
    sub = db.get(Subscription, sub_id)
    if sub is None or sub.rider_id != rider.id or sub.status != "active":
        raise HTTPException(404, "Pass not found")
    _check_leg(sub, day, leg)
    if db.scalar(select(Skip.id).where(Skip.subscription_id == sub.id, Skip.service_date == day, Skip.leg == leg)):
        raise HTTPException(409, "Already marked as not joining")
    terms = skip_terms(db, sub, day, leg)
    if not terms["allowed"]:
        raise HTTPException(409, terms["note"])
    sk = Skip(subscription_id=sub.id, rider_id=rider.id, service_date=day, leg=leg, on_time=terms["on_time"],
              credit_paise=terms["credit_paise"])
    db.add(sk)
    if sk.credit_paise:
        ledger.post(db, [("deferred_revenue", sk.credit_paise, 0), (ledger.rider_account(rider.id), 0, sk.credit_paise)],
                    memo=f"skip credit {day} {leg}")
    b = _booking_for(db, sub, day, leg)
    if b and b.status == "confirmed":
        b.status = "skipped"
        b.trip.booked -= 1
    db.commit()
    return sk


def unskip(db: Session, rider: User, skip_id: int) -> None:
    sk = db.get(Skip, skip_id)
    if sk is None or sk.rider_id != rider.id:
        raise HTTPException(404, "Not found")
    sub = db.get(Subscription, sk.subscription_id)
    terms = skip_terms(db, sub, sk.service_date, sk.leg)
    if not terms["allowed"]:
        raise HTTPException(409, "Too late to change: the vehicle is already on its way.")
    b = _booking_for(db, sub, sk.service_date, sk.leg)
    if b and b.status == "skipped":
        if b.trip.booked >= b.trip.vehicle_class.seats:
            raise HTTPException(409, "Your seat has been given to someone else for that trip.")
        b.status = "confirmed"
        b.trip.booked += 1
    if sk.credit_paise:
        if ledger.liability_balance(db, ledger.rider_account(rider.id)) < sk.credit_paise:
            raise HTTPException(409, "The credit from this skip has already been used.")
        ledger.post(db, [(ledger.rider_account(rider.id), sk.credit_paise, 0), ("deferred_revenue", 0, sk.credit_paise)],
                    memo=f"undo skip {sk.service_date} {sk.leg}")
    db.delete(sk)
    db.commit()


def _booking_for(db: Session, sub: Subscription, day: dt.date, leg: str) -> Booking | None:
    tid = sub.am_template_id if leg == "AM" else sub.pm_template_id
    return db.scalar(select(Booking).join(Trip).where(Booking.subscription_id == sub.id, Trip.template_id == tid,
                                                      Trip.service_date == day))


def rider_days(db: Session, rider: User, n: int = 7) -> list[dict]:
    """The rider's next n days: each leg's departure and status, and what skipping would mean."""
    today = clock.today(db)
    subs = db.execute(select(Subscription).where(Subscription.rider_id == rider.id, Subscription.status == "active",
                                                 Subscription.valid_to >= today)).scalars().all()
    out = []
    for i in range(n):
        day = today + dt.timedelta(days=i)
        legs = []
        for sub in subs:
            if not (sub.valid_from <= day <= sub.valid_to) or not runs_on(sub.days_mask, day):
                continue
            for leg in ("AM", "PM") if sub.pm_template_id else ("AM",):
                sk = db.scalar(select(Skip).where(Skip.subscription_id == sub.id, Skip.service_date == day, Skip.leg == leg))
                b = _booking_for(db, sub, day, leg)
                terms = skip_terms(db, sub, day, leg)
                tid = sub.am_template_id if leg == "AM" else sub.pm_template_id
                stop_id = sub.am_pickup_stop_id if leg == "AM" else sub.pm_pickup_stop_id
                t = db.get(TripTemplate, tid)
                pick = next(rs for rs in t.route.stops if rs.stop_id == stop_id)
                status = "skipped" if sk else (b.status if b else "scheduled")
                if b and b.trip.status in ("in_progress", "completed") and status == "confirmed":
                    status = "on_trip" if b.trip.status == "in_progress" else "missed"
                legs.append({
                    "subscription_id": sub.id, "leg": leg, "route_code": t.route.code,
                    "pickup_time": add_min(t.start_time, pick.offset_min).strftime("%H:%M"), "pickup_stop": pick.stop.name,
                    "status": status, "booking_id": b.id if b else None, "trip_status": b.trip.status if b else None,
                    "skip_id": sk.id if sk else None, "skip_credit_paise": sk.credit_paise if sk else 0,
                    "can_skip": terms["allowed"] and not sk and status in ("scheduled", "confirmed"),
                    "can_undo": bool(sk) and terms["allowed"], "terms": terms})
        out.append({"date": day.isoformat(), "weekday": day.strftime("%a"), "legs": legs})
    return out

