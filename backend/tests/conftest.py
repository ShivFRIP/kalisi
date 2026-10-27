"""Tests run against a separate database (kalisi_test), seeded once for a fixed Wednesday with the clock frozen.

Requires a local PostgreSQL with PostGIS; set KALISI_TEST_DATABASE_URL to override.
"""
import datetime as dt
import os

TEST_DB = os.environ.get("KALISI_TEST_DATABASE_URL", "postgresql+psycopg://kalisi:kalisi@localhost:5432/kalisi_test")
os.environ["KALISI_DATABASE_URL"] = TEST_DB
os.environ["KALISI_BACKGROUND_JOBS"] = "false"
os.environ["KALISI_ENV"] = "dev"
os.environ["KALISI_SOLVER_SECONDS"] = "5"

import psycopg  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _ensure_db() -> None:
    admin = TEST_DB.replace("postgresql+psycopg", "postgresql").rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin, autocommit=True) as c:
        if not c.execute("select 1 from pg_database where datname = 'kalisi_test'").fetchone():
            c.execute("create database kalisi_test")
    with psycopg.connect(TEST_DB.replace("postgresql+psycopg", "postgresql"), autocommit=True) as c:
        try:
            c.execute("create extension if not exists postgis")
        except psycopg.errors.InsufficientPrivilege:
            pass  # created by a superuser beforehand


def next_wednesday() -> dt.date:
    d = dt.date.today() + dt.timedelta(days=1)
    while d.weekday() != 2:
        d += dt.timedelta(days=1)
    return d


DAY = next_wednesday()


@pytest.fixture(scope="session", autouse=True)
def seeded():
    _ensure_db()
    from kalisi import seed
    seed.main(reset_db=True, day=DAY, at=dt.time(6, 0), speed=0)
    yield DAY


@pytest.fixture
def db():
    from kalisi.db import SessionLocal
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def client():
    from kalisi.main import app
    return TestClient(app)


def freeze(db, day: dt.date, hhmm: str) -> None:
    from kalisi import clock
    clock.set_clock(db, "sim", dt.datetime.combine(day, dt.time.fromisoformat(hhmm), tzinfo=clock.tz()), 0)


def login(client, phone: str, name: str | None = None) -> dict:
    """Seeded accounts get a token directly (so tests don't hit the OTP rate limit); new numbers go through OTP."""
    from sqlalchemy import select

    from kalisi.db import SessionLocal
    from kalisi.models import User
    from kalisi.security import issue_token, normalize_phone
    with SessionLocal() as s:
        u = s.scalar(select(User).where(User.phone == normalize_phone(phone)))
        if u is not None:
            return {"Authorization": f"Bearer {issue_token(u)}"}
    code = client.post("/api/v1/auth/otp", json={"phone": phone}).json()["dev_code"]
    r = client.post("/api/v1/auth/verify", json={"phone": phone, "code": code, "name": name})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


_counter = [0]


def new_phone() -> str:
    _counter[0] += 1
    return f"00008{_counter[0]:05d}"


def token_for_user(user_id: int) -> dict:
    from kalisi.db import SessionLocal
    from kalisi.models import User
    from kalisi.security import issue_token
    with SessionLocal() as s:
        return {"Authorization": f"Bearer {issue_token(s.get(User, user_id))}"}


@pytest.fixture
def clock_reset(db):
    yield
    freeze(db, DAY, "06:00")
