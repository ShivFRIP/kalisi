import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, usePoll } from "../api";
import { hm12, newId } from "../fmt";
import { MapView, type MapMarker } from "../MapView";
import type { DriverEvent, DriverStop, DriverTrip, EventResult, ManifestRider } from "../types";
import { ErrorNote, Icon, Sheet, Spinner, Switch, useToast } from "../ui";
import { BoardSheet } from "./BoardSheet";
import { SosButton, usePending } from "./common";
import { useGps } from "./gps";
import { departedSeqs, send, unconfirmed } from "./queue";
import { stillConfirmed, viewOf, waiting, type TripView } from "./state";
import { TRIP_STATUS } from "./Today";

type Action = Omit<DriverEvent, "client_event_id" | "trip_id" | "device_ts" | "lat" | "lon">;
interface Confirm { title: string; body: string; label: string; danger?: boolean; run: () => void; }

const STATUS_WORD: Record<string, string> = { confirmed: "Waiting", boarded: "On board", completed: "Dropped", no_show: "No-show" };
const STATUS_CLS: Record<string, string> = { confirmed: "", boarded: "good", completed: "good", no_show: "bad" };

function DelayPill({ t }: { t: TripView }) {
  if (t.status === "completed" || t.status === "cancelled") return null;
  const d = Math.round(t.delay_min);
  if (d <= 2) return <span className="pill good">On time</span>;
  return <span className={"pill " + (d > 10 ? "bad" : "warn")}>{t.status === "planned" ? `Start ${d} min late` : `${d} min late`}</span>;
}

function RiderRow({ r, canAct, noShowAllowed, onBoard, onNoShow, gettingOff }: {
  r: ManifestRider; canAct: boolean; noShowAllowed: boolean; onBoard: () => void; onNoShow: () => void; gettingOff?: boolean;
}) {
  return (
    <div className="drv-rider">
      <Icon.user />
      <span className="nm">{r.name}</span>
      {r.status === "confirmed" && canAct ? (
        <span className="row" style={{ gap: 8, flex: "none" }}>
          {noShowAllowed && <button className="btn alt drv-btn" onClick={onNoShow} aria-label={`Mark ${r.name} as no-show`}>No-show</button>}
          <button className="btn drv-btn" onClick={onBoard} aria-label={`Board ${r.name}`}><Icon.check /> Board</button>
        </span>
      ) : gettingOff ? (
        <span className="pill route">Getting off</span>
      ) : (
        <span className={"pill " + (STATUS_CLS[r.status] ?? "")}>{STATUS_WORD[r.status] ?? r.status}</span>
      )}
    </div>
  );
}

