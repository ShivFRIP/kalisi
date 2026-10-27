"""Pricing, auth, access control, ledger invariants."""
import pytest
from fastapi import HTTPException

from kalisi import ledger
from kalisi.pricing import express_fare, pass_price, ride_fare

from .conftest import login, new_phone


def test_fares_match_demo_formula():
    assert ride_fare(1) == 49                 # floor
    assert ride_fare(10) == 89                # 45 + 40 = 85 -> rounds half up to 90 -> 89
    assert ride_fare(20.4) == 129             # 126.6 -> 130 -> 129
    assert express_fare(89) == 119            # 115.7 -> 120 -> 119
    assert pass_price(89, 89, "monthly") == 2559   # 178 x 20 x 0.72 = 2563.2 -> 2560 -> 2559
    assert pass_price(89, None, "weekly") == 379   # 89 x 5 x 0.85 = 378.25 -> 380 -> 379
    with pytest.raises(ValueError):
        pass_price(89, None, "daily")


def test_otp_flow_and_limits(client):
    phone = new_phone()
    r = client.post("/api/v1/auth/otp", json={"phone": phone})
    assert r.status_code == 200 and len(r.json()["dev_code"]) == 6
    bad = client.post("/api/v1/auth/verify", json={"phone": phone, "code": "000000" if r.json()["dev_code"] != "000000" else "111111"})
    assert bad.status_code == 401
    ok = client.post("/api/v1/auth/verify", json={"phone": phone, "code": r.json()["dev_code"], "name": "Test Rider"})
    assert ok.status_code == 200 and ok.json()["user"]["role"] == "rider"
    reused = client.post("/api/v1/auth/verify", json={"phone": phone, "code": r.json()["dev_code"]})
    assert reused.status_code == 401             # one-time code
    for _ in range(2):
        client.post("/api/v1/auth/otp", json={"phone": phone})
    assert client.post("/api/v1/auth/otp", json={"phone": phone}).status_code == 429


def test_phone_validation(client, monkeypatch):
    assert client.post("/api/v1/auth/otp", json={"phone": "12345"}).status_code == 422
    assert client.post("/api/v1/auth/otp", json={"phone": "5123456789"}).status_code == 422
    from kalisi import security
    from kalisi.config import Settings
    monkeypatch.setattr(security, "get_settings", lambda: Settings(env="prod"))
    with pytest.raises(HTTPException) as e:
        security.normalize_phone("0000012345")
    assert e.value.status_code == 422            # demo numbers refused in production
    assert security.normalize_phone("+91 98765 43210") == "+919876543210"


def test_role_based_access(client):
    rider = login(client, new_phone())
    driver = login(client, "0000020001")
    ops = login(client, "0000000001")
    assert client.get("/api/v1/ops/overview").status_code == 401
    assert client.get("/api/v1/ops/overview", headers=rider).status_code == 403
    assert client.get("/api/v1/rider/home", headers=driver).status_code == 403
    assert client.get("/api/v1/driver/today", headers=ops).status_code == 403
    assert client.get("/api/v1/ops/overview", headers=ops).status_code == 200
    assert client.get("/api/v1/ops/overview", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    # the web apps send the token in X-Auth-Token, so a demo proxy's basic-auth header can sit alongside it
    token = ops["Authorization"].split()[1]
    both = {"X-Auth-Token": token, "Authorization": "Basic ZGVtbzpwdw=="}
    assert client.get("/api/v1/ops/overview", headers=both).status_code == 200
    assert client.get("/api/v1/ops/overview", headers={"X-Auth-Token": "nonsense"}).status_code == 401


def test_ledger_rejects_unbalanced(db):
    with pytest.raises(ledger.LedgerError):
        ledger.post(db, [("a", 100, 0), ("b", 0, 90)], "bad")
    with pytest.raises(ledger.LedgerError):
        ledger.post(db, [("a", 100, 100)], "both sides")
    db.rollback()


def test_ledger_balances_after_seed(db):
    assert ledger.trial_balance(db) == 0
