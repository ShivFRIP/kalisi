"""Driver events, live tracking and ETAs, the simulator, ratings and SOS."""
import datetime as dt
import uuid

from sqlalchemy import func, select

from kalisi import clock
from kalisi.models import Booking, Duty, DutyItem, Trip
from kalisi.services import simulator
from kalisi.services.live import delay_min

from .conftest import DAY, freeze, login, new_phone, token_for_user

DRV = "/api/v1/driver"


def _local(t: dt.datetime) -> str:
    return t.astimezone(clock.tz()).strftime("%H:%M")


def _trip_with_driver(db, min_booked=2, exclude=()):
    q = (select(Trip, Duty).join(DutyItem, DutyItem.trip_id == Trip.id).join(Duty, Duty.id == DutyItem.duty_id)
         .where(Trip.service_date == DAY, Trip.status == "planned", Duty.driver_id.is_not(None), Trip.booked >= min_booked,
                Trip.id.not_in(exclude)).order_by(Trip.planned_start))
    return db.execute(q.limit(1)).first()


def ev(trip_id, type_, **kw):
    return {"client_event_id": uuid.uuid4().hex, "trip_id": trip_id, "type": type_, **kw}


def test_driver_trip_flow(client, db, clock_reset):
    trip, duty = _trip_with_driver(db)
    hdr = login(client, duty.driver.user.phone[3:])
    today = client.get(f"{DRV}/today", headers=hdr).json()
    assert any(i.get("trip_id") == trip.id for d in today["duties"] for i in d["items"])
    first = trip.route.stops[0]
    bookings = db.execute(select(Booking).where(Booking.trip_id == trip.id, Booking.pickup_stop_id == first.stop_id)).scalars().all()
    if len(bookings) < 2:   # need two riders at the first stop: fall back to any two
        bookings = db.execute(select(Booking).where(Booking.trip_id == trip.id).order_by(Booking.id)).scalars().all()
    b1, b2 = bookings[0], bookings[1]

    freeze(db, DAY, _local(trip.planned_start - dt.timedelta(minutes=5)))
    other = login(client, "0000020002") if duty.driver.user.phone != "+910000020002" else login(client, "0000020003")
    assert client.post(f"{DRV}/events", headers=other, json=[ev(trip.id, "start")]).json()["results"][0]["status"] == "rejected"
    res = client.post(f"{DRV}/events", headers=hdr, json=[ev(trip.id, "start"), ev(trip.id, "arrive", stop_id=b1.pickup_stop_id),
                                                          ev(trip.id, "arrive", stop_id=b2.pickup_stop_id)]).json()["results"]
    assert [r["status"] for r in res][:2] == ["applied", "applied"]
    detail = client.get(f"{DRV}/trips/{trip.id}", headers=hdr).json()
    assert detail["gps_source"] == "app" and detail["status"] == "in_progress"
    assert all("code" not in r and "phone" not in r for s in detail["stops"] for r in s["board"])   # driver never sees codes/phones

    wrong = "0000" if b1.boarding_code != "0000" else "1111"
    board_bad = ev(trip.id, "board", booking_id=b1.id, code=wrong)
    assert client.post(f"{DRV}/events", headers=hdr, json=[board_bad]).json()["results"][0]["status"] == "rejected"
    board = ev(trip.id, "board", booking_id=b1.id, code=b1.boarding_code)
    assert client.post(f"{DRV}/events", headers=hdr, json=[board]).json()["results"][0]["status"] == "applied"
    assert client.post(f"{DRV}/events", headers=hdr, json=[board]).json()["results"][0]["status"] == "duplicate"   # offline resend

    ns = ev(trip.id, "no_show", booking_id=b2.id)
    assert client.post(f"{DRV}/events", headers=hdr, json=[ns]).json()["results"][0]["status"] == "rejected"      # must wait 2 min
    freeze(db, DAY, _local(trip.planned_start - dt.timedelta(minutes=2)))
    assert client.post(f"{DRV}/events", headers=hdr, json=[ev(trip.id, "no_show", booking_id=b2.id)]).json()["results"][0]["status"] == "applied"

    s = trip.route.stops[1].stop
    assert client.post(f"{DRV}/events", headers=hdr, json=[ev(trip.id, "ping", lat=s.lat, lon=s.lon, speed_kmh=22)]).json()["results"][0]["status"] == "applied"
    rider = token_for_user(b1.rider_id)
    live = client.get(f"/api/v1/rider/bookings/{b1.id}/live", headers=rider).json()
    assert live["position"]["source"] == "app" and live["booking"]["status"] == "boarded"
    assert live["vehicle"]["reg_no"] == trip.vehicle.reg_no and live["driver"]["first_name"]
    assert client.get(f"/api/v1/rider/bookings/{b1.id}/live", headers=token_for_user(b2.rider_id)).status_code == 404

    rating = {"driver_score": 5, "vehicle_score": 4, "tags": ["ac_working", "felt_safe"]}
    assert client.post(f"/api/v1/rider/bookings/{b1.id}/rating", headers=rider, json=rating).status_code == 409   # not finished yet
    assert client.post(f"{DRV}/events", headers=hdr, json=[ev(trip.id, "end")]).json()["results"][0]["status"] == "applied"
    db.expire_all()
    assert db.get(Trip, trip.id).status == "completed" and db.get(Booking, b1.id).status == "completed"
    assert client.post(f"/api/v1/rider/bookings/{b1.id}/rating", headers=rider, json=rating).status_code == 200
    assert client.post(f"/api/v1/rider/bookings/{b1.id}/rating", headers=rider, json=rating).status_code == 409
    assert client.post(f"/api/v1/rider/bookings/{b2.id}/rating", headers=token_for_user(b2.rider_id), json=rating).status_code == 409
    bad = {"driver_score": 5, "vehicle_score": 5, "tags": ["not_a_tag"]}
    assert client.post(f"/api/v1/rider/bookings/{b1.id}/rating", headers=rider, json=bad).status_code in (409, 422)


