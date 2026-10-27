import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, usePoll } from "../api";
import { clockTime, timeRange } from "../fmt";
import { MapView, type MapLine, type MapMarker } from "../MapView";
import type { LiveVehicle, TripLive } from "../types";
import { Chip, ErrorNote, Icon, Spinner, useToast } from "../ui";
import { MapLegend, stateText, useFitKey, vehicleMarkers } from "./mapbits";
import { PageHead, TripStatus, VehiclePicker } from "./shared";

type Filter = "all" | "on_time" | "late" | "idle";

export function LiveMap() {
  const [params, setParams] = useSearchParams();
  const tripId = params.get("trip") ? Number(params.get("trip")) : null;
  const [filter, setFilter] = useState<Filter>("all");
  const live = usePoll(() => api<LiveVehicle[]>("ops", "/ops/live"), 5000);
  const all = live.data ?? [];
  const shown = useMemo(() => all.filter((v) => filter === "all" || v.state === filter), [all, filter]);
  const counts = { on_time: all.filter((v) => v.state === "on_time").length, late: all.filter((v) => v.state === "late").length, idle: all.filter((v) => v.state === "idle").length };
  const select = (id: number | null) => setParams(id ? { trip: String(id) } : {});
  const trip = usePoll(() => (tripId ? api<TripLive>("ops", `/ops/trips/${tripId}/live`) : Promise.resolve(null)), 5000, [tripId]);
  const selected = all.find((v) => v.trip_id === tripId) ?? null;
  const fitKey = useFitKey(tripId ? `t${tripId}${trip.data ? "" : "-"}` : live.data ? "all" : null);

  const lines: MapLine[] = trip.data ? [{ points: trip.data.stops.map((s) => [s.lat, s.lon] as [number, number]), weight: 4 }] : [];
  const stopMarkers: MapMarker[] = trip.data ? trip.data.stops.map((s) => ({ lat: s.lat, lon: s.lon, kind: "stop" as const, label: `${s.name} · ${s.passed ? "passed" : "ETA " + timeRange(s.eta_from, s.eta_to)}` })) : [];

  return (
    <>
      <PageHead title="Live map" sub={`${all.length} vehicles reporting · refreshes every 5 s`} actions={
        <div className="chips" role="group" aria-label="Show">
          <Chip on={filter === "all"} onClick={() => setFilter("all")}>All {all.length}</Chip>
          <Chip on={filter === "on_time"} onClick={() => setFilter("on_time")}>On time {counts.on_time}</Chip>
          <Chip on={filter === "late"} onClick={() => setFilter("late")}>Late {counts.late}</Chip>
          <Chip on={filter === "idle"} onClick={() => setFilter("idle")}>Idle {counts.idle}</Chip>
        </div>} />
      {live.error && <ErrorNote error={live.error} onRetry={live.reload} />}
      <div className="live-grid">
        <div className="stack">
          <MapView className="map live-map" markers={[...stopMarkers, ...vehicleMarkers(shown, (v) => select(v.trip_id))]} lines={lines}
                   fit={trip.data ? [...trip.data.stops.map((s) => [s.lat, s.lon] as [number, number]), ...(trip.data.position ? [[trip.data.position.lat, trip.data.position.lon] as [number, number]] : [])] : undefined}
                   fitKey={fitKey} ariaLabel="Live vehicle map" />
          <MapLegend />
        </div>
        <aside className="card live-side" aria-label={tripId ? "Trip details" : "Vehicles"}>
          {tripId ? <TripPanel id={tripId} data={trip.data} error={trip.error} vehicle={selected} onClose={() => select(null)} reload={() => { trip.reload(); live.reload(); }} />
            : <VehicleList vs={shown} onPick={(v) => v.trip_id && select(v.trip_id)} loading={live.loading && !live.data} />}
        </aside>
      </div>
    </>
  );
}

