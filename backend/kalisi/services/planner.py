"""Route proposals from the demand pool (design doc sections 4.2 step 7 and 6.2).

Riders the current network can't serve are 'pooled'. The planner groups them by office cluster x 30-minute
arrival bucket. Within a group, pickups are sited by greedy maximal covering: each stop covers as many riders as
possible within their own walking limit, preferring existing stops; new stops are marked 'proposed' and need a
field audit before use.
OR-Tools then solves an open vehicle-routing problem: routes start at any pickup and end at the office, with
vehicle capacities (heterogeneous AC fleet), a fixed cost per vehicle and a maximum ride time.
Proposals are not live until an ops user publishes them.
"""
from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

from fastapi import HTTPException
from geoalchemy2 import Geography
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
from sqlalchemy import cast, delete, exists, func, select
from sqlalchemy.orm import Session

from .. import clock
from ..config import get_settings
from ..geo import Point, cell, haversine_km, matrix, walk_m
from ..models import AuditLog, Campus, CommuteIntent, Route, RouteStop, Stop, TripTemplate, VehicleClass
from .common import from_minutes, minutes
from .matching import options_for_intent

PLACES = json.loads((Path(__file__).parent.parent / "data" / "hyderabad.json").read_text())
_NAMES = [(n, tuple(p)) for n, p in PLACES["localities"].items()] + \
         [(s["name"] + " Metro", tuple(s["point"])) for line in PLACES["metro"].values() for s in line]
RS_PER_VEHICLE_MIN = 12   # operating cost of a vehicle-minute (assumption), to compare time with fixed costs


def place_name(p: Point) -> str:
    name, q = min(_NAMES, key=lambda x: haversine_km(p, x[1]))
    return name if haversine_km(p, q) < 3 else "Hyderabad"


def campus_stop(db: Session, campus: Campus) -> Stop:
    s = db.scalar(select(Stop).where(Stop.kind == "campus", Stop.name == campus.name))
    if s is None:
        s = Stop(name=campus.name, lat=campus.lat, lon=campus.lon, h3_r9=cell(campus.lat, campus.lon), kind="campus", audited=False)
        db.add(s)
        db.flush()
    return s


def _site_stops(db: Session, members: list[CommuteIntent]) -> list[dict]:
    """Greedy maximal covering (design doc 6.1): pick the stop that covers the most riders within their own
    walking limit, prefer existing stops, repeat until everyone is covered."""
    def walks(m: CommuteIntent, p: Point) -> bool:
        return walk_m((m.home_lat, m.home_lon), p) <= m.max_walk_m
    lat0, lon0 = statistics.fmean(m.home_lat for m in members), statistics.fmean(m.home_lon for m in members)
    here = cast(func.ST_SetSRID(func.ST_MakePoint(lon0, lat0), 4326), Geography)
    existing = db.execute(select(Stop).where(Stop.active.is_(True), Stop.kind != "campus",
                                             func.ST_DWithin(Stop.geom, here, 8000))).scalars().all()
    cands = [("stop", s_, (s_.lat, s_.lon)) for s_ in existing] + [("home", m, (m.home_lat, m.home_lon)) for m in members]
    left, out = set(range(len(members))), []
    while left:
        def gain(c):
            return sum(1 for i in left if walks(members[i], c[2])) + (0.5 if c[0] == "stop" else 0)
        best = max(cands, key=gain)
        covered = {i for i in left if walks(members[i], best[2])}
        if best[0] == "stop":
            stop = best[1]
        else:
            c = (statistics.fmean(members[i].home_lat for i in covered), statistics.fmean(members[i].home_lon for i in covered))
            if not all(walks(members[i], c) for i in covered):
                c = best[2]
            area = place_name(c)
            taken = {x.name for x in db.execute(select(Stop).where(Stop.name.like(area + "%"))).scalars()}
            name = next(n for n in [f"{area} (proposed)"] + [f"{area} {k} (proposed)" for k in range(2, 99)] if n not in taken)
            stop = Stop(name=name, lat=round(c[0], 5), lon=round(c[1], 5), h3_r9=cell(*c), kind="proposed", audited=False)
            db.add(stop)
            db.flush()
        prev = next((n for n in out if n["stop"].id == stop.id), None)
        if prev:
            prev["members"].extend(members[i] for i in covered)
        else:
            out.append({"stop": stop, "members": [members[i] for i in covered]})
        left -= covered
    return out


