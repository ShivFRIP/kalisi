import { useEffect, useMemo, useState } from "react";
import { api, ApiError, usePoll } from "../api";
import { dayLabel } from "../fmt";
import type { AllocationSummary, AllocationView } from "../types";
import { Chip, ErrorNote, Icon, Sheet, Spinner, useToast } from "../ui";
import { Gantt, GanttLegend } from "./Gantt";
import { DriverPicker, PageHead, seatsOf, TripStatus, useServiceDay, VehiclePicker } from "./shared";

type TripRow = AllocationView["trips"][number];
type DutyRow = AllocationView["duties"][number];

function nextWeekday(iso: string): string {
  const d = new Date(iso + "T12:00:00+05:30");
  do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

export function Allocation() {
  const toast = useToast();
  const { clock, day: today } = useServiceDay();
  const [date, setDate] = useState<string | null>(null);
  useEffect(() => { if (!date && today) setDate(today); }, [today, date]);
  const view = usePoll(() => (date ? api<AllocationView>("ops", "/ops/allocation", { query: { date } }) : Promise.resolve(null)), 20000, [date]);
  const [confirm, setConfirm] = useState(false);
  const [summary, setSummary] = useState<AllocationSummary | null>(null);
  const [reassign, setReassign] = useState<{ id: number; label: string; vehicle: string | null; booked: number } | null>(null);
  const [assign, setAssign] = useState<DutyRow | null>(null);
  const [dir, setDir] = useState<"all" | "AM" | "PM">("all");

  const trips = useMemo(() => (view.data?.trips ?? []).filter((t) => dir === "all" || t.direction === dir), [view.data, dir]);
  const now = clock && date === today ? clock.now.slice(11, 16) : null;
  const v = view.data;
  const running = v ? v.trips.filter((t) => t.status !== "cancelled") : [];
  const started = running.some((t) => t.status === "in_progress" || t.status === "completed");

  return (
    <>
      <PageHead title="Allocation" sub="Each evening after the 8 PM cut-off, departures are matched to the right-sized vehicle and drivers' duties are built. You can re-run a day until its first trip starts."
        actions={<>
          <label className="row small" style={{ gap: 6 }}><span className="lbl">Service day</span>
            <input className="input date-in" type="date" value={date ?? ""} onChange={(e) => { setDate(e.target.value); setSummary(null); }} /></label>
          {today && date === today && <button className="btn alt sm" onClick={() => { setDate(nextWeekday(today)); setSummary(null); }}>Next service day</button>}
          <button className="btn" disabled={!date} onClick={() => setConfirm(true)}><Icon.refresh size={16} />Run allocation</button>
        </>} />

      {summary && <SummaryCard s={summary} onClose={() => setSummary(null)} />}
      {view.error && <ErrorNote error={view.error} onRetry={view.reload} />}
      {!v ? <Spinner /> : v.trips.length === 0 ? (
        <div className="card empty"><Icon.calendar /><p>Nothing allocated for {date ? dayLabel(date) : "this day"} yet.</p>
          <button className="btn" onClick={() => setConfirm(true)}>Run allocation for {date ? dayLabel(date) : "this day"}</button></div>
      ) : (
        <>
          <section className="card stack" aria-label="Duties">
            <div className="row between wrap">
              <div className="stack" style={{ gap: 0 }}><h2>Duties · {dayLabel(v.date)}</h2>
                <span className="small muted">{v.duties.length} duties on {new Set(v.duties.map((d) => d.vehicle)).size} vehicles ·{" "}
                  {v.duties.filter((d) => d.block !== "FULL").length / 2} split shifts · {v.duties.filter((d) => !d.driver).length} without a driver ·{" "}
                  {Math.round(v.duties.reduce((a, d) => a + d.deadhead_km, 0))} km empty running</span></div>
              <GanttLegend />
            </div>
            <div className="scroll-x"><Gantt duties={v.duties} now={now} onAssign={setAssign}
              onTrip={(id, label) => { const t = v.trips.find((x) => x.id === id); setReassign({ id, label, vehicle: t?.vehicle ?? null, booked: t?.booked ?? 0 }); }} /></div>
            <p className="tiny muted" style={{ margin: 0 }}>Select a trip bar to move it to another vehicle. Hover or focus a bar for its times.</p>
          </section>

          <section className="card stack" aria-label="Departures">
            <div className="row between wrap">
              <div className="stack" style={{ gap: 0 }}><h2>Departures</h2>
                <span className="small muted">{running.length} running · {v.trips.length - running.length} cancelled (nobody booked) ·{" "}
                  {running.filter((t) => t.seats < seatsOf(t.planned_class)).length} on a smaller vehicle than planned</span></div>
              <div className="chips" role="group" aria-label="Direction">
                <Chip on={dir === "all"} onClick={() => setDir("all")}>All</Chip>
                <Chip on={dir === "AM"} onClick={() => setDir("AM")}>To office</Chip>
                <Chip on={dir === "PM"} onClick={() => setDir("PM")}>Home</Chip>
              </div>
            </div>
            <div className="scroll-x">
              <table className="table">
                <thead><tr>
                  <th scope="col">Route</th><th scope="col">Time</th><th scope="col">Booked</th><th scope="col">Vehicle type</th>
                  <th scope="col">Vehicle</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {trips.map((t) => <TripRowView key={t.id} t={t} onReassign={() => setReassign({ id: t.id, label: `${t.route_code} ${t.start}`, vehicle: t.vehicle, booked: t.booked })} />)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {confirm && date && <RunSheet date={date} started={date === v?.date && started} onClose={() => setConfirm(false)}
        onDone={(s) => { setSummary(s); setConfirm(false); view.reload(); toast(`Allocation done for ${dayLabel(s.date)}`); }} />}
      {reassign && <VehiclePicker tripLabel={reassign.label} current={reassign.vehicle} booked={reassign.booked} date={date} onClose={() => setReassign(null)}
        onPick={async (vid) => {
          const r = await api<{ to: string; duty_has_driver: boolean }>("ops", `/ops/trips/${reassign.id}/reassign`, { body: { vehicle_id: vid } });
          setReassign(null); view.reload();
          toast(`${reassign.label} moved to ${r.to}${r.duty_has_driver ? "" : ": that vehicle needs a driver"}`);
        }} />}
      {assign && <DriverPicker dutyLabel={`${assign.vehicle} (${assign.block === "FULL" ? "full day" : assign.block === "AM" ? "morning" : "evening"}, ${assign.report}–${assign.sign_off})`}
        date={date} onClose={() => setAssign(null)}
        onPick={async (did) => {
          const r = await api<{ driver: string }>("ops", `/ops/duties/${assign.id}/driver`, { body: { driver_id: did } });
          setAssign(null); view.reload(); toast(`${r.driver} assigned to ${assign.vehicle}`);
        }} />}
    </>
  );
}

function TripRowView({ t, onReassign }: { t: TripRow; onReassign: () => void }) {
  const planned = seatsOf(t.planned_class);
  const smaller = t.status !== "cancelled" && t.seats < planned;
  const bigger = t.status !== "cancelled" && t.seats > planned;
  return (
    <tr className={t.status === "cancelled" ? "row-dim" : ""}>
      <td><span className="pill route">{t.route_code}</span> <span className="small">{t.route_name}</span></td>
      <td className="mono small">{t.start}–{t.end}</td>
      <td className="mono">{t.booked}<span className="muted">/{t.status === "cancelled" ? "—" : t.seats}</span></td>
      <td className="small">{t.status === "cancelled" ? <span className="muted">Not running</span> : t.class}
        {smaller && <div><span className="pill good" title={`Planned: ${t.planned_class}`}>Right-sized from {planned} seats</span></div>}
        {bigger && <div><span className="pill" title={`Planned: ${t.planned_class}`}>Larger than planned ({planned})</span></div>}</td>
      <td className="mono small">{t.vehicle ?? (t.status === "cancelled" ? "—" : <span className="pill bad">None</span>)}</td>
      <td><TripStatus status={t.status} /></td>
      <td>{(t.status === "planned" || t.status === "in_progress") && <button className="btn ghost sm" onClick={onReassign}>Reassign</button>}</td>
    </tr>
  );
}

function RunSheet({ date, started, onClose, onDone }: { date: string; started: boolean; onClose: () => void; onDone: (s: AllocationSummary) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try { onDone(await api<AllocationSummary>("ops", "/ops/allocation/run", { body: { date } })); }
    catch (e) { setErr(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(false); }
  }
  return (
    <Sheet title={`Run allocation for ${dayLabel(date)}?`} onClose={onClose}>
      <p style={{ margin: 0 }}>This rebuilds that day from scratch:</p>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Bookings are recounted from active passes, minus riders who said they're not joining.</li>
        <li>Each departure gets the smallest suitable vehicle; departures nobody booked are cancelled.</li>
        <li>Vehicles are chained across trips and drivers' duties rebuilt. Manual reassignments and driver changes for that day are lost.</li>
      </ul>
      {started && !err && <div className="banner warn"><Icon.alert /><div>Some trips on this day have already started, so the server will refuse. Use <b>Reassign</b> on individual trips instead.</div></div>}
      {err && <div className="banner bad" role="alert"><Icon.alert /><div><b>Not run.</b> {err}</div></div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn alt" onClick={onClose}>{err ? "Close" : "Cancel"}</button>
        {!err && <button className="btn" disabled={busy} onClick={go}>{busy ? "Running… (up to 10 s)" : "Run allocation"}</button>}
      </div>
    </Sheet>
  );
}

function SummaryCard({ s, onClose }: { s: AllocationSummary; onClose: () => void }) {
  const blockedV = Object.entries(s.vehicles_blocked), blockedD = Object.entries(s.drivers_blocked);
  return (
    <section className="card stack summary" aria-label="Allocation result">
      <div className="row between"><h2><Icon.check size={18} /> Allocation for {dayLabel(s.date)}</h2>
        <button className="btn ghost sm" onClick={onClose} aria-label="Dismiss"><Icon.x size={16} /></button></div>
      <div className="grid sum-grid">
        <div className="stat"><span className="v">{s.departures_running}</span><span className="k">departures running</span></div>
        <div className="stat"><span className="v">{s.departures_cancelled_no_bookings}</span><span className="k">cancelled, nobody booked</span></div>
        <div className="stat"><span className="v">{s.bookings}</span><span className="k">bookings · {s.seats_offered} seats</span></div>
        <div className="stat"><span className="v">{s.load_factor_pct}%</span><span className="k">seats filled</span></div>
        <div className="stat"><span className="v">{s.downsized}</span><span className="k">on a smaller vehicle</span></div>
        <div className="stat"><span className="v">{s.vehicles_used}<span className="kpi-of">/{s.fleet_size}</span></span><span className="k">vehicles used</span></div>
        <div className="stat"><span className="v">{s.split_duties}</span><span className="k">split shifts</span></div>
        <div className="stat"><span className={`v ${s.duties_without_driver ? "txt-bad" : ""}`}>{s.duties_without_driver}</span><span className="k">duties without a driver</span></div>
        <div className="stat"><span className="v">{Math.round(s.deadhead_km)}</span><span className="k">km empty running</span></div>
      </div>
      {(s.unassigned_departures.length > 0 || s.overflow_departures.length > 0) && <div className="banner bad"><Icon.alert /><div>
        {s.unassigned_departures.length > 0 && <div>No vehicle could take: {s.unassigned_departures.join(", ")}.</div>}
        {s.overflow_departures.length > 0 && <div>More bookings than the largest vehicle: {s.overflow_departures.join(", ")}.</div>}</div></div>}
      {(blockedV.length > 0 || blockedD.length > 0) && <div className="banner warn"><Icon.shield /><div>
        <b>Kept off the road:</b>{" "}
        {[...blockedV.map(([k, r]) => `${k} (${r.join(", ")})`), ...blockedD.map(([k, r]) => `${k.replace(/ \(#\d+\)$/, "")} (${r.join(", ")})`)].join(" · ")}</div></div>}
    </section>
  );
}