function VehicleList({ vs, onPick, loading }: { vs: LiveVehicle[]; onPick: (v: LiveVehicle) => void; loading: boolean }) {
  if (loading) return <Spinner />;
  const sorted = [...vs].sort((a, b) => ({ late: 0, on_time: 1, idle: 2 }[a.state] - { late: 0, on_time: 1, idle: 2 }[b.state]) || b.delay_min - a.delay_min);
  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="lbl" style={{ marginBottom: 6 }}>Vehicles · select one for its trip</div>
      {sorted.length === 0 && <div className="empty">No vehicles match this filter.</div>}
      <ul className="veh-list">
        {sorted.map((v) => (
          <li key={v.vehicle_id}>
            <button className="veh-row" onClick={() => onPick(v)} disabled={!v.trip_id}>
              <i className={`lg-bus ${v.state === "late" ? "late" : v.state === "idle" ? "idle" : ""}`} aria-hidden="true" />
              <span className="grow stack" style={{ gap: 0, alignItems: "flex-start" }}>
                <span><b className="mono">{v.reg_no}</b> {v.route_code && <span className="pill route">{v.route_code}</span>}</span>
                <span className="tiny muted">{v.class}</span>
              </span>
              <span className="stack" style={{ gap: 0, alignItems: "flex-end" }}>
                <span className={`small ${v.state === "late" ? "txt-bad" : ""}`}>{stateText(v)}</span>
                {v.state !== "idle" && <span className="tiny muted mono">{v.boarded}/{v.seats} aboard</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TripPanel({ id, data, error, vehicle, onClose, reload }: {
  id: number; data: TripLive | null; error: string | null; vehicle: LiveVehicle | null; onClose: () => void; reload: () => void;
}) {
  const toast = useToast();
  const [pick, setPick] = useState(false);
  if (error) return <ErrorNote error={error} />;
  if (!data || data.trip_id !== id) return <Spinner />;
  const late = data.delay_min > 5;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row between">
        <button className="btn ghost sm" onClick={onClose}><Icon.back size={16} />All vehicles</button>
        <TripStatus status={data.status} />
      </div>
      <div className="stack" style={{ gap: 2 }}>
        <h2><span className="pill route" style={{ fontSize: 14 }}>{data.route_code}</span> {data.route_name}</h2>
        <div className="small muted">Planned {clockTime(data.planned_start)}–{clockTime(data.planned_end)}</div>
      </div>
      <div className="grid cols-3 trip-facts">
        <div className="stat"><span className="k">Delay</span><span className={`v ${late ? "txt-bad" : ""}`}>{data.delay_min > 0.5 ? `${Math.round(data.delay_min)} min` : "On time"}</span></div>
        <div className="stat"><span className="k">Aboard</span><span className="v">{vehicle?.boarded ?? "—"}<span className="kpi-of">/{data.booked}</span></span></div>
        <div className="stat"><span className="k">Seats</span><span className="v">{data.vehicle?.seats ?? "—"}</span></div>
      </div>
      <div className="soft small">
        <div className="row between"><span className="muted">Vehicle</span><b className="mono">{data.vehicle?.reg_no ?? "None assigned"}</b></div>
        <div className="row between"><span className="muted">Type</span><span>{data.vehicle?.class ?? "—"}</span></div>
        <div className="row between"><span className="muted">Driver</span><span>{data.driver?.first_name ?? "—"}</span></div>
        {data.position && <div className="row between"><span className="muted">Last GPS</span><span>{clockTime(data.position.ts)} · {data.position.source === "app" ? "driver phone" : "simulated"}</span></div>}
      </div>
      {(data.status === "planned" || data.status === "in_progress") &&
        <button className="btn alt block" onClick={() => setPick(true)}><Icon.truck size={16} />Reassign trip to another vehicle</button>}
      <div className="lbl">Stops</div>
      <ol className="stops">
        {data.stops.map((s) => (
          <li key={s.seq} className={s.passed ? "passed" : ""}>
            <span className="dot" aria-hidden="true" />
            <span className="grow stack" style={{ gap: 0 }}>
              <span>{s.name}{s.action === "pickup" ? <span className="tiny muted"> · pick-up</span> : s.action === "drop" ? <span className="tiny muted"> · drop</span> : null}</span>
              <span className="tiny muted">Planned {clockTime(s.planned)}</span>
            </span>
            <span className="small" style={{ textAlign: "right" }}>{s.passed ? <span className="pill good"><Icon.check size={12} />Passed</span> : <>ETA <b>{timeRange(s.eta_from, s.eta_to)}</b></>}</span>
          </li>
        ))}
      </ol>
      {pick && <VehiclePicker tripLabel={`${data.route_code} ${clockTime(data.planned_start)}`} current={data.vehicle?.reg_no ?? null} booked={data.booked}
        onClose={() => setPick(false)}
        onPick={async (vid) => {
          const r = await api<{ to: string; duty_has_driver: boolean }>("ops", `/ops/trips/${id}/reassign`, { body: { vehicle_id: vid } });
          setPick(false);
          toast(`Trip moved to ${r.to}${r.duty_has_driver ? "" : ". That vehicle has no driver yet: assign one in Allocation"}`);
          reload();
        }} />}
    </div>
  );
}
