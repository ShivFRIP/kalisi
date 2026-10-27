"""Daily allocation (design doc sections 6.3 and 6.4). Runs after the D-1 cut-off, or on demand from the ops console.

1. Bookings for day D = active passes running that weekday, minus 'not joining' skips.
2. Right-size: each departure gets the smallest vehicle class that seats its bookings (plus a small buffer,
   capped at the seats sold) and meets the AC requirement. Departures with no bookings are cancelled.
3. Vehicle chaining (CP-SAT): assign departures to vehicles so that a vehicle only takes trips it can reach in
   time (end + empty run + turnaround <= next start), minimising vehicles used, oversized seats and empty
   running from the depot. A vehicle that finishes a long morning run is reused for short feeder loops.
4. Duties: a vehicle's day becomes one driver duty, split into a morning and an evening block at the longest
   idle gap when spread-over or hours worked exceed the caps. Drivers with expired documents are never used,
   and vehicles with an expired permit, fitness, insurance or pollution certificate are never assigned.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field

from fastapi import HTTPException
from ortools.sat.python import cp_model
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from .. import clock
from ..config import get_settings
from ..geo import Point, haversine_km, road_km
from ..models import (AuditLog, Booking, Driver, Duty, DutyItem, Route, Skip, Subscription, Trip, TripTemplate,
                      Vehicle, VehicleClass, VehiclePosition)
from .common import runs_on, stop_point
from .passes import boarding_code

OVERSIZE_COST = 40     # Rs per empty seat carried (assumption; nudges the solver to the right-sized vehicle)
UNASSIGNED_COST = 10**6


@dataclass
class Plan:
    template: TripTemplate
    start: dt.datetime
    end: dt.datetime
    start_pt: Point
    end_pt: Point
    riders: list[tuple[Subscription, str]] = field(default_factory=list)  # (pass, leg)
    required: int = 0
    vclass: VehicleClass | None = None
    overflow: bool = False
    vehicle: Vehicle | None = None
    trip: Trip | None = None


def deadhead(a: Point, b: Point) -> tuple[float, float]:
    """(minutes, km) for an empty run between two points, off-peak speed."""
    km = road_km(a, b)
    return km / get_settings().offpeak_speed_kmh * 60, km


def sim_delay(template_id: int, day: dt.date) -> int:
    """Deterministic 'traffic' for the simulator: mostly 0-4 minutes late, about one trip in six 6-12 minutes late."""
    h = (template_id * 2654435761 + day.toordinal() * 40503) % 1000
    return 6 + h % 7 if h % 6 == 0 else h % 5


def compliant_vehicle(v: Vehicle, day: dt.date) -> list[str]:
    return [k for k, d in v.documents().items() if d < day] + (["in maintenance"] if v.status != "active" else [])


def compliant_driver(d: Driver, day: dt.date) -> list[str]:
    problems = []
    if d.licence_valid_to < day:
        problems.append("licence")
    if not d.psv_badge:
        problems.append("PSV badge")
    if not d.police_verified:
        problems.append("police verification")
    if d.status != "active":
        problems.append("on leave")
    return problems


def _solve(plans: list[Plan], vehicles: list[Vehicle]) -> dict[int, int | None]:
    s = get_settings()
    turn = dt.timedelta(minutes=s.turnaround_min)

    def fits(i: Plan, j: Plan) -> bool:  # can one vehicle do i then j?
        mins, _ = deadhead(i.end_pt, j.start_pt)
        return i.end + dt.timedelta(minutes=mins) + turn <= j.start

    m = cp_model.CpModel()
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    for i, p in enumerate(plans):
        for v in vehicles:
            if v.vehicle_class.seats >= p.required and (v.vehicle_class.ac or not p.template.ac_required):
                x[i, v.id] = m.new_bool_var(f"x{i}_{v.id}")
    un = {i: m.new_bool_var(f"u{i}") for i in range(len(plans))}
    for i in range(len(plans)):
        m.add(sum(x[i, v.id] for v in vehicles if (i, v.id) in x) + un[i] == 1)
    conflict = [(i, j) for i in range(len(plans)) for j in range(i + 1, len(plans))
                if not fits(plans[i], plans[j]) and not fits(plans[j], plans[i])]
    used = {v.id: m.new_bool_var(f"used{v.id}") for v in vehicles}
    cost = []
    for v in vehicles:
        for i, j in conflict:
            if (i, v.id) in x and (j, v.id) in x:
                m.add_bool_or([x[i, v.id].Not(), x[j, v.id].Not()])
        for i, p in enumerate(plans):
            if (i, v.id) in x:
                m.add_implication(x[i, v.id], used[v.id])
                empty_seats = v.vehicle_class.seats - p.required
                depot_km = road_km((v.depot_lat, v.depot_lon), p.start_pt)
                cost.append(x[i, v.id] * int(empty_seats * OVERSIZE_COST + depot_km * v.vehicle_class.km_cost))
        cost.append(used[v.id] * v.vehicle_class.day_cost)
    cost += [un[i] * UNASSIGNED_COST for i in un]
    m.minimize(sum(cost))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = s.solver_seconds
    solver.parameters.num_workers = 8
    status = solver.solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {i: None for i in range(len(plans))}
    return {i: next((vid for (k, vid), var in x.items() if k == i and solver.value(var)), None) for i in range(len(plans))}


def _build_duties(db: Session, day: dt.date, plans: list[Plan], drivers: list[Driver]) -> list[Duty]:
    s = get_settings()
    by_vehicle: dict[int, list[Plan]] = {}
    for p in plans:
        if p.vehicle:
            by_vehicle.setdefault(p.vehicle.id, []).append(p)
    blocks: list[tuple[Vehicle, str, list[Plan]]] = []
    for vid, ps in by_vehicle.items():
        ps.sort(key=lambda p: p.start)
        v = ps[0].vehicle
        full = _measure(v, ps)
        if (full["spread"] > s.max_spread_min or full["worked"] > s.max_worked_min) and len(ps) > 1:
            gaps = [(ps[k + 1].start - ps[k].end, k) for k in range(len(ps) - 1)]
            _, k = max(gaps)
            blocks += [(v, "AM", ps[:k + 1]), (v, "PM", ps[k + 1:])]
        else:
            blocks.append((v, "FULL", ps))
    free = list(drivers)
    duties = []
    for v, block, ps in sorted(blocks, key=lambda b: b[2][0].start):
        meas = _measure(v, ps)
        cand = [d for d in free if d.operator_id == v.operator_id]
        drv = min(cand, key=lambda d: haversine_km((d.base_lat, d.base_lon), (v.depot_lat, v.depot_lon))) if cand else None
        if drv:
            free.remove(drv)
        duty = Duty(service_date=day, vehicle_id=v.id, driver_id=drv.id if drv else None, block=block,
                    report_at=meas["report"], sign_off_at=meas["sign_off"], worked_min=meas["worked"],
                    spread_min=meas["spread"], deadhead_km=round(meas["dh_km"], 1))
        duty.items = meas["items"]
        db.add(duty)
        duties.append(duty)
    return duties


def _measure(v: Vehicle, ps: list[Plan]) -> dict:
    s = get_settings()
    depot = (v.depot_lat, v.depot_lon)
    items: list[DutyItem] = []
    dh_min, dh_km = deadhead(depot, ps[0].start_pt)
    first_dep = ps[0].start - dt.timedelta(minutes=dh_min)
    report = first_dep - dt.timedelta(minutes=s.pretrip_check_min)
    items.append(DutyItem(seq=0, kind="check", start_at=report, end_at=first_dep))
    if dh_km > 0.2:
        items.append(DutyItem(seq=1, kind="deadhead", start_at=first_dep, end_at=ps[0].start, km=round(dh_km, 1)))
    total_dh, idle = dh_km, 0.0
    for k, p in enumerate(ps):
        items.append(DutyItem(seq=len(items), kind="trip", trip=p.trip, start_at=p.start, end_at=p.end))
        if k + 1 < len(ps):
            nxt = ps[k + 1]
            m, km = deadhead(p.end_pt, nxt.start_pt)
            if km > 0.2:
                items.append(DutyItem(seq=len(items), kind="deadhead", start_at=p.end, end_at=p.end + dt.timedelta(minutes=m), km=round(km, 1)))
            gap = (nxt.start - p.end).total_seconds() / 60 - m
            if gap >= 30:
                items.append(DutyItem(seq=len(items), kind="break", start_at=p.end + dt.timedelta(minutes=m), end_at=nxt.start))
                idle += gap
            total_dh += km
    m, km = deadhead(ps[-1].end_pt, depot)
    sign_off = ps[-1].end + dt.timedelta(minutes=m)
    if km > 0.2:
        items.append(DutyItem(seq=len(items), kind="deadhead", start_at=ps[-1].end, end_at=sign_off, km=round(km, 1)))
    total_dh += km
    spread = (sign_off - report).total_seconds() / 60
    return {"items": items, "report": report, "sign_off": sign_off, "spread": round(spread),
            "worked": round(spread - idle), "dh_km": total_dh}


def allocate(db: Session, day: dt.date, user_id: int | None = None, force: bool = False) -> dict:
    """force=True replays a day whose trips already ran (demo servers only, e.g. after moving the demo clock back)."""
    s = get_settings()
    trips_today = db.execute(select(Trip).where(Trip.service_date == day)).scalars().all()
    if force and not s.is_dev:
        raise HTTPException(403, "Replaying a day is only possible on demo servers.")
    if not force and any(t.status in ("in_progress", "completed") for t in trips_today):
        raise HTTPException(409, "Trips on this day have already started; reassign individual trips instead.")
    if force and trips_today:
        db.execute(delete(VehiclePosition).where(VehiclePosition.trip_id.in_([t.id for t in trips_today])))
    db.execute(delete(Duty).where(Duty.service_date == day))
    db.execute(delete(Trip).where(Trip.service_date == day))
    db.flush()

    templates = db.execute(select(TripTemplate).join(Route).where(TripTemplate.active.is_(True), Route.status == "live")
                           .options(selectinload(TripTemplate.route).selectinload(Route.stops))).scalars().all()
    templates = [t for t in templates if runs_on(t.days_mask, day)]
    subs = db.execute(select(Subscription).where(Subscription.status == "active", Subscription.valid_from <= day,
                                                 Subscription.valid_to >= day)).scalars().all()
    subs = [x for x in subs if runs_on(x.days_mask, day)]
    skipped = {(k.subscription_id, k.leg) for k in db.execute(select(Skip).where(Skip.service_date == day)).scalars()}
    classes = sorted(db.execute(select(VehicleClass)).scalars().all(), key=lambda c: (c.seats, not c.ac))

    plans, cancelled = [], []
    for t in templates:
        st = t.route.stops
        start = clock.at_local(day, t.start_time)
        p = Plan(template=t, start=start, end=start + dt.timedelta(minutes=st[-1].offset_min),
                 start_pt=stop_point(st[0].stop), end_pt=stop_point(st[-1].stop))
        for sub in subs:
            if sub.am_template_id == t.id and (sub.id, "AM") not in skipped:
                p.riders.append((sub, "AM"))
            if sub.pm_template_id == t.id and (sub.id, "PM") not in skipped:
                p.riders.append((sub, "PM"))
        n = len(p.riders)
        if n == 0:
            cancelled.append(p)
            continue
        p.required = max(n, min(n + math.ceil(n * s.allocation_buffer_pct / 100), t.vehicle_class.seats))
        fitting = [c for c in classes if c.seats >= p.required and (c.ac or not t.ac_required)]
        p.vclass = fitting[0] if fitting else classes[-1]
        p.overflow = not fitting
        plans.append(p)

    all_vehicles = db.execute(select(Vehicle)).scalars().all()
    blocked = {v.reg_no: compliant_vehicle(v, day) for v in all_vehicles if compliant_vehicle(v, day)}
    vehicles = [v for v in all_vehicles if v.reg_no not in blocked]
    assignment = _solve(plans, vehicles) if plans else {}
    vmap = {v.id: v for v in vehicles}

    for i, p in enumerate(plans):
        vid = assignment.get(i)
        p.vehicle = vmap.get(vid) if vid else None
        if p.vehicle:
            p.vclass = p.vehicle.vehicle_class   # the class actually running (may be larger than required)
        p.trip = Trip(template_id=p.template.id, route_id=p.template.route_id, service_date=day, planned_start=p.start,
                      planned_end=p.end, vehicle_class_id=p.vclass.id, vehicle_id=vid, booked=len(p.riders),
                      sim_delay_min=sim_delay(p.template.id, day))
        db.add(p.trip)
        db.flush()
        for sub, leg in p.riders:
            pick, drop = (sub.am_pickup_stop_id, sub.am_drop_stop_id) if leg == "AM" else (sub.pm_pickup_stop_id, sub.pm_drop_stop_id)
            db.add(Booking(trip_id=p.trip.id, rider_id=sub.rider_id, subscription_id=sub.id, leg=leg,
                           pickup_stop_id=pick, drop_stop_id=drop, boarding_code=boarding_code()))
    for p in cancelled:
        db.add(Trip(template_id=p.template.id, route_id=p.template.route_id, service_date=day, planned_start=p.start,
                    planned_end=p.end, vehicle_class_id=p.template.vehicle_class_id, status="cancelled", booked=0))

    all_drivers = db.execute(select(Driver)).scalars().all()
    blocked_drivers = {d.id: compliant_driver(d, day) for d in all_drivers if compliant_driver(d, day)}
    duties = _build_duties(db, day, plans, [d for d in all_drivers if d.id not in blocked_drivers])
    db.flush()

    seats = sum(p.vclass.seats for p in plans if p.vehicle)
    booked = sum(len(p.riders) for p in plans)
    summary = {
        "date": day.isoformat(),
        "departures_running": len(plans), "departures_cancelled_no_bookings": len(cancelled),
        "bookings": booked, "seats_offered": seats, "load_factor_pct": round(100 * booked / seats) if seats else 0,
        "downsized": sum(1 for p in plans if p.vehicle and p.vclass.seats < p.template.vehicle_class.seats),
        "vehicles_used": len({p.vehicle.id for p in plans if p.vehicle}), "fleet_size": len(all_vehicles),
        "vehicles_blocked": blocked,
        "drivers_blocked": {f"{d.user.name} (#{d.id})": blocked_drivers[d.id] for d in all_drivers if d.id in blocked_drivers},
        "unassigned_departures": [p.template.route.code + " " + p.template.start_time.strftime("%H:%M") for p in plans if not p.vehicle],
        "overflow_departures": [p.template.route.code for p in plans if p.overflow],
        "duties": len(duties), "split_duties": sum(1 for d in duties if d.block != "FULL") // 2,
        "duties_without_driver": sum(1 for d in duties if d.driver_id is None),
        "deadhead_km": round(sum(d.deadhead_km for d in duties), 1),
    }
    db.add(AuditLog(user_id=user_id, action="allocate", detail=summary))
    db.commit()
    return summary