def _clear_old_proposals(db: Session) -> None:
    db.execute(delete(Route).where(Route.status == "proposed"))
    db.flush()
    used = exists().where(RouteStop.stop_id == Stop.id)
    db.execute(delete(Stop).where(Stop.kind == "proposed", ~used))
    db.flush()


def _offsets(T: list[list[float]], seq: list[int], dwell: float) -> list[int]:
    out, t = [0], 0.0
    for a, b in zip(seq, seq[1:]):
        t += T[a][b] + dwell
        out.append(round(t))
    return out


def _majority_days(members: list[CommuteIntent]) -> int:
    mask = 0
    for d in range(7):
        if sum(1 for m in members if m.days_mask & (1 << d)) * 2 >= len(members):
            mask |= 1 << d
    return mask or 0b0011111


def run_planner(db: Session, user_id: int | None = None) -> dict:
    s = get_settings()
    _clear_old_proposals(db)
    pooled = db.execute(select(CommuteIntent).where(CommuteIntent.status == "pooled", CommuteIntent.campus_id.is_not(None))).scalars().all()
    groups: dict[tuple[int, int], list[CommuteIntent]] = defaultdict(list)
    for it in pooled:
        groups[(it.campus_id, minutes(it.am_from) // 30 * 30)].append(it)
    classes = sorted([c for c in db.execute(select(VehicleClass)).scalars() if c.ac], key=lambda c: c.seats)
    proposals, small, unserved = [], [], 0

    for (cid, bucket), members in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        campus = db.get(Campus, cid)
        if len(members) < s.planner_min_group:
            small.append({"campus": campus.name, "arrive": from_minutes(bucket).strftime("%H:%M"), "riders": len(members)})
            continue
        nodes = _site_stops(db, members)
        pick = nodes
        dest = campus_stop(db, campus)
        pts = [(p["stop"].lat, p["stop"].lon) for p in pick] + [(dest.lat, dest.lon)]
        mins, _ = matrix(pts, peak=True)
        n = len(pick)
        N = n + 2                      # 0 = virtual start, 1..n pickups, n+1 = office
        def T(a: int, b: int) -> int:
            if a == 0 or a == b:
                return 0
            if b == 0:
                return 10**6
            return int(10 * (mins[a - 1][b - 1] + (s.dwell_min_per_stop if b <= n else 0)))
        total = sum(len(p["members"]) for p in pick)
        fleet = [c for c in classes for _ in range(max(1, min(4, math.ceil(total / c.seats))))]
        mgr = pywrapcp.RoutingIndexManager(N, len(fleet), [0] * len(fleet), [N - 1] * len(fleet))
        rt = pywrapcp.RoutingModel(mgr)
        cb = rt.RegisterTransitCallback(lambda i, j: T(mgr.IndexToNode(i), mgr.IndexToNode(j)))
        rt.SetArcCostEvaluatorOfAllVehicles(cb)
        for v, c in enumerate(fleet):
            rt.SetFixedCostOfVehicle(int(c.day_cost / RS_PER_VEHICLE_MIN * 10), v)
        dem = rt.RegisterUnaryTransitCallback(lambda i: len(pick[mgr.IndexToNode(i) - 1]["members"]) if 1 <= mgr.IndexToNode(i) <= n else 0)
        rt.AddDimensionWithVehicleCapacity(dem, 0, [c.seats for c in fleet], True, "Load")
        rt.AddDimension(cb, 0, s.planner_max_ride_min * 10, True, "Time")
        for k in range(1, n + 1):
            rt.AddDisjunction([mgr.NodeToIndex(k)], 10**7)
        prm = pywrapcp.DefaultRoutingSearchParameters()
        prm.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
        prm.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        prm.time_limit.FromSeconds(3)
        sol = rt.SolveWithParameters(prm)
        if sol is None:
            unserved += total
            continue
        served = 0
        for v, vc in enumerate(fleet):
            idx, seq = rt.Start(v), []
            while not rt.IsEnd(idx):
                node = mgr.IndexToNode(idx)
                if 1 <= node <= n:
                    seq.append(node - 1)
                idx = sol.Value(rt.NextVar(idx))
            if not seq:
                continue
            riders = [m for k in seq for m in pick[k]["members"]]
            served += len(riders)
            order = seq + [n]          # matrix indices: pickups then office
            offs = _offsets(mins, order, s.dwell_min_per_stop)
            offs[-1] = offs[-1] - round(s.dwell_min_per_stop)  # no dwell counted at the final stop
            arrive = bucket + 15
            k = sum(1 for p in proposals if p["campus"] == campus.name) + 1
            code = f"P{campus.code[:3].upper()}{bucket // 60:02d}{bucket % 60:02d}{k}"
            first = pick[seq[0]]["stop"].name.replace(" (proposed)", "")
            load = round(100 * len(riders) / vc.seats)
            r = Route(code=code, name=f"{first} → {campus.name}", direction="AM", campus_id=cid, status="proposed",
                      notes=f"Proposed {clock.today(db)} for {len(riders)} pooled riders; projected load {load}% on a {vc.name}.")
            r.stops = [RouteStop(seq=i, stop_id=(pick[k2]["stop"].id if k2 < n else dest.id), offset_min=offs[i],
                                 action="pickup" if k2 < n else "drop") for i, k2 in enumerate(order)]
            days = _majority_days(riders)
            r.templates = [TripTemplate(start_time=from_minutes(arrive - offs[-1]), days_mask=days, vehicle_class_id=vc.id, ac_required=True)]
            db.add(r)
            pm_riders = [m for m in riders if m.pm_from]
            rev = None
            if pm_riders:
                rorder = [n] + list(reversed(seq))
                roffs = _offsets(mins, rorder, s.dwell_min_per_stop)
                depart = round(statistics.median(minutes(m.pm_from) for m in pm_riders)) + 10
                rev = Route(code=code + "R", name=f"{campus.name} → {first}", direction="PM", campus_id=cid, status="proposed",
                            notes=f"Evening return for {code}.")
                rev.stops = [RouteStop(seq=i, stop_id=(pick[k2]["stop"].id if k2 < n else dest.id), offset_min=roffs[i],
                                       action="drop" if k2 < n else "pickup") for i, k2 in enumerate(rorder)]
                rev.templates = [TripTemplate(start_time=from_minutes(depart), days_mask=days, vehicle_class_id=vc.id, ac_required=True)]
                db.add(rev)
            proposals.append({"code": code, "return_code": rev.code if rev else None, "campus": campus.name, "name": r.name,
                              "arrive": from_minutes(arrive).strftime("%H:%M"), "riders": len(riders), "vehicle": vc.name,
                              "seats": vc.seats, "load_pct": load, "viable": load >= s.planner_target_load_pct,
                              "ride_min": offs[-1], "stops": [pick[k2]["stop"].name if k2 < n else dest.name for k2 in order]})
        unserved += total - served
    result = {"pooled_riders": len(pooled), "groups": len(groups), "proposals": proposals, "groups_too_small": small,
              "unserved_riders": unserved}
    db.add(AuditLog(user_id=user_id, action="planner_run", detail={"proposals": len(proposals), "pooled": len(pooled)}))
    db.commit()
    return result


def publish(db: Session, route_id: int, user_id: int | None = None) -> dict:
    r = db.get(Route, route_id)
    if r is None or r.status != "proposed":
        raise HTTPException(404, "No proposed route with that id")
    published = [r]
    rev = db.scalar(select(Route).where(Route.code == r.code + "R", Route.status == "proposed"))
    if rev:
        published.append(rev)
    for x in published:
        x.status = "live"
    db.flush()
    matched = rematch_pooled(db)
    db.add(AuditLog(user_id=user_id, action="publish_route", detail={"routes": [x.code for x in published], "riders_matched": matched}))
    db.commit()
    return {"published": [x.code for x in published], "pooled_riders_now_matched": matched}


def rematch_pooled(db: Session) -> int:
    today = clock.today(db)
    n = 0
    for it in db.execute(select(CommuteIntent).where(CommuteIntent.status == "pooled")).scalars():
        am, _ = options_for_intent(db, it, today, limit=1)
        if am:
            it.status = "matched"
            n += 1
    return n

