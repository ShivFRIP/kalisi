import type { DriverEvent, DriverStop, DriverTrip, ManifestRider } from "../types";

export type Phase = "not_started" | "to_stop" | "at_stop" | "at_last" | "done" | "cancelled";
export interface TripView extends DriverTrip {
  phase: Phase;
  /** Index into stops of the stop the driver is heading to or standing at. */
  idx: number;
  departed: Set<number>;
  /** True if the simulator was moving this trip and the phone hasn't taken over yet. */
  simulated: boolean;
}

function setRider(list: ManifestRider[], bookingId: number, status: string): boolean {
  const r = list.find((x) => x.booking_id === bookingId);
  if (r && r.status === "confirmed") { r.status = status; return true; }
  return false;
}

/** Server state + events the server hasn't reflected yet (queued offline, or applied after this fetch began). */
export function viewOf(server: DriverTrip, unconfirmed: DriverEvent[], departedLocal: Set<number>): TripView {
  const t: DriverTrip = { ...server, stops: server.stops.map((s) => ({ ...s, board: s.board.map((r) => ({ ...r })), alight: s.alight.map((r) => ({ ...r })) })) };
  const departed = new Set(departedLocal);
  for (const s of t.stops) if (s.departed) departed.add(s.seq);   // reported by the server from 'depart' events
  for (const e of unconfirmed) {
    if (e.type === "start" && (t.status === "planned" || t.status === "in_progress")) { t.status = "in_progress"; t.gps_source = "app"; }
    if ((e.type === "arrive" || e.type === "depart") && e.seq !== undefined) {
      const s = t.stops.find((x) => x.seq === e.seq);
      if (s) s.arrived = true;
      if (e.type === "depart") departed.add(e.seq);
    }
    if ((e.type === "board" || e.type === "no_show") && e.booking_id) {
      for (const s of t.stops) {
        if (setRider(s.board, e.booking_id, e.type === "board" ? "boarded" : "no_show") && e.type === "board") t.boarded += 1;
        setRider(s.alight, e.booking_id, e.type === "board" ? "boarded" : "no_show");
      }
    }
    if (e.type === "end") {
      t.status = "completed";
      for (const s of t.stops) for (const r of [...s.board, ...s.alight]) r.status = r.status === "boarded" ? "completed" : r.status === "confirmed" ? "no_show" : r.status;
    }
  }
  // A stop counts as left if the phone sent 'depart', or the vehicle has since arrived somewhere later.
  let laterArrived = false;
  for (let i = t.stops.length - 1; i >= 0; i--) {
    if (laterArrived) departed.add(t.stops[i].seq);
    if (t.stops[i].arrived) laterArrived = true;
  }
  let phase: Phase, idx = 0;
  if (t.status === "cancelled") phase = "cancelled";
  else if (t.status === "completed") { phase = "done"; idx = t.stops.length - 1; }
  else if (t.status !== "in_progress") phase = "not_started";
  else {
    idx = t.stops.findIndex((s) => !(s.arrived && departed.has(s.seq)));
    if (idx < 0) idx = t.stops.length - 1;
    const s = t.stops[idx];
    phase = !s.arrived ? "to_stop" : idx === t.stops.length - 1 ? "at_last" : "at_stop";
  }
  return { ...t, phase, idx, departed, simulated: server.status === "in_progress" && server.gps_source === "sim" && !unconfirmed.some((e) => e.type === "start") };
}

export const waiting = (s: DriverStop) => s.board.filter((r) => r.status === "confirmed");
export const stillConfirmed = (t: DriverTrip) => t.stops.flatMap((s) => s.board).filter((r) => r.status === "confirmed");
