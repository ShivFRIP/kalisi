"""Matching, buying a pass, and the 'not joining' rules."""
import datetime as dt

from sqlalchemy import select

from kalisi import ledger
from kalisi.models import Booking, Trip
from kalisi.pricing import pass_price

from .conftest import DAY, freeze, login, new_phone

KUKATPALLY_METRO = (17.4849, 78.4118)
WAVEROCK = (17.41838, 78.34734)
SECUNDERABAD = (17.43595, 78.50005)
POCHARAM = (17.43661, 78.64222)
API = "/api/v1/rider"


def intent(client, hdr, home, office, am=("08:30", "09:30"), pm=("17:30", "18:30"), ac_only=True, days=(0, 1, 2, 3, 4)):
    body = {"home": {"lat": home[0], "lon": home[1], "label": "home"}, "office": {"lat": office[0], "lon": office[1], "label": "office"},
            "am_from": am[0], "am_to": am[1], "pm_from": pm[0] if pm else None, "pm_to": pm[1] if pm else None,
            "days": list(days), "ac_only": ac_only, "max_walk_m": 800}
    r = client.post(f"{API}/intents", headers=hdr, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_matching_respects_walk_window_and_direction(client):
    hdr = login(client, new_phone())
    j = intent(client, hdr, KUKATPALLY_METRO, WAVEROCK)
    assert not j["pooled"] and j["intent"]["status"] == "matched"
    am = j["am_options"]
    assert am and any(o["route_code"] == "K1" for o in am)
    for o in am:
        assert o["walk_to_pickup_m"] <= 800 and o["walk_from_drop_m"] <= 1000
        assert "08:10" <= o["arrive"] <= "09:30"           # 20-minute early tolerance
        assert o["seats_left"] > 0 and o["ac"]
    for o in j["pm_options"]:
        assert "17:30" <= o["depart"] <= "18:45"            # 15-minute late tolerance
    assert len({o["template_id"] for o in am}) == len(am)   # one option per departure


def test_ac_preference_filters_non_ac_bus(client):
    hdr = login(client, new_phone())
    j = intent(client, hdr, SECUNDERABAD, POCHARAM, am=("08:30", "09:30"), pm=None)
    assert all(o["route_code"] != "E6" for o in j["am_options"])
    j2 = intent(client, hdr, SECUNDERABAD, POCHARAM, am=("08:30", "09:30"), pm=None, ac_only=False)
    assert any(o["route_code"] == "E6" and not o["ac"] for o in j2["am_options"])


def test_window_validation(client):
    hdr = login(client, new_phone())
    body = {"home": {"lat": 17.48, "lon": 78.41}, "office": {"lat": 17.41, "lon": 78.34}, "am_from": "09:30", "am_to": "09:00"}
    assert client.post(f"{API}/intents", headers=hdr, json=body).status_code == 422
    body.update(am_from="09:00", am_to="09:30", pm_from="18:00")
    assert client.post(f"{API}/intents", headers=hdr, json=body).status_code == 422
    body.update(pm_from=None, home={"lat": 12.97, "lon": 77.59})   # Bengaluru: outside the service region
    assert client.post(f"{API}/intents", headers=hdr, json=body).status_code == 422


def _buy(client, hdr, product="monthly"):
    j = intent(client, hdr, KUKATPALLY_METRO, WAVEROCK)
    am = next(o for o in j["am_options"] if o["route_code"] == "K1")
    pm = j["pm_options"][0]
    r = client.post(f"{API}/passes", headers=hdr, json={"intent_id": j["intent"]["id"], "am_option_id": am["option_id"],
                                                         "pm_option_id": pm["option_id"], "product": product, "method": "upi"})
    assert r.status_code == 200, r.text
    return j, am, pm, r.json()


def test_buy_pass_prices_seats_and_ledger(client, db):
    hdr = login(client, new_phone())
    deferred_before = ledger.liability_balance(db, "deferred_revenue")
    j, am, pm, p = _buy(client, hdr)
    assert p["price_paise"] == pass_price(am["fare"], pm["fare"], "monthly") * 100 == p["paid_paise"]
    assert p["valid_from"] == (DAY + dt.timedelta(days=1)).isoformat()
    db.expire_all()
    assert ledger.liability_balance(db, "deferred_revenue") - deferred_before == p["price_paise"]
    assert ledger.trial_balance(db) == 0
    again = client.get(f"{API}/intents/{j['intent']['id']}/options", headers=hdr).json()
    same = next(o for o in again["am_options"] if o["template_id"] == am["template_id"])
    assert same["seats_left"] == am["seats_left"] - 1
    # a forged option id is re-derived server-side and refused
    tid, pick, drop = am["option_id"].split(":")
    forged = f"{tid}:{drop}:{pick}"
    r = client.post(f"{API}/passes", headers=hdr, json={"intent_id": j["intent"]["id"], "am_option_id": forged, "product": "weekly"})
    assert r.status_code == 409
    # someone else's commute
    other = login(client, new_phone())
    r = client.post(f"{API}/passes", headers=other, json={"intent_id": j["intent"]["id"], "am_option_id": am["option_id"], "product": "weekly"})
    assert r.status_code == 404


def test_skip_rules_credit_and_undo(client, db, clock_reset):
    hdr = login(client, new_phone())
    _, am, pm, p = _buy(client, hdr)
    thu = DAY + dt.timedelta(days=1)
    freeze(db, DAY, "19:30")          # before Wednesday's 20:00 cut-off for Thursday
    r = client.post(f"{API}/skips", headers=hdr, json={"subscription_id": p["id"], "date": thu.isoformat(), "leg": "AM"})
    assert r.status_code == 200 and r.json()["on_time"] and r.json()["credit_paise"] == am["fare"] * 100
    assert client.get(f"{API}/wallet", headers=hdr).json()["credit_paise"] == am["fare"] * 100
    dup = client.post(f"{API}/skips", headers=hdr, json={"subscription_id": p["id"], "date": thu.isoformat(), "leg": "AM"})
    assert dup.status_code == 409
    assert client.delete(f"{API}/skips/{r.json()['skip_id']}", headers=hdr).status_code == 200
    assert client.get(f"{API}/wallet", headers=hdr).json()["credit_paise"] == 0

    freeze(db, DAY, "21:00")          # after the cut-off: seat released, no credit
    r = client.post(f"{API}/skips", headers=hdr, json={"subscription_id": p["id"], "date": thu.isoformat(), "leg": "AM"})
    assert r.status_code == 200 and not r.json()["on_time"] and r.json()["credit_paise"] == 0

    pick = dt.time.fromisoformat(pm["depart"])
    late = (dt.datetime.combine(thu, pick) - dt.timedelta(minutes=20)).time().strftime("%H:%M")
    freeze(db, thu, late)             # 20 minutes before the evening pickup: too late
    r = client.post(f"{API}/skips", headers=hdr, json={"subscription_id": p["id"], "date": thu.isoformat(), "leg": "PM"})
    assert r.status_code == 409
    sat = DAY + dt.timedelta(days=3)
    r = client.post(f"{API}/skips", headers=hdr, json={"subscription_id": p["id"], "date": sat.isoformat(), "leg": "AM"})
    assert r.status_code == 422       # not a travel day


def test_late_skip_releases_allocated_seat_and_credit_pays_next_pass(client, db, clock_reset):
    ops = login(client, "0000000001")
    hdr = login(client, new_phone())
    _, am, _, p = _buy(client, hdr)
    thu = DAY + dt.timedelta(days=1)
    freeze(db, DAY, "19:00")
    # on-time skip for Friday earns a credit
    fri = DAY + dt.timedelta(days=2)
    credit = client.post(f"{API}/skips", headers=hdr, json={"subscription_id": p["id"], "date": fri.isoformat(), "leg": "AM"}).json()["credit_paise"]
    assert credit > 0
    freeze(db, DAY, "20:30")
    assert client.post("/api/v1/ops/allocation/run", headers=ops, json={"date": thu.isoformat()}).status_code == 200
    db.expire_all()
    b = db.scalar(select(Booking).join(Trip).where(Booking.subscription_id == p["id"], Trip.service_date == thu, Booking.leg == "AM"))
    booked_before = b.trip.booked
    r = client.post(f"{API}/skips", headers=hdr, json={"subscription_id": p["id"], "date": thu.isoformat(), "leg": "AM"})
    assert r.status_code == 200 and r.json()["credit_paise"] == 0
    db.expire_all()
    b = db.get(Booking, b.id)
    assert b.status == "skipped" and b.trip.booked == booked_before - 1
    # cancelling returns unused days as credit; all credit is applied to the next pass before charging the payment method
    refund = client.post(f"{API}/passes/{p['id']}/cancel", headers=hdr).json()["credit_paise"]
    wallet = client.get(f"{API}/wallet", headers=hdr).json()["credit_paise"]
    assert wallet == credit + refund == p["price_paise"]      # nothing used yet: exactly the price back, never more
    j = intent(client, hdr, KUKATPALLY_METRO, WAVEROCK)
    am2 = next(o for o in j["am_options"] if o["route_code"] == "K1")
    r = client.post(f"{API}/passes", headers=hdr, json={"intent_id": j["intent"]["id"], "am_option_id": am2["option_id"], "product": "weekly"})
    assert r.status_code == 200
    assert r.json()["paid_paise"] == max(0, r.json()["price_paise"] - wallet)
    assert client.get(f"{API}/wallet", headers=hdr).json()["credit_paise"] == max(0, wallet - r.json()["price_paise"])
    db.expire_all()
    assert ledger.trial_balance(db) == 0


def test_home_shows_days_and_terms(client):
    hdr = login(client, "0000010001")     # the seeded demo rider
    h = client.get(f"{API}/home", headers=hdr).json()
    assert h["passes"] and h["passes"][0]["am"]["route_code"] == "K1"
    assert len(h["days"]) == 7
    legs = [leg for d in h["days"] for leg in d["legs"]]
    assert legs and all("terms" in leg and "note" in leg["terms"] for leg in legs)
    weekend = [d for d in h["days"] if d["weekday"] in ("Sat", "Sun")]
    assert all(not d["legs"] for d in weekend)


def test_switching_commute_replaces_pass_with_prorata_credit(client, db):
    from kalisi.models import Subscription
    hdr = login(client, new_phone())
    j, am, pm, first = _buy(client, hdr)
    # a second pass without saying it replaces the first is refused
    j2 = intent(client, hdr, KUKATPALLY_METRO, WAVEROCK)
    am2 = j2["am_options"][-1]
    r = client.post(f"{API}/passes", headers=hdr, json={"intent_id": j2["intent"]["id"], "am_option_id": am2["option_id"], "product": "weekly"})
    assert r.status_code == 409 and "Switch" in r.json()["detail"]
    r = client.post(f"{API}/passes", headers=hdr, json={"intent_id": j2["intent"]["id"], "am_option_id": am2["option_id"], "product": "weekly",
                                                         "replace_pass_id": first["id"]})
    assert r.status_code == 200, r.text
    new = r.json()
    db.expire_all()
    old = db.get(Subscription, first["id"])
    assert old.valid_to < old.valid_from and old.status == "cancelled"     # bought today, starts tomorrow: fully unused
    # the whole price of the unused first pass came back as credit and paid for the weekly pass
    assert new["paid_paise"] == max(0, new["price_paise"] - first["price_paise"])
    wallet = client.get(f"{API}/wallet", headers=hdr).json()
    assert wallet["credit_paise"] == max(0, first["price_paise"] - new["price_paise"])
    assert ledger.trial_balance(db) == 0
    home = client.get(f"{API}/home", headers=hdr).json()
    assert [p["id"] for p in home["passes"]] == [new["id"]]
    assert client.post(f"{API}/passes/{new['id']}/cancel", headers=hdr).status_code == 200
