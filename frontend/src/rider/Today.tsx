import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api, usePoll } from "../api";
import { clockTime, dayLabel, hm12, minutesText, rupeesFromPaise, timeRange } from "../fmt";
import { MapView, type MapLine, type MapMarker } from "../MapView";
import type { Day, DayLeg, Intent, OptionsResponse, TripLive } from "../types";
import { ErrorNote, Icon, Sheet, Spinner, useAction } from "../ui";
import { currentPosition, LEG_NAME, legStatus, useHome, windowLabel } from "./common";
import { RateSheet } from "./RateSheet";

export function Today() {
  const { home, error, reload } = useHome();
  const [rating, setRating] = useState(false);
  if (!home) return error ? <ErrorNote error={error} onRetry={reload} /> : <Spinner />;
  if (!home.passes.length && !home.intent) return <Navigate to="/rider/setup" replace />;
  const name = (home.user.name || "").replace(/\s*\(.*\)\s*$/, "").split(" ")[0];
  const today = home.days[0]?.date;
  return (
    <>
      <h1 style={{ fontSize: "1.35rem" }}>{name ? `Hi ${name}` : "Hello"}</h1>
      {home.current ? <CurrentTrip trip={home.current} /> : home.passes.length > 0 && <NextRide days={home.days} today={today} />}
      {home.pending_rating && (
        <div className="card row">
          <Icon.star size={22} />
          <div className="grow"><b>How was your ride?</b>
            <div className="small muted">{home.pending_rating.route_code} · {LEG_NAME[home.pending_rating.leg] ?? ""} · {dayLabel(home.pending_rating.date)}</div></div>
          <button className="btn sm" onClick={() => setRating(true)}>Rate</button>
        </div>
      )}
      {!home.passes.length && home.intent && <NoPassCard intent={home.intent} />}
      {home.passes.length > 0 && <Week days={home.days} today={today} cutoff={home.skip_cutoff} />}
      {rating && home.pending_rating && (
        <RateSheet bookingId={home.pending_rating.booking_id} subtitle={`${home.pending_rating.route_code} · ${dayLabel(home.pending_rating.date)}`}
                   onClose={() => setRating(false)} onDone={() => { setRating(false); reload(); }} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ the trip happening now (or next today)
function CurrentTrip({ trip }: { trip: TripLive }) {
  const b = trip.booking!;
  const [sos, setSos] = useState(false);
  const [showStops, setShowStops] = useState(false);
  const [settled, setSettled] = useState(false);   // refit the map once the card has its final size
  useEffect(() => { const id = window.setTimeout(() => setSettled(true), 400); return () => window.clearTimeout(id); }, []);
  const late = trip.delay_min >= 3;
  const onBoard = b.status === "boarded";
  const firstStop = trip.stops[0];

  const map = useMemo(() => {
    const markers: MapMarker[] = trip.stops.map((s) => ({
      lat: s.lat, lon: s.lon, kind: s.id === b.pickup.id ? "stop-me" : "stop",
      label: `${s.name}${s.id === b.pickup.id ? " (your pickup)" : s.id === b.drop.id ? " (your drop)" : ""}`,
    }));
    if (trip.position) markers.push({ lat: trip.position.lat, lon: trip.position.lon, kind: trip.delay_min > 5 ? "bus-late" : "bus",
      label: `${trip.vehicle?.reg_no ?? "Bus"} · ${trip.route_code}`, heading: trip.position.heading });
    const pts = trip.stops.map((s) => [s.lat, s.lon] as [number, number]);
    const lastPassed = trip.stops.reduce((k, s, i) => (s.passed ? i : k), -1);
    const lines: MapLine[] = [];
    if (lastPassed > 0) lines.push({ points: pts.slice(0, lastPassed + 1), color: "#8a9894", weight: 4 });
    lines.push({ points: pts.slice(Math.max(lastPassed, 0)) });
    return { markers, lines, fit: pts };
  }, [trip, b.pickup.id, b.drop.id]);

  let headline: string, eta: string, sub: string;
  if (onBoard) {
    headline = `On board · arriving at ${b.drop.name}`;
    eta = timeRange(b.drop.eta_from, b.drop.eta_to);
    sub = "Enjoy the ride.";
  } else {
    headline = `Your ${trip.vehicle ? "bus" : "ride"} reaches ${b.pickup.name}`;
    eta = timeRange(b.pickup.eta_from, b.pickup.eta_to);
    const m = b.minutes_to_pickup;
    sub = trip.status === "planned"
      ? `Leaves ${firstStop?.name ?? "the first stop"} at ${clockTime(trip.planned_start)}${m != null && m > 0 ? ` · in about ${minutesText(m)}` : ""}.`
      : m != null && m > 1 ? `About ${minutesText(m)} away${b.km_to_pickup != null ? ` (${b.km_to_pickup} km)` : ""}. Be at the stop a few minutes early.`
      : "Arriving now. Look out for it.";
  }

  return (
    <section className="card stack" style={{ gap: 12 }} aria-labelledby="h-now">
      <div className="row between wrap">
        <span className="row" style={{ gap: 6 }}><span className="pill route mono">{trip.route_code}</span>
          <span className="small muted">{LEG_NAME[b.leg] ?? ""}</span></span>
        {trip.status === "in_progress" || trip.status === "planned"
          ? <span className={`pill ${late ? "warn" : "good"}`}>{late ? `Running ${Math.round(trip.delay_min)} min late` : "On time"}</span>
          : <span className="pill">{trip.status}</span>}
      </div>
      <div className="r-trip-hero" aria-live="polite">
        <span id="h-now" className="small" style={{ fontWeight: 600 }}>{headline}</span>
        <span className="r-eta">around {eta}</span>
        <span className="small muted">{sub}</span>
      </div>
      {!onBoard && b.status === "confirmed" && (
        <div className="r-code" aria-label={`Boarding code ${b.boarding_code.split("").join(" ")}`}>
          <span className="small" style={{ fontWeight: 600, maxWidth: 140 }}>Show this code to the driver</span>
          <span className="digits">{b.boarding_code}</span>
        </div>
      )}
      <div className="r-facts">
        <div><span className="tiny muted">Vehicle</span><b className="mono">{trip.vehicle?.reg_no ?? "—"}</b></div>
        <div><span className="tiny muted">Type</span><b>{trip.vehicle ? `${trip.vehicle.seats}-seat${trip.vehicle.ac ? " AC" : ""}` : "—"}</b></div>
        <div><span className="tiny muted">Driver</span><b>{trip.driver?.first_name ?? "—"}</b></div>
      </div>
      <MapView className="map" markers={map.markers} lines={map.lines} fit={map.fit} fitKey={`${trip.trip_id}:${settled}`} ariaLabel="Live map of your bus and stops" />
      {!trip.position && trip.status === "planned" && <p className="tiny muted" style={{ margin: 0 }}>The bus appears on the map when it sets off.</p>}
      <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} aria-expanded={showStops} onClick={() => setShowStops((v) => !v)}>
        {showStops ? "Hide stops" : `All ${trip.stops.length} stops`}
      </button>
      {showStops && (
        <ol className="r-stops">
          {trip.stops.map((s) => (
            <li key={s.seq} className={`${s.passed ? "passed" : ""} ${s.id === b.pickup.id ? "me" : ""}`}>
              <span className="dot" aria-hidden="true" />
              <span>{s.name}{s.id === b.pickup.id && <span className="pill accent" style={{ marginLeft: 6 }}>Your stop</span>}
                {s.id === b.drop.id && <span className="pill route" style={{ marginLeft: 6 }}>Your drop</span>}</span>
              <span className="small mono muted">{s.passed ? "Passed" : timeRange(s.eta_from, s.eta_to)}</span>
            </li>
          ))}
        </ol>
      )}
      <button className="btn r-sos block" onClick={() => setSos(true)}><Icon.sos /> SOS: alert the control room</button>
      {sos && <SosSheet tripId={trip.trip_id} onClose={() => setSos(false)} />}
    </section>
  );
}

function SosSheet({ tripId, onClose }: { tripId: number; onClose: () => void }) {
  const { busy, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  async function send() {
    const pos = await currentPosition(4000);
    const r = await run(() => api<{ incident_id: number; message: string }>("rider", "/sos", { body: { trip_id: tripId, lat: pos?.lat, lon: pos?.lon, note: "Rider SOS from app" } }));
    if (r) setDone(r.message + (pos ? "" : " Your location wasn't shared; the trip details were."));
  }
  return (
    <Sheet title="Send an SOS?" onClose={onClose}>
      {done ? (
        <>
          <div className="banner good" role="status"><Icon.check /><div>{done}</div></div>
          <p className="small" style={{ margin: 0 }}>In immediate danger, also call <a href="tel:112"><b>112</b></a>, India's emergency number.</p>
          <button className="btn alt block" onClick={onClose}>Close</button>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>This alerts the Kalisi control room with your trip and, if you allow it, your location.</p>
          <p className="small muted" style={{ margin: 0 }}>In immediate danger, call <a href="tel:112"><b>112</b></a> first.</p>
          <button className="btn danger block" disabled={busy} onClick={send}><Icon.sos /> {busy ? "Sending…" : "Send SOS"}</button>
          <button className="btn alt block" onClick={onClose}>Cancel</button>
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ when nothing is running now
function NextRide({ days, today }: { days: Day[]; today?: string }) {
  for (const d of days) for (const l of d.legs) {
    if (l.status === "scheduled" || l.status === "confirmed") {
      return (
        <section className="card stack" aria-label="Next ride">
          <span className="lbl">Next ride</span>
          <span className="r-big">{d.date === today ? "Today" : dayLabel(d.date)}, {hm12(l.pickup_time)}</span>
          <span className="small">{LEG_NAME[l.leg]} · {l.route_code} from <b>{l.pickup_stop}</b></span>
          <span className="tiny muted">Live tracking and your boarding code appear here on the day.</span>
        </section>
      );
    }
  }
  return <section className="card"><b>No rides booked this week.</b><div className="small muted">Your pass may have ended. See the Pass tab.</div></section>;
}

function NoPassCard({ intent }: { intent: Intent }) {
  const pooled = intent.status === "pooled";
  const { data } = usePoll(() => api<OptionsResponse>("rider", `/rider/intents/${intent.id}/options`), 0, [intent.id]);
  const matched = data ? !data.pooled : !pooled;
  return (
    <section className="card stack" style={{ gap: 10 }}>
      {matched ? (
        <>
          <span className="pill good" style={{ alignSelf: "flex-start" }}>Seats available</span>
          <h2>A route fits your commute</h2>
          <p className="small muted" style={{ margin: 0 }}>To {intent.office.label}, arriving {windowLabel(intent.am_from, intent.am_to)}.</p>
          <Link className="btn block" to={`/rider/options/${intent.id}`}>See options and book</Link>
        </>
      ) : (
        <>
          <span className="pill accent" style={{ alignSelf: "flex-start" }}>On the waitlist</span>
          <h2>No route fits your commute yet</h2>
          <p className="small" style={{ margin: 0 }}>To <b>{intent.office.label}</b>, arriving {windowLabel(intent.am_from, intent.am_to)}. We'll let you know when a route opens.</p>
          {data?.similar_nearby != null && <div className="banner good"><Icon.people /><div><b>{data.similar_nearby} people near you</b> want a similar trip.</div></div>}
          <Link className="btn alt block" to="/rider/setup">Edit my commute</Link>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ the week ahead, with "not joining"
function Week({ days, today, cutoff }: { days: Day[]; today?: string; cutoff: string }) {
  const [skip, setSkip] = useState<{ day: Day; leg: DayLeg } | null>(null);
  const { reload } = useHome();
  const { busy, run } = useAction();
  const tomorrow = days[1]?.date;
  const undo = (l: DayLeg) => run(async () => { await api("rider", `/rider/skips/${l.skip_id}`, { method: "DELETE" }); await reload(); },
    l.skip_credit_paise ? `Seat kept. The ${rupeesFromPaise(l.skip_credit_paise)} credit was reversed.` : "Seat kept.");
  return (
    <section className="card" aria-labelledby="h-week" style={{ paddingBottom: 6 }}>
      <h2 id="h-week">This week</h2>
      <p className="tiny muted" style={{ margin: "2px 0 4px" }}>Not joining? Skip before {hm12(cutoff)} the evening before to get a ride credit.</p>
      {days.map((d) => (
        <div key={d.date} className="r-day">
          <div className="dname">{d.date === today ? "Today" : d.date === tomorrow ? "Tomorrow" : d.weekday}
            <div className="tiny muted" style={{ fontWeight: 500 }}>{dayLabel(d.date).split(" ").slice(1).join(" ")}</div></div>
          <div className="stack" style={{ gap: 0 }}>
            {d.legs.length === 0 && <span className="small muted" style={{ minHeight: 44, display: "flex", alignItems: "center" }}>No travel</span>}
            {d.legs.map((l) => {
              const st = legStatus(l.status);
              return (
                <div key={l.leg + l.subscription_id} className="r-leg">
                  <div className="grow stack" style={{ gap: 2 }}>
                    <div className="row" style={{ gap: 6 }}><b>{hm12(l.pickup_time)}</b><span className="small muted">{LEG_NAME[l.leg]}</span></div>
                    <div className="tiny muted ellipsis">{l.route_code} · {l.pickup_stop}</div>
                    <span><span className={`pill ${st.tone}`}>{st.text}{l.status === "skipped" && l.skip_credit_paise > 0 ? ` · +${rupeesFromPaise(l.skip_credit_paise)} credit` : ""}</span></span>
                  </div>
                  {l.can_skip && <button className="btn alt sm" onClick={() => setSkip({ day: d, leg: l })} aria-label={`Not joining ${LEG_NAME[l.leg]} on ${dayLabel(d.date)}`}>Skip</button>}
                  {l.can_undo && <button className="btn ghost sm" disabled={busy} onClick={() => undo(l)} aria-label={`Undo skip for ${LEG_NAME[l.leg]} on ${dayLabel(d.date)}`}>Undo</button>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {skip && <SkipSheet day={skip.day} leg={skip.leg} today={today} cutoff={cutoff} onClose={() => setSkip(null)} />}
    </section>
  );
}

function SkipSheet({ day, leg, today, cutoff, onClose }: { day: Day; leg: DayLeg; today?: string; cutoff: string; onClose: () => void }) {
  const { reload } = useHome();
  const { busy, run } = useAction();
  const t = leg.terms;
  const [stale, setStale] = useState(false);
  useEffect(() => { const id = window.setTimeout(() => setStale(true), 120000); return () => window.clearTimeout(id); }, []);
  async function confirm() {
    await api("rider", "/rider/skips", { body: { subscription_id: leg.subscription_id, date: day.date, leg: leg.leg } });
    await reload();
    onClose();
  }
  return (
    <Sheet title="Not joining?" onClose={onClose}>
      <p style={{ margin: 0 }}><b>{day.date === today ? "Today" : dayLabel(day.date)}</b> · {LEG_NAME[leg.leg]} · {hm12(leg.pickup_time)} from {leg.pickup_stop}</p>
      <div className={`banner ${t.on_time ? "good" : "warn"}`}><Icon.info /><div>
        {t.on_time
          ? <><b>You'll get a {rupeesFromPaise(t.credit_paise)} ride credit.</b> It's used automatically on your next pass.
              <div className="small">Credit applies if you skip before {dayLabel(t.deadline.slice(0, 10))}, {clockTime(t.deadline)}.</div></>
          : <><b>No credit now: the {hm12(cutoff)} cut-off has passed.</b>
              <div className="small">Skipping still frees your seat for someone else. You can skip until {clockTime(t.deadline)}.</div></>}
      </div></div>
      <p className="small muted" style={{ margin: 0 }}>Your seat goes to someone on the waitlist, and fewer empty seats keep fares low.</p>
      {stale && <p className="tiny muted" style={{ margin: 0 }}>These terms were shown a while ago; the final credit is confirmed when you tap.</p>}
      <button className="btn block" disabled={busy} onClick={() => run(confirm, t.on_time ? `Done. ${rupeesFromPaise(t.credit_paise)} credit added.` : "Done. Your seat is free for someone else.")}>
        {busy ? "Saving…" : "Yes, I'm not joining"}
      </button>
      <button className="btn alt block" onClick={onClose}>Keep my seat</button>
    </Sheet>
  );
}
