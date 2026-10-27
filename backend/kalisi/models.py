"""Database tables. Follows section 5.2 of the architecture document, trimmed to what the prototype uses.

Conventions:
- Points are stored as lat/lon columns plus a generated PostGIS geography column (`geom`) for spatial queries.
- Money is integer paise. Times of day are local (Asia/Kolkata); instants are timestamptz (UTC).
- Weekday masks: bit 0 = Monday ... bit 6 = Sunday.
"""
from __future__ import annotations

import datetime as dt

from geoalchemy2 import Geography
from sqlalchemy import (ARRAY, JSON, BigInteger, Boolean, CheckConstraint, Computed, Date, DateTime, Float,
                        ForeignKey, Index, Integer, String, Text, Time, UniqueConstraint, func)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

GEOM_EXPR = "(ST_SetSRID(ST_MakePoint(lon, lat), 4326))::geography"


def _geom():
    return mapped_column(Geography("POINT", 4326, spatial_index=False), Computed(GEOM_EXPR, persisted=True))


def _now():
    return mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------------------------
# People and access
# ---------------------------------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    phone: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(80), default="")
    role: Mapped[str] = mapped_column(String(10), default="rider")  # rider | driver | ops
    consent_version: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[dt.datetime] = _now()
    __table_args__ = (CheckConstraint("role in ('rider','driver','ops')", name="ck_user_role"),)


class OtpCode(Base):
    __tablename__ = "otp_codes"
    id: Mapped[int] = mapped_column(primary_key=True)
    phone: Mapped[str] = mapped_column(String(16), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = _now()


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(60))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = _now()


# ---------------------------------------------------------------------------------------------
# Network: campuses, stops, routes, timetables
# ---------------------------------------------------------------------------------------------
class Campus(Base):
    """An office cluster riders travel to (e.g. Financial District)."""
    __tablename__ = "campuses"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    geom = _geom()


class Stop(Base):
    __tablename__ = "stops"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    geom = _geom()
    h3_r9: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(12), default="landmark")  # landmark | metro | campus | proposed
    audited: Mapped[bool] = mapped_column(Boolean, default=False)     # field safety audit done (lighting, footpath, bay)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    __table_args__ = (Index("ix_stops_geom", "geom", postgresql_using="gist"),)


class Route(Base):
    __tablename__ = "routes"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    direction: Mapped[str] = mapped_column(String(8))           # AM (to office) | PM (home) | FEEDER (short loop)
    campus_id: Mapped[int | None] = mapped_column(ForeignKey("campuses.id"))
    status: Mapped[str] = mapped_column(String(10), default="proposed")  # proposed | live | retired
    express: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = _now()
    stops: Mapped[list[RouteStop]] = relationship(order_by="RouteStop.seq", cascade="all, delete-orphan")
    templates: Mapped[list[TripTemplate]] = relationship(back_populates="route", cascade="all, delete-orphan")
    campus: Mapped[Campus | None] = relationship()


class RouteStop(Base):
    __tablename__ = "route_stops"
    id: Mapped[int] = mapped_column(primary_key=True)
    route_id: Mapped[int] = mapped_column(ForeignKey("routes.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    stop_id: Mapped[int] = mapped_column(ForeignKey("stops.id"))
    offset_min: Mapped[int] = mapped_column(Integer)            # minutes after the trip's first stop
    action: Mapped[str] = mapped_column(String(8), default="both")  # pickup | drop | both
    stop: Mapped[Stop] = relationship(lazy="joined")
    __table_args__ = (UniqueConstraint("route_id", "seq"),)


class VehicleClass(Base):
    __tablename__ = "vehicle_classes"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(60))
    seats: Mapped[int] = mapped_column(Integer)
    ac: Mapped[bool] = mapped_column(Boolean)
    day_cost: Mapped[int] = mapped_column(Integer)              # Rs per vehicle-day, for the optimiser (assumption)
    km_cost: Mapped[int] = mapped_column(Integer)               # Rs per km (assumption)


class TripTemplate(Base):
    """A timetabled departure of a route on given weekdays."""
    __tablename__ = "trip_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    route_id: Mapped[int] = mapped_column(ForeignKey("routes.id", ondelete="CASCADE"))
    start_time: Mapped[dt.time] = mapped_column(Time)
    days_mask: Mapped[int] = mapped_column(Integer, default=0b0011111)
    vehicle_class_id: Mapped[int] = mapped_column(ForeignKey("vehicle_classes.id"))  # planned class: sets seats sold
    ac_required: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    route: Mapped[Route] = relationship(back_populates="templates")
    vehicle_class: Mapped[VehicleClass] = relationship(lazy="joined")


# ---------------------------------------------------------------------------------------------
# Supply: operators, vehicles, drivers
# ---------------------------------------------------------------------------------------------
class Operator(Base):
    __tablename__ = "operators"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))


