import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { dayLabel, hm12, rupees } from "../fmt";
import { MapView, type MapLine, type MapMarker } from "../MapView";
import type { MatchOption, OptionsResponse, Pass, Quote } from "../types";
import { Chip, ErrorNote, Icon, Spinner, useAction, useToast } from "../ui";
import { useHome, walkText, windowLabel } from "./common";

/** Departures that fit the rider's commute, the pass price, and a sandbox checkout. */
export function Options() {
  const { id } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const { home, reload: reloadHome } = useHome();
  const initial = (loc.state as OptionsResponse | null)?.intent?.id === Number(id) ? (loc.state as OptionsResponse) : null;
  const [data, setData] = useState<OptionsResponse | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [am, setAm] = useState<string | null>(null);
  const [pm, setPm] = useState<string | null>(null);
  const [product, setProduct] = useState<"monthly" | "weekly">("monthly");
  const [method, setMethod] = useState<"upi" | "card">("upi");
  const [quote, setQuote] = useState<Quote | null>(null);
  const { busy, run } = useAction();

  async function load() {
    try {
      setData(await api<OptionsResponse>("rider", `/rider/intents/${id}/options`));
      setError(null);
    } catch (e) { setError(e instanceof ApiError ? e.detail : String(e)); }
  }
  useEffect(() => { if (!initial) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  // keep the selection valid when options change
  useEffect(() => {
    if (!data) return;
    if (!data.am_options.some((o) => o.option_id === am)) setAm(data.am_options[0]?.option_id ?? null);
    if (pm !== "none" && !data.pm_options.some((o) => o.option_id === pm)) setPm(data.pm_options[0]?.option_id ?? "none");
  }, [data, am, pm]);

  const amOpt = data?.am_options.find((o) => o.option_id === am) ?? null;
  const pmOpt = pm && pm !== "none" ? data?.pm_options.find((o) => o.option_id === pm) ?? null : null;

  useEffect(() => {
    if (!amOpt) return;
    let live = true;
    api<Quote>("rider", "/rider/quote", { query: { am_fare: amOpt.fare, pm_fare: pmOpt?.fare } })
      .then((q) => live && setQuote(q)).catch(() => live && setQuote(null));
    return () => { live = false; };
  }, [amOpt?.fare, pmOpt?.fare]); // eslint-disable-line react-hooks/exhaustive-deps

  const map = useMemo(() => {
    if (!data) return { markers: [] as MapMarker[], lines: [] as MapLine[] };
    const h: [number, number] = [data.intent.home.lat, data.intent.home.lon], o: [number, number] = [data.intent.office.lat, data.intent.office.lon];
    const markers: MapMarker[] = [{ ...data.intent.home, kind: "home", label: "Home" }, { ...data.intent.office, kind: "office", label: "Office" }];
    const lines: MapLine[] = [];
    if (amOpt) {
      const p: [number, number] = [amOpt.pickup.lat, amOpt.pickup.lon], d: [number, number] = [amOpt.drop.lat, amOpt.drop.lon];
      markers.push({ lat: p[0], lon: p[1], kind: "stop-me", label: `Pickup: ${amOpt.pickup.name}` }, { lat: d[0], lon: d[1], kind: "stop", label: `Drop: ${amOpt.drop.name}` });
      lines.push({ points: [h, p], dashed: true, weight: 3, color: "#E59E16" }, { points: [p, d] }, { points: [d, o], dashed: true, weight: 3, color: "#E59E16" });
    } else lines.push({ points: [h, o], dashed: true, weight: 2 });
    return { markers, lines };
  }, [data, amOpt]);

  async function buy() {
    if (!data || !amOpt) return;
    try {
      const p = await api<Pass>("rider", "/rider/passes", { body: { intent_id: data.intent.id, am_option_id: amOpt.option_id,
        pm_option_id: pmOpt?.option_id ?? null, product, method,
        replace_pass_id: [...(home?.passes ?? [])].sort((a, b) => b.valid_to.localeCompare(a.valid_to))[0]?.id ?? null } });
      await reloadHome();
      toast(`Pass booked. Your first ride is ${dayLabel(p.valid_from)}.`);
      nav("/rider", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { toast(e.detail); await load(); }
      else toast(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <Shell><ErrorNote error={error} onRetry={load} /></Shell>;
  if (!data) return <Shell><Spinner label="Finding departures" /></Shell>;
  if (data.pooled) return <Shell><NoRoute data={data} /></Shell>;

  const price = quote ? quote[product] : null;
  const credit = price != null && quote ? Math.min(quote.credit_paise / 100, price) : 0;
  const hasPass = (home?.passes.length ?? 0) > 0;
  return (
    <Shell>
      <div className="stack" style={{ gap: 4 }}>
        <h2>We found seats for you</h2>
        <p className="small muted" style={{ margin: 0 }}>Pick a morning departure{data.pm_options.length ? " and a ride home" : ""}. Prices are per ride; a pass costs less.</p>
      </div>
      <MapView className="map" markers={map.markers} lines={map.lines} fitKey={amOpt?.option_id ?? "none"} ariaLabel="Map of your home, office and the chosen stops" />
      <section className="stack" aria-labelledby="h-am-opts">
        <h3 id="h-am-opts" className="lbl">To work</h3>
        <div className="stack" role="radiogroup" aria-labelledby="h-am-opts">
          {data.am_options.map((o) => <OptionCard key={o.option_id} o={o} on={am === o.option_id} onPick={() => setAm(o.option_id)} />)}
        </div>
      </section>
      {(data.pm_options.length > 0 || data.intent.pm_from) && (
        <section className="stack" aria-labelledby="h-pm-opts">
          <h3 id="h-pm-opts" className="lbl">Home</h3>
          <div className="stack" role="radiogroup" aria-labelledby="h-pm-opts">
            {data.pm_options.map((o) => <OptionCard key={o.option_id} o={o} on={pm === o.option_id} onPick={() => setPm(o.option_id)} />)}
            {data.pm_options.length === 0 && <div className="banner warn"><Icon.info /><div>No evening departure fits your leaving time yet. You can book the morning ride now.</div></div>}
            <button type="button" role="radio" aria-checked={pm === "none"} className="r-opt" onClick={() => setPm("none")}>
              <div className="row"><span className="r-radio" /><span className="grow"><b>No ride home</b><span className="small muted" style={{ display: "block" }}>I'll make my own way back.</span></span></div>
            </button>
          </div>
        </section>
      )}
      <section className="card stack" aria-labelledby="h-pass">
        <h3 id="h-pass">Choose a pass</h3>
        <div className="grid cols-2" role="radiogroup" aria-labelledby="h-pass" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {(["monthly", "weekly"] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={product === p} className="r-opt" onClick={() => setProduct(p)}>
              <span className="row between"><b>{p === "monthly" ? "Monthly" : "Weekly"}</b><span className="r-radio" /></span>
              <span className="fare">{quote ? rupees(quote[p]) : "…"}</span>
              <span className="tiny muted">{p === "monthly" ? "30 days · 28% off per ride" : "7 days · 15% off per ride"}</span>
            </button>
          ))}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl" id="h-pay">Pay with</span>
          <div className="chips" role="group" aria-labelledby="h-pay">
            <Chip on={method === "upi"} onClick={() => setMethod("upi")}>UPI</Chip>
            <Chip on={method === "card"} onClick={() => setMethod("card")}>Card</Chip>
          </div>
        </div>
        {price != null && (
          <dl className="r-kv">
            <dt>{product === "monthly" ? "Monthly" : "Weekly"} pass</dt><dd>{rupees(price)}</dd>
            {credit > 0 && <><dt>Ride credit used</dt><dd style={{ color: "var(--good)" }}>−{rupees(credit)}</dd></>}
            <dt><b style={{ color: "var(--ink)" }}>To pay now</b></dt><dd><b>{rupees(price - credit)}</b></dd>
          </dl>
        )}
        <div className="banner warn"><Icon.info /><div><b>Sandbox payment.</b> This prototype does not charge you; no real money moves.</div></div>
        {hasPass && <div className="banner info"><Icon.info /><div><b>This replaces your current pass.</b> Your current pass ends tonight; the days you
          haven't used come back as ride credit and are taken off the price above once you book.</div></div>}
      </section>
      <div className="r-sticky-cta">
        <button className="btn block" disabled={busy || !amOpt || price == null} onClick={() => run(buy)}>
          {busy ? "Booking…" : price != null ? `Pay ${rupees(price - credit)} and book` : "Book"}
        </button>
        <p className="tiny muted" style={{ textAlign: "center", margin: "6px 0 0" }}>Your seat starts tomorrow. Skip any day before 8 PM the evening before to get a ride credit.</p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  return (
    <>
      <header className="topbar">
        <button className="btn ghost sm" onClick={() => nav("/rider/setup")} aria-label="Edit commute"><Icon.back /></button>
        <h1>Your options</h1>
      </header>
      <div className="page">{children}</div>
    </>
  );
}

function OptionCard({ o, on, onPick }: { o: MatchOption; on: boolean; onPick: () => void }) {
  const am = o.leg === "AM";
  return (
    <button type="button" role="radio" aria-checked={on} className="r-opt" onClick={onPick}
            aria-label={`${o.route_code}, leaves ${o.pickup.name} at ${hm12(o.depart)}, arrives ${o.drop.name} at ${hm12(o.arrive)}, ${rupees(o.fare)} per ride`}>
      <div className="row between">
        <div className="row" style={{ gap: 8 }}><span className="r-radio" /><span className="pill route mono">{o.route_code}</span>
          {o.express && <span className="pill accent">Express</span>}</div>
        <span className="fare">{rupees(o.fare)}<span className="tiny muted" style={{ fontWeight: 500 }}> /ride</span></span>
      </div>
      <div className="times">{hm12(o.depart)} → {hm12(o.arrive)} <span className="small muted" style={{ fontWeight: 500 }}>· {o.ride_min} min</span></div>
      <div className="leg">
        <Icon.walk size={16} /><span><b>{o.pickup.name}</b> <span className="muted">· {walkText(o.walk_to_pickup_m)} {am ? "from home" : "from the office"}</span></span>
        <Icon.pin size={16} /><span><b>{o.drop.name}</b> <span className="muted">· {walkText(o.walk_from_drop_m)} {am ? "to the office" : "to home"}</span></span>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="pill">{o.vehicle}</span>
        {o.ac && <span className="pill good">AC</span>}
        <span className={`pill ${o.seats_left <= 3 ? "warn" : ""}`}>{o.seats_left} seat{o.seats_left === 1 ? "" : "s"} left</span>
      </div>
    </button>
  );
}

function NoRoute({ data }: { data: OptionsResponse }) {
  return (
    <>
      <div className="card stack" style={{ gap: 10 }}>
        <span className="pill accent" style={{ alignSelf: "flex-start" }}>On the waitlist</span>
        <h2>No route fits your commute yet</h2>
        <p className="small" style={{ margin: 0 }}>
          We've saved your commute to <b>{data.intent.office.label}</b>, arriving {windowLabel(data.intent.am_from, data.intent.am_to)}.
        </p>
        {data.similar_nearby != null && (
          <div className="banner good"><Icon.people /><div><b>{data.similar_nearby} people near you</b> want a similar trip. That's how new routes start.</div></div>
        )}
      </div>
      <div className="card stack">
        <h3>How a new route launches</h3>
        <ol className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          <li>Planners group commuters going the same way at about the same time.</li>
          <li>When enough people would fill a minibus, a route and stops are proposed and safety-checked.</li>
          <li>We tell you when it opens, with a seat to book.</li>
        </ol>
      </div>
      <div className="stack">
        <Link to="/rider/setup" className="btn alt block">Edit my commute</Link>
        <Link to="/rider" className="btn block">Done</Link>
        <p className="tiny muted" style={{ margin: 0 }}>Tip: a slightly earlier or later arrival, or a longer walk, may match an existing route.</p>
      </div>
    </>
  );
}

