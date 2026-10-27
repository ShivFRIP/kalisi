"""Settings, read from environment variables prefixed KALISI_ (or a .env file).

Every number that is a policy choice rather than a technical one is here, with a comment,
so it can be reviewed and changed without touching code.
"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


DEV_JWT_SECRET = "dev-only-secret-do-not-use-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KALISI_", env_file=".env", extra="ignore")

    # --- runtime -------------------------------------------------------------------------
    env: str = "dev"                         # dev | prod. In dev, OTP codes are returned in the API response.
    database_url: str = "postgresql+psycopg://kalisi:kalisi@localhost:5432/kalisi"
    jwt_secret: str = DEV_JWT_SECRET            # refused when env=prod
    jwt_days: int = 30
    timezone: str = "Asia/Kolkata"
    cors_origins: str = "http://localhost:5173"   # comma-separated
    background_jobs: bool = True             # simulator + scheduled allocation loop
    osrm_url: str = ""                       # e.g. http://osrm:5000 ; empty = straight-line estimates

    # --- travel-time assumptions (used when no routing engine is configured) --------------
    road_factor: float = 1.35                # road distance / straight-line distance
    peak_speed_kmh: float = 24.0             # same assumption as the policymaker demo
    offpeak_speed_kmh: float = 28.0          # for empty runs between trips
    path_road_factor: float = 1.22           # along a route's stop sequence (stops already follow the corridor)
    walk_factor: float = 1.25                # walking distance / straight-line distance
    dwell_min_per_stop: float = 1.5

    # --- matching policy ------------------------------------------------------------------
    max_walk_m_default: int = 800
    office_walk_m: int = 1000
    early_arrival_tolerance_min: int = 20    # an option may arrive up to this much before the window
    late_departure_tolerance_min: int = 15   # evening option may leave up to this much after the window
    detour_alpha: float = 1.6                # in-vehicle time <= min(alpha x direct, direct + beta)
    detour_beta_min: int = 25
    k_anonymity: int = 5                     # counts shown to riders only when >= k

    # --- daily rhythm ---------------------------------------------------------------------
    skip_cutoff: str = "20:00"               # D-1 local time; skips before this earn a credit
    skip_credit_pct: int = 100               # % of the leg's per-ride fare credited for an on-time skip
    late_skip_min_before_departure: int = 30 # after the cut-off, skips allowed until this many minutes before pickup
    allocation_buffer_pct: int = 10          # seats kept spare above bookings when right-sizing

    # --- vehicle and driver duties (policy parameters: set from labour law and operator contracts)
    turnaround_min: int = 10
    pretrip_check_min: int = 20
    max_spread_min: int = 720                # 12-hour spread-over cap (design doc section 7)
    max_worked_min: int = 480                # 8 hours worked
    solver_seconds: float = 10.0

    # --- planner ---------------------------------------------------------------------------
    planner_min_group: int = 6               # pooled riders needed before a route is proposed
    planner_max_ride_min: int = 75
    planner_target_load_pct: int = 60        # proposals below this load are flagged as not viable

    @property
    def is_dev(self) -> bool:
        return self.env == "dev"


@lru_cache
def get_settings() -> Settings:
    return Settings()
