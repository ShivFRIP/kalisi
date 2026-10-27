"""Distances, travel times and H3 cells.

Without a routing engine, travel times are straight-line distance x a road factor / an assumed speed, the same
assumptions as the policymaker demo. Set KALISI_OSRM_URL to use a self-hosted OSRM server for the planner's
travel-time matrices instead (OSRM `table` service). The OSRM path has not been tested against a live server.
"""
import logging
import math

import h3
import httpx

from .config import get_settings

log = logging.getLogger(__name__)
Point = tuple[float, float]  # (lat, lon)


def haversine_km(a: Point, b: Point) -> float:
    r = math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    s = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(s))


def walk_m(a: Point, b: Point) -> int:
    return round(haversine_km(a, b) * 1000 * get_settings().walk_factor)


def road_km(a: Point, b: Point) -> float:
    return haversine_km(a, b) * get_settings().road_factor


def drive_min(a: Point, b: Point, peak: bool = True) -> float:
    s = get_settings()
    return road_km(a, b) / (s.peak_speed_kmh if peak else s.offpeak_speed_kmh) * 60


def path_km(points: list[Point]) -> float:
    """Road distance along a sequence of stops. Stops already follow the corridor, so the factor is smaller."""
    return sum(haversine_km(points[i], points[i + 1]) for i in range(len(points) - 1)) * get_settings().path_road_factor


def cell(lat: float, lon: float, res: int = 9) -> str:
    return h3.latlng_to_cell(lat, lon, res)


def parent(c: str, res: int) -> str:
    return h3.cell_to_parent(c, res)


def cell_boundary(c: str) -> list[list[float]]:
    return [[lat, lon] for lat, lon in h3.cell_to_boundary(c)]


def cell_center(c: str) -> Point:
    return h3.cell_to_latlng(c)


def bearing(a: Point, b: Point) -> float:
    r = math.pi / 180
    y = math.sin((b[1] - a[1]) * r) * math.cos(b[0] * r)
    x = math.cos(a[0] * r) * math.sin(b[0] * r) - math.sin(a[0] * r) * math.cos(b[0] * r) * math.cos((b[1] - a[1]) * r)
    return (math.atan2(y, x) / r + 360) % 360


def matrix(points: list[Point], peak: bool = True) -> tuple[list[list[float]], list[list[float]]]:
    """(minutes, km) between every pair of points."""
    s = get_settings()
    if s.osrm_url and len(points) > 1:
        try:
            coords = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
            r = httpx.get(f"{s.osrm_url.rstrip('/')}/table/v1/driving/{coords}",
                          params={"annotations": "duration,distance"}, timeout=20)
            r.raise_for_status()
            j = r.json()
            mins = [[(d or 0) / 60 for d in row] for row in j["durations"]]
            kms = [[(d or 0) / 1000 for d in row] for row in j["distances"]]
            return mins, kms
        except Exception as e:  # fall back rather than fail a planning run
            log.warning("OSRM table failed (%s); using straight-line estimates", e)
    kms = [[road_km(a, b) for b in points] for a in points]
    speed = s.peak_speed_kmh if peak else s.offpeak_speed_kmh
    return [[k / speed * 60 for k in row] for row in kms], kms
