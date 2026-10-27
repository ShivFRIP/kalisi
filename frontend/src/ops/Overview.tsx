import { Link } from "react-router-dom";
import { api, usePoll } from "../api";
import { clockTime, dayLabel } from "../fmt";
import { MapView } from "../MapView";
import type { LiveVehicle, OpsException, Overview as OverviewData } from "../types";
import { ErrorNote, Icon, Spinner, useAction } from "../ui";
import { KIND_LABEL, Kpi, PageHead, SeverityPill } from "./shared";
import { MapLegend, useFitKey, vehicleMarkers } from "./mapbits";

/** Older servers used internal words ("PM block"); say it the way a duty manager would. */
const plain = (t: string) => t.replace("(AM block)", "(morning shift)").replace("(PM block)", "(evening shift)").replace("(FULL block)", "(full day)");
const pct = (v: number | null) => (v == null ? "—" : `${v}%`);

export function Overview() {
  const ov = usePoll(() => api<OverviewData>("ops", "/ops/overview"), 10000);
  const ex = usePoll(() => api<OpsException[]>("ops", "/ops/exceptions"), 10000);
  const live = usePoll(() => api<LiveVehicle[]>("ops", "/ops/live"), 10000);
  const o = ov.data;
  const fitKey = useFitKey(live.data ? "ok" : null);
  return (
    <>
      <PageHead title="Overview" sub={o ? <>{dayLabel(o.date)} · as of {clockTime(o.now)} · refreshes every 10 s</> : "Today's service at a glance"} />
      {ov.error && <ErrorNote error={ov.error} onRetry={ov.reload} />}
      {!o ? <Spinner /> : (
        <>
          <section className="grid cols-4" aria-label="Key figures">
            <Kpi label="Departures today" value={o.trips.scheduled} icon={<Icon.bus size={16} />}
                 sub={<>{o.trips.in_progress} on the road · {o.trips.completed} done{o.trips.cancelled_no_bookings ? ` · ${o.trips.cancelled_no_bookings} cancelled (nobody booked)` : ""}</>} />
            <Kpi label="Riders booked" value={o.riders.booked.toLocaleString("en-IN")} icon={<Icon.user size={16} />}
                 sub={<>{o.riders.boarded_or_done} boarded · {o.riders.no_show} no-shows · {o.riders.skipped_after_cutoff} late skips</>} />
            <Kpi label="On time" value={pct(o.on_time_pct)} icon={<Icon.clock size={16} />}
                 tone={o.on_time_pct == null ? undefined : o.on_time_pct >= 90 ? "good" : o.on_time_pct >= 75 ? "warn" : "bad"}
                 sub={o.on_time_pct == null ? "No trips finished yet today" : "Finished trips arriving within 5 min of schedule"} />
            <Kpi label="Seats filled" value={pct(o.load_factor_pct)} icon={<Icon.people size={16} />}
                 sub="Bookings ÷ seats on vehicles running today" />
          </section>
          <section className="grid kpi-row" aria-label="More figures">
            <Kpi label="Vehicles in service" value={<>{o.vehicles_in_service}<span className="kpi-of"> / {o.fleet}</span></>} />
            <Kpi label="Active passes" value={o.active_passes.toLocaleString("en-IN")} />
            <Kpi label="Waiting for a route" value={o.pooled_riders} sub={<Link to="/ops/network">Run the planner</Link>} />
            <Kpi label="Ratings today" value={o.ratings.count ? `${o.ratings.driver_avg?.toFixed(1)}` : "—"}
                 sub={o.ratings.count ? <>driver · vehicle {o.ratings.vehicle_avg?.toFixed(1)} · {o.ratings.count} ratings</> : "None yet today"} />
            <Kpi label="Running late now" value={o.delayed_now} tone={o.delayed_now ? "warn" : undefined} sub="More than 5 min behind" />
            <Kpi label="Open incidents" value={o.open_incidents} tone={o.open_incidents ? "bad" : undefined} sub={o.open_incidents ? "See below" : "None"} />
          </section>
        </>
      )}
      <div className="grid ov-split">
        <Exceptions list={ex.data} error={ex.error} reload={ex.reload} />
        <section className="card stack" aria-label="Vehicles now">
          <div className="row between"><h2>Vehicles now</h2><Link className="btn ghost sm" to="/ops/live">Open live map <Icon.chevron size={14} /></Link></div>
          <MapView className="map tall" markers={vehicleMarkers(live.data ?? [])} ariaLabel="Vehicle positions" fitKey={fitKey} />
          <MapLegend />
        </section>
      </div>
    </>
  );
}

function Exceptions({ list, error, reload }: { list: OpsException[] | null; error: string | null; reload: () => void }) {
  const { busy, run } = useAction();
  async function setStatus(id: number, status: "ack" | "closed") {
    await run(() => api("ops", `/ops/incidents/${id}/status`, { body: { status } }), status === "ack" ? "Incident acknowledged" : "Incident closed");
    reload();
  }
  return (
    <section className="card stack" aria-label="Exceptions">
      <div className="row between"><h2>Needs attention</h2>{list && <span className="small muted">{list.length} item{list.length === 1 ? "" : "s"}</span>}</div>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!list ? <Spinner /> : list.length === 0 ? <div className="empty"><Icon.check /> <div>Nothing needs attention.</div></div> : (
        <ul className="ex-list">
          {list.map((e, i) => (
            <li key={i} className={`ex ex-${e.severity}`}>
              <SeverityPill severity={e.severity} />
              <div className="grow stack" style={{ gap: 2 }}>
                <div className="row wrap" style={{ gap: 6 }}><b>{plain(e.title)}</b><span className="pill">{KIND_LABEL[e.kind] ?? e.kind}</span></div>
                {(e.detail || e.at) && <div className="small muted">{e.detail}{e.at ? ` · ${clockTime(e.at)}` : ""}</div>}
              </div>
              <div className="row" style={{ gap: 6, flex: "none" }}>
                {e.incident_id != null && <>
                  <button className="btn alt sm" disabled={busy} onClick={() => setStatus(e.incident_id!, "ack")}>Acknowledge</button>
                  <button className="btn sm" disabled={busy} onClick={() => setStatus(e.incident_id!, "closed")}>Close</button>
                </>}
                {e.trip_id != null && <Link className="btn alt sm" to={`/ops/live?trip=${e.trip_id}`}>Open trip</Link>}
                {e.kind === "no_driver" && <Link className="btn alt sm" to="/ops/allocation">Assign driver</Link>}
                {e.kind === "document" && <Link className="btn ghost sm" to="/ops/fleet">Fleet</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