class Vehicle(Base):
    __tablename__ = "vehicles"
    id: Mapped[int] = mapped_column(primary_key=True)
    operator_id: Mapped[int] = mapped_column(ForeignKey("operators.id"))
    reg_no: Mapped[str] = mapped_column(String(20), unique=True)
    class_id: Mapped[int] = mapped_column(ForeignKey("vehicle_classes.id"))
    depot_name: Mapped[str] = mapped_column(String(60), default="")
    depot_lat: Mapped[float] = mapped_column(Float)
    depot_lon: Mapped[float] = mapped_column(Float)
    permit_valid_to: Mapped[dt.date] = mapped_column(Date)
    fitness_valid_to: Mapped[dt.date] = mapped_column(Date)
    insurance_valid_to: Mapped[dt.date] = mapped_column(Date)
    puc_valid_to: Mapped[dt.date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(12), default="active")  # active | maintenance
    vehicle_class: Mapped[VehicleClass] = relationship(lazy="joined")
    operator: Mapped[Operator] = relationship(lazy="joined")

    def documents(self) -> dict[str, dt.date]:
        return {"permit": self.permit_valid_to, "fitness": self.fitness_valid_to,
                "insurance": self.insurance_valid_to, "pollution": self.puc_valid_to}


class Driver(Base):
    __tablename__ = "drivers"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    operator_id: Mapped[int] = mapped_column(ForeignKey("operators.id"))
    licence_valid_to: Mapped[dt.date] = mapped_column(Date)
    psv_badge: Mapped[bool] = mapped_column(Boolean, default=True)
    police_verified: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | leave
    base_lat: Mapped[float] = mapped_column(Float)
    base_lon: Mapped[float] = mapped_column(Float)
    user: Mapped[User] = relationship(lazy="joined")


# ---------------------------------------------------------------------------------------------
# Demand: what riders want, and what they bought
# ---------------------------------------------------------------------------------------------
class CommuteIntent(Base):
    __tablename__ = "commute_intents"
    id: Mapped[int] = mapped_column(primary_key=True)
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    home_lat: Mapped[float] = mapped_column(Float)
    home_lon: Mapped[float] = mapped_column(Float)
    home_label: Mapped[str] = mapped_column(String(120), default="")
    home_h3_r9: Mapped[str] = mapped_column(String(16), index=True)
    office_lat: Mapped[float] = mapped_column(Float)
    office_lon: Mapped[float] = mapped_column(Float)
    office_label: Mapped[str] = mapped_column(String(120), default="")
    campus_id: Mapped[int | None] = mapped_column(ForeignKey("campuses.id"))
    am_from: Mapped[dt.time] = mapped_column(Time)
    am_to: Mapped[dt.time] = mapped_column(Time)
    pm_from: Mapped[dt.time | None] = mapped_column(Time)
    pm_to: Mapped[dt.time | None] = mapped_column(Time)
    days_mask: Mapped[int] = mapped_column(Integer, default=0b0011111)
    ac_only: Mapped[bool] = mapped_column(Boolean, default=True)
    max_walk_m: Mapped[int] = mapped_column(Integer, default=800)
    status: Mapped[str] = mapped_column(String(12), default="pooled")  # pooled | matched | subscribed | paused
    created_at: Mapped[dt.datetime] = _now()