/** "Location sent 4 s ago": relative, so it reads right whether or not the demo clock is running. */
function LastSent({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  return <span style={s > 30 ? { color: "var(--warn)", fontWeight: 700 } : undefined}>
    Location sent {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`} ago{s > 30 ? ". Check signal." : ""}</span>;
}

function StopList({ t }: { t: TripView }) {
  return (
    <ol className="drv-stops" aria-label="All stops">
      {t.stops.map((s, i) => {
        const passed = t.phase === "done" || (s.arrived && t.departed.has(s.seq)) || (i < t.idx && t.status === "in_progress");
        const current = t.status === "in_progress" && i === t.idx;
        const up = s.board.length, down = s.alight.length;
        return (
          <li key={s.seq} className={passed ? "passed" : current ? "current" : ""} aria-current={current ? "step" : undefined}>
            <span className="mk">{passed && <Icon.check />}</span>
            <span className="stack" style={{ gap: 0, minWidth: 0 }}>
              <span className="nm ellipsis" style={{ fontWeight: 600 }}>{s.name}</span>
              <span className="tiny muted">{[up && `${up} pick-up`, down && `${down} drop`].filter(Boolean).join(" · ") || "No riders"}</span>
            </span>
            <span className="mono small">{hm12(s.planned)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function TripMap({ t, fix }: { t: TripView; fix: { lat: number; lon: number } | null }) {
  const markers = useMemo<MapMarker[]>(() => [
    ...t.stops.map((s, i) => ({ lat: s.lat, lon: s.lon, label: `${s.name} · ${hm12(s.planned)}`,
      kind: (t.status === "in_progress" && i === t.idx ? "stop-me" : "stop") as MapMarker["kind"] })),
    ...(fix ? [{ lat: fix.lat, lon: fix.lon, kind: "bus" as const, label: "You" }] : []),
  ], [t, fix]);
  const lines = useMemo(() => [{ points: t.stops.map((s) => [s.lat, s.lon] as [number, number]) }], [t.stops]);
  // Workaround: MapView keeps its "already fitted" flag across React StrictMode's dev remount, so the recreated map
  // never fits. Changing the key once after mount forces one fit on the live map. Harmless in production builds.
  const [settled, setSettled] = useState(0);
  useEffect(() => { const id = window.setTimeout(() => setSettled(1), 60); return () => window.clearTimeout(id); }, []);
  return <MapView className="map tall" markers={markers} lines={lines} fitKey={`${t.trip_id}:${settled}`} ariaLabel={`Map of ${t.route_code}`} />;
}

export function TripScreen() {
  const tripId = Number(useParams().id);
  const toast = useToast();
  usePending();   // re-render when queued events change
  const poll = usePoll(async () => {
    const t0 = Date.now();
    return { trip: await api<DriverTrip>("driver", `/driver/trips/${tripId}`), t0 };
  }, 5000, [tripId]);
  const view = poll.data ? viewOf(poll.data.trip, unconfirmed(tripId, poll.data.t0), departedSeqs(tripId)) : null;
  const gps = useGps(view);
  const [tab, setTab] = useState<"stops" | "map">("stops");
  const [mapOpened, setMapOpened] = useState(false);
  const [boarding, setBoarding] = useState<ManifestRider | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(a: Action, ok: string): Promise<EventResult | undefined> {
    setBusy(true);
    const ev: DriverEvent = { ...a, client_event_id: newId(), trip_id: tripId, device_ts: new Date().toISOString(),
                              lat: gps.fix?.lat, lon: gps.fix?.lon };
    const res = await send(ev);
    setBusy(false);
    if (!res) { setSaid(ok); toast(`${ok}. Saved on this phone; it will send when you have signal.`); }
    else if (res.status === "rejected") toast(res.reason || "Not accepted");
    else { setSaid(ok); toast(ok); }
    void poll.reload();
    return res;
  }

  if (!view) {
    return (
      <>
        <header className="topbar"><Link to="/driver" className="drv-iconbtn" aria-label="Back to today"><Icon.back /></Link><h1>Trip</h1></header>
        <main className="page">{poll.error ? <ErrorNote error={poll.error} onRetry={poll.reload} /> : <Spinner />}</main>
      </>
    );
  }
  const t = view;
  const stop: DriverStop | undefined = t.stops[t.idx];
  const last = t.stops[t.stops.length - 1];
  const onBus = t.stops.flatMap((s) => s.board).filter((r) => r.status === "boarded").length;
  const st = TRIP_STATUS[t.status] ?? { text: t.status, cls: "" };

  const boardRider = async (r: ManifestRider, code: string | undefined): Promise<string | null> => {
    const res = await act({ type: "board", booking_id: r.booking_id, code }, `${r.name} is on board`);
    if (res?.status === "rejected") return res.reason || "Not accepted";
    setBoarding(null);
    return null;
  };
  const noShow = (r: ManifestRider) => setConfirm({
    title: `${r.name} didn't come?`, body: "They will be marked as a no-show for this trip. Only do this after waiting at the stop.",
    label: "Mark no-show", danger: true, run: () => void act({ type: "no_show", booking_id: r.booking_id }, `${r.name} marked no-show`),
  });
  const depart = () => {
    const left = stop ? waiting(stop) : [];
    const go = () => void act({ type: "depart", stop_id: stop!.id, seq: stop!.seq }, `Left ${stop!.name}`);
    if (left.length) setConfirm({ title: "Leave this stop?", label: "Leave anyway",
      body: `${left.length} rider${left.length === 1 ? " hasn't" : "s haven't"} boarded (${left.map((r) => r.name).join(", ")}). They stay booked until the trip ends.`, run: go });
    else go();
  };
  const end = () => {
    const left = stillConfirmed(t);
    const go = () => void act({ type: "end" }, "Trip finished");
    if (left.length) setConfirm({ title: "End the trip?", label: "End trip", danger: true,
      body: `${left.length} rider${left.length === 1 ? " was" : "s were"} never boarded and will be marked as no-show.`, run: go });
    else go();
  };

  let panel: JSX.Element;
  if (t.phase === "cancelled") {
    panel = <div className="banner warn"><Icon.info /><div>This trip was cancelled because nobody booked it. Check your duty for the next trip.</div></div>;
  } else if (t.phase === "done") {
    const ns = t.stops.flatMap((s) => s.board).filter((r) => r.status === "no_show").length;
    panel = (
      <section className="card stack drv-now" style={{ gap: 12 }}>
        <span className="lbl">Trip finished</span>
        <span className="drv-stopname">{last.name}</span>
        <span className="drv-sub">{t.boarded} of {t.booked} riders travelled{ns ? ` · ${ns} no-show${ns === 1 ? "" : "s"}` : ""}.</span>
        <Link to="/driver" className="btn drv-big" style={{ textDecoration: "none" }}>Back to today's duty</Link>
      </section>
    );
  } else if (t.phase === "not_started" || t.simulated) {
    panel = (
      <section className="card stack drv-now" style={{ gap: 12 }}>
        <span className="lbl">{t.simulated ? "Next stop" : "First stop"}</span>
        <span className="drv-stopname">{(t.simulated ? stop ?? t.stops[0] : t.stops[0]).name}</span>
        <span className="drv-sub">{t.simulated ? `Due ${hm12((stop ?? t.stops[0]).planned)}` : `Leave at ${hm12(t.stops[0].planned)}`} · {t.booked} riders booked</span>
        {t.simulated && <div className="banner info"><Icon.info /><div>The demo simulator is moving this vehicle. Start to take over from this phone.</div></div>}
        <button className="btn drv-big" disabled={busy} onClick={() => act({ type: "start" }, "Trip started")}><Icon.play /> {t.simulated ? "Take over trip" : "Start trip"}</button>
      </section>
    );
  } else if (t.phase === "to_stop") {
    panel = (
      <section className="card stack drv-now" style={{ gap: 12 }}>
        <span className="lbl">{t.idx === t.stops.length - 1 ? "Last stop" : "Next stop"}</span>
        <span className="drv-stopname">{stop!.name}</span>
        <span className="row wrap drv-sub" style={{ gap: 14 }}>
          <span>Due {hm12(stop!.planned)}</span>
          {stop!.board.length > 0 && <span className="drv-count"><Icon.people /> {stop!.board.length} to pick up</span>}
          {stop!.alight.length > 0 && <span className="drv-count">{stop!.alight.length} getting off</span>}
        </span>
        <button className="btn drv-big" disabled={busy} onClick={() => act({ type: "arrive", stop_id: stop!.id, seq: stop!.seq }, `Arrived at ${stop!.name}`)}>
          <Icon.pin /> Arrived
        </button>
      </section>
    );
  } else {
    const atLast = t.phase === "at_last";
    const toBoard = stop!.board, getOff = stop!.alight.filter((r) => r.status === "boarded" || r.status === "completed");
    const pendingBoard = waiting(stop!).length;
    panel = (
      <section className="card stack drv-now" style={{ gap: 12 }}>
        <span className="lbl">{atLast ? "At the last stop" : "At stop"}</span>
        <span className="drv-stopname">{stop!.name}</span>
        {toBoard.length > 0 && (
          <div className="stack" style={{ gap: 0 }}>
            <span className="lbl">Pick up ({toBoard.filter((r) => r.status === "boarded" || r.status === "completed").length} of {toBoard.length} boarded)</span>
            {toBoard.map((r) => (
              <RiderRow key={r.booking_id} r={r} canAct noShowAllowed={stop!.no_show_allowed} onBoard={() => setBoarding(r)} onNoShow={() => noShow(r)} />
            ))}
            {pendingBoard > 0 && !stop!.no_show_allowed && <span className="small muted" style={{ paddingTop: 6 }}>Waiting for someone? The No-show button appears 2 minutes after you arrive.</span>}
          </div>
        )}
        {getOff.length > 0 && (
          <div className="stack" style={{ gap: 0 }}>
            <span className="lbl">Getting off here ({getOff.length})</span>
            {getOff.map((r) => <RiderRow key={r.booking_id} r={r} canAct={false} noShowAllowed={false} onBoard={() => {}} onNoShow={() => {}} gettingOff />)}
          </div>
        )}
        {toBoard.length === 0 && getOff.length === 0 && <span className="drv-sub">Nobody to pick up or drop here.</span>}
        {atLast
          ? <button className="btn drv-big" disabled={busy} onClick={end}><Icon.stop /> End trip</button>
          : <button className="btn drv-big" disabled={busy} onClick={depart}><Icon.bus /> Depart</button>}
      </section>
    );
  }

  return (
    <>
      <header className="topbar">
        <Link to="/driver" className="drv-iconbtn" aria-label="Back to today"><Icon.back /></Link>
        <div className="grow stack" style={{ gap: 0 }}>
          <h1 className="ellipsis">{t.route_code} · {t.route_name}</h1>
          <span className="tiny muted">{t.vehicle?.reg_no} · {t.vehicle?.class}</span>
        </div>
        <SosButton tripId={t.trip_id} fallback={gps.fix} />
      </header>
      <main className="page">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className={"pill " + st.cls}>{st.text}</span>
          <DelayPill t={t} />
          <span className="pill"><Icon.people size={13} /> {t.boarded} of {t.booked} boarded{t.status === "in_progress" && onBus !== t.boarded ? ` · ${onBus} on board now` : ""}</span>
        </div>
        <div className="sr-only" role="status" aria-live="polite">{said}</div>
        {panel}

        {t.phase !== "done" && t.phase !== "cancelled" && (
          <section className="card" aria-label="Location sharing">
            <div className="drv-loc">
              <Icon.gps />
              <span className="grow stack" style={{ gap: 0 }}><b>Share my location</b><span className="tiny muted">Riders see where you are. Sent every 5 seconds.</span></span>
              <Switch checked={gps.mode === "share"} onChange={(v) => gps.setMode(v ? "share" : "off")} label="Share my location" />
            </div>
            <div className="drv-loc">
              <Icon.route />
              <span className="grow stack" style={{ gap: 0 }}><b>Simulate GPS (testing)</b><span className="tiny muted">Moves along the stops without real GPS. For desk testing only.</span></span>
              <Switch checked={gps.mode === "simulate"} onChange={(v) => gps.setMode(v ? "simulate" : "off")} label="Simulate GPS for testing" />
            </div>
            {gps.mode !== "off" && (
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                {t.status !== "in_progress" ? "Location will be sent once the trip starts."
                  : gps.lastSent ? <LastSent at={gps.lastSent} /> : "Waiting for a location fix…"}
              </p>
            )}
            {gps.error && <div className="banner warn" style={{ marginTop: 8 }}><Icon.alert /><div>{gps.error}</div></div>}
          </section>
        )}

        <div className="drv-seg" role="tablist" aria-label="Trip details">
          <button role="tab" aria-selected={tab === "stops"} onClick={() => setTab("stops")}>Stops</button>
          <button role="tab" aria-selected={tab === "map"} onClick={() => { setTab("map"); setMapOpened(true); }}>Map</button>
        </div>
        <section className="card" role="tabpanel" hidden={tab !== "stops"}><StopList t={t} /></section>
        {mapOpened && <section role="tabpanel" aria-hidden={tab !== "map"} className={tab === "map" ? "" : "drv-offscreen"}><TripMap t={t} fix={gps.fix} /></section>}
      </main>

      {boarding && <BoardSheet rider={boarding} onClose={() => setBoarding(null)} onBoard={(code) => boardRider(boarding, code)} />}
      {confirm && (
        <Sheet title={confirm.title} onClose={() => setConfirm(null)}>
          <p style={{ margin: 0 }}>{confirm.body}</p>
          <button className={"btn drv-big " + (confirm.danger ? "danger" : "")} onClick={() => { const c = confirm; setConfirm(null); c.run(); }}>{confirm.label}</button>
          <button className="btn alt drv-btn" onClick={() => setConfirm(null)}>Go back</button>
        </Sheet>
      )}
    </>
  );
}
