"""Fares. The per-ride formula and the monthly discount are the ones used in the policymaker demo,
so the prototype and the demo quote the same prices. They are placeholders for a pricing study, not proposals.
"""
import math


def _round10(x: float) -> int:
    return int(math.floor(x / 10 + 0.5)) * 10  # JavaScript Math.round semantics


def ride_fare(road_km: float) -> int:
    """Rs per ride: Rs 45 + Rs 4/km, rounded to a price ending in 9, minimum Rs 49."""
    return max(49, _round10(45 + 4 * road_km) - 1)


def express_fare(fare: int) -> int:
    """Express (limited-stop) rides cost 30% more, as in the demo."""
    return _round10(fare * 1.3) - 1


def pass_price(am_fare: int, pm_fare: int | None, product: str) -> int:
    """Rs for a pass. Monthly: 20 office days at 28% off. Weekly: 5 days at 15% off (weekly is an assumption)."""
    per_day = am_fare + (pm_fare or 0)
    if product == "monthly":
        return _round10(per_day * 20 * 0.72) - 1
    if product == "weekly":
        return _round10(per_day * 5 * 0.85) - 1
    raise ValueError(f"unknown product {product}")


PRODUCT_DAYS = {"monthly": 30, "weekly": 7}