class Subscription(Base):
    """A pass: a seat on a morning (and optionally evening) departure for a period."""
    __tablename__ = "subscriptions"
    id: Mapped[int] = mapped_column(primary_key=True)
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    intent_id: Mapped[int | None] = mapped_column(ForeignKey("commute_intents.id"))
    product: Mapped[str] = mapped_column(String(10))            # monthly | weekly
    am_template_id: Mapped[int] = mapped_column(ForeignKey("trip_templates.id"))
    am_pickup_stop_id: Mapped[int] = mapped_column(ForeignKey("stops.id"))
    am_drop_stop_id: Mapped[int] = mapped_column(ForeignKey("stops.id"))
    am_fare: Mapped[int] = mapped_column(Integer)               # Rs per ride, for credits
    pm_template_id: Mapped[int | None] = mapped_column(ForeignKey("trip_templates.id"))
    pm_pickup_stop_id: Mapped[int | None] = mapped_column(ForeignKey("stops.id"))
    pm_drop_stop_id: Mapped[int | None] = mapped_column(ForeignKey("stops.id"))
    pm_fare: Mapped[int | None] = mapped_column(Integer)
    days_mask: Mapped[int] = mapped_column(Integer)
    valid_from: Mapped[dt.date] = mapped_column(Date)
    valid_to: Mapped[dt.date] = mapped_column(Date)
    price_paise: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | cancelled | expired
    created_at: Mapped[dt.datetime] = _now()


class Skip(Base):
    """'Not joining' for one leg on one day. The source of truth: bookings are derived from it."""
    __tablename__ = "skips"
    id: Mapped[int] = mapped_column(primary_key=True)
    subscription_id: Mapped[int] = mapped_column(ForeignKey("subscriptions.id"))
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    service_date: Mapped[dt.date] = mapped_column(Date)
    leg: Mapped[str] = mapped_column(String(2))                 # AM | PM
    on_time: Mapped[bool] = mapped_column(Boolean)              # declared before the D-1 cut-off
    credit_paise: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = _now()
    __table_args__ = (UniqueConstraint("subscription_id", "service_date", "leg"),)


# ---------------------------------------------------------------------------------------------
# Daily operations: trips, bookings, duties, telemetry
# ---------------------------------------------------------------------------------------------
class Trip(Base):
    __tablename__ = "trips"
    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(ForeignKey("trip_templates.id"))
    route_id: Mapped[int] = mapped_column(ForeignKey("routes.id"))
    service_date: Mapped[dt.date] = mapped_column(Date, index=True)
    planned_start: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    planned_end: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    vehicle_class_id: Mapped[int] = mapped_column(ForeignKey("vehicle_classes.id"))  # right-sized class for the day
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))
    status: Mapped[str] = mapped_column(String(12), default="planned")  # planned | in_progress | completed | cancelled
    booked: Mapped[int] = mapped_column(Integer, default=0)
    actual_start: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    actual_end: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    gps_source: Mapped[str] = mapped_column(String(4), default="sim")  # sim | app
    sim_delay_min: Mapped[int] = mapped_column(Integer, default=0)
    route: Mapped[Route] = relationship(lazy="joined")
    vehicle: Mapped[Vehicle | None] = relationship(lazy="joined")
    vehicle_class: Mapped[VehicleClass] = relationship(lazy="joined")
    __table_args__ = (UniqueConstraint("template_id", "service_date"),)


class Booking(Base):
    __tablename__ = "bookings"
    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"), index=True)
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    subscription_id: Mapped[int] = mapped_column(ForeignKey("subscriptions.id"))
    leg: Mapped[str] = mapped_column(String(6))                 # AM | PM | FEEDER
    pickup_stop_id: Mapped[int] = mapped_column(ForeignKey("stops.id"))
    drop_stop_id: Mapped[int] = mapped_column(ForeignKey("stops.id"))
    status: Mapped[str] = mapped_column(String(10), default="confirmed")  # confirmed | skipped | boarded | no_show | completed
    boarding_code: Mapped[str] = mapped_column(String(6))
    boarded_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    trip: Mapped[Trip] = relationship(lazy="joined")
    pickup_stop: Mapped[Stop] = relationship(foreign_keys=[pickup_stop_id], lazy="joined")
    drop_stop: Mapped[Stop] = relationship(foreign_keys=[drop_stop_id], lazy="joined")
    rider: Mapped[User] = relationship(lazy="joined")
    __table_args__ = (UniqueConstraint("trip_id", "subscription_id"),)


class Duty(Base):
    """One driver's working block on one vehicle for one day."""
    __tablename__ = "duties"
    id: Mapped[int] = mapped_column(primary_key=True)
    service_date: Mapped[dt.date] = mapped_column(Date, index=True)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"))
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"))
    block: Mapped[str] = mapped_column(String(4), default="FULL")  # FULL | AM | PM (split shift)
    report_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    sign_off_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    worked_min: Mapped[int] = mapped_column(Integer)
    spread_min: Mapped[int] = mapped_column(Integer)
    deadhead_km: Mapped[float] = mapped_column(Float, default=0)
    vehicle: Mapped[Vehicle] = relationship(lazy="joined")
    driver: Mapped[Driver | None] = relationship(lazy="joined")
    items: Mapped[list[DutyItem]] = relationship(order_by="DutyItem.seq", cascade="all, delete-orphan")