def test_simulator_moves_vehicles_and_eta_tracks_delay(db, clock_reset):
    row = _trip_with_driver(db, min_booked=1)
    trip = row[0]
    stops = trip.route.stops
    mid = stops[len(stops) // 2].offset_min
    at = trip.planned_start + dt.timedelta(minutes=trip.sim_delay_min + mid + 1)
    freeze(db, DAY, _local(at))
    simulator.tick(db)
    db.expire_all()
    trip = db.get(Trip, trip.id)
    assert trip.status == "in_progress"
    d = delay_min(db, trip, clock.now(db))
    assert abs(d - trip.sim_delay_min) <= 1.5, (d, trip.sim_delay_min)
    from kalisi.services.live import trip_live
    live = trip_live(db, trip, clock.now(db))
    assert live["position"] and live["position"]["source"] == "sim"
    last = live["stops"][-1]
    planned_last = dt.datetime.fromisoformat(last["planned"])
    eta_mid = dt.datetime.fromisoformat(last["eta_from"]) + dt.timedelta(minutes=1)
    assert abs((eta_mid - planned_last).total_seconds() / 60 - max(d, 0)) < 0.01
    end = trip.planned_end + dt.timedelta(minutes=trip.sim_delay_min + 2)
    freeze(db, DAY, _local(end))
    simulator.tick(db)
    db.expire_all()
    trip = db.get(Trip, trip.id)
    assert trip.status == "completed"
    left = db.scalar(select(func.count()).select_from(Booking).where(Booking.trip_id == trip.id, Booking.status.in_(("confirmed", "boarded"))))
    assert left == 0


def test_sos_goes_to_control_room_and_is_scoped(client, db):
    trip = db.scalar(select(Trip).where(Trip.service_date == DAY, Trip.booked > 0).limit(1))
    stranger = login(client, new_phone())
    assert client.post("/api/v1/sos", headers=stranger, json={"trip_id": trip.id}).status_code == 404
    b = db.scalar(select(Booking).where(Booking.trip_id == trip.id).limit(1))
    r = client.post("/api/v1/sos", headers=token_for_user(b.rider_id), json={"trip_id": trip.id, "lat": 17.44, "lon": 78.38, "note": "test"})
    assert r.status_code == 200 and "control room" in r.json()["message"]
    ex = client.get("/api/v1/ops/exceptions", headers=login(client, "0000000001")).json()
    assert ex[0]["severity"] == "critical" and ex[0]["kind"] == "sos"


def test_queued_event_keeps_tap_time_within_cap(db, clock_reset):
    from kalisi.services.driver import MAX_EVENT_AGE, DriverEvent, event_time
    clock.set_clock(db, "sim", dt.datetime.combine(DAY, dt.time(8, 0), tzinfo=clock.tz()), 1)
    real = dt.datetime.now(dt.timezone.utc)
    mk = lambda ts: DriverEvent(client_event_id="abcdef1", trip_id=1, type="arrive", device_ts=ts.isoformat())
    now = clock.now(db)
    five = event_time(db, mk(real - dt.timedelta(minutes=5)))
    assert abs((now - five).total_seconds() - 300) < 5                     # sent 5 minutes late -> stamped 5 minutes earlier
    hour = event_time(db, mk(real - dt.timedelta(hours=1)))
    assert abs((now - hour) - MAX_EVENT_AGE).total_seconds() < 5           # capped at 15 minutes
    future = event_time(db, mk(real + dt.timedelta(minutes=10)))
    assert abs((future - now).total_seconds()) < 5                         # a phone clock running fast is ignored
    assert event_time(db, DriverEvent(client_event_id="abcdef2", trip_id=1, type="arrive")) - now < dt.timedelta(seconds=5)