class DutyItem(Base):
    __tablename__ = "duty_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    duty_id: Mapped[int] = mapped_column(ForeignKey("duties.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(10))               # check | trip | deadhead | break
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"))
    start_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    end_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    km: Mapped[float] = mapped_column(Float, default=0)
    trip: Mapped[Trip | None] = relationship(lazy="joined")


class VehiclePosition(Base):
    """Latest known position per vehicle (a Redis key in production)."""
    __tablename__ = "vehicle_positions"
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), primary_key=True)
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id", ondelete="SET NULL"))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    heading: Mapped[float | None] = mapped_column(Float)
    speed_kmh: Mapped[float | None] = mapped_column(Float)
    ts: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(4))              # sim | app


class GpsPing(Base):
    """Raw pings (a time-series store in production; kept for disputes, then aggregated)."""
    __tablename__ = "gps_pings"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), index=True)
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id", ondelete="SET NULL"))
    ts: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    speed_kmh: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(4))


class TripEvent(Base):
    __tablename__ = "trip_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"), index=True)
    ts: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    type: Mapped[str] = mapped_column(String(12))   # start | arrive | depart | board | no_show | end | delay
    stop_id: Mapped[int | None] = mapped_column(ForeignKey("stops.id"))
    booking_id: Mapped[int | None] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"))
    client_event_id: Mapped[str] = mapped_column(String(80), unique=True)  # makes retries from offline phones safe
    source: Mapped[str] = mapped_column(String(4), default="app")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class Rating(Base):
    __tablename__ = "ratings"
    id: Mapped[int] = mapped_column(primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"), unique=True)
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"))
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"))
    driver_score: Mapped[int] = mapped_column(Integer)
    vehicle_score: Mapped[int] = mapped_column(Integer)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(30)), default=list)
    comment: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[dt.datetime] = _now()
    __table_args__ = (CheckConstraint("driver_score between 1 and 5 and vehicle_score between 1 and 5", name="ck_rating_range"),)


class Incident(Base):
    __tablename__ = "incidents"
    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id", ondelete="SET NULL"))
    reported_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(12))               # sos | breakdown | road_blocked | misconduct | other
    severity: Mapped[str] = mapped_column(String(8))            # critical | high | normal
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    note: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(8), default="open")  # open | ack | closed
    created_at: Mapped[dt.datetime] = _now()


# ---------------------------------------------------------------------------------------------
# Money: payments and a double-entry ledger
# ---------------------------------------------------------------------------------------------
class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(primary_key=True)
    rider_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    subscription_id: Mapped[int | None] = mapped_column(ForeignKey("subscriptions.id"))
    amount_paise: Mapped[int] = mapped_column(Integer)
    method: Mapped[str] = mapped_column(String(12))             # upi | card | credit_only
    gateway: Mapped[str] = mapped_column(String(12))            # sandbox | razorpay | ...
    gateway_ref: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(10))             # captured | failed | refunded
    created_at: Mapped[dt.datetime] = _now()


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    id: Mapped[int] = mapped_column(primary_key=True)
    txn_id: Mapped[str] = mapped_column(String(36), index=True)
    account: Mapped[str] = mapped_column(String(40), index=True)
    debit_paise: Mapped[int] = mapped_column(Integer, default=0)
    credit_paise: Mapped[int] = mapped_column(Integer, default=0)
    memo: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[dt.datetime] = _now()
    __table_args__ = (CheckConstraint("debit_paise >= 0 and credit_paise >= 0 and (debit_paise = 0) <> (credit_paise = 0)",
                                      name="ck_ledger_one_side"),)


# ---------------------------------------------------------------------------------------------
# Demo clock
# ---------------------------------------------------------------------------------------------
class SimClock(Base):
    """mode 'real' uses the wall clock; 'sim' runs from anchor_sim at `speed` x real time (for demos)."""
    __tablename__ = "sim_clock"
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    mode: Mapped[str] = mapped_column(String(4), default="real")
    anchor_real: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    anchor_sim: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    speed: Mapped[float] = mapped_column(Float, default=1.0)
