import { useEffect, useState } from "react";
import type { MapMarker } from "../MapView";
import type { LiveVehicle } from "../types";

export const stateText = (v: LiveVehicle) => v.state === "idle" ? (v.trip_status === "completed" ? "finished last trip" : "idle")
  : v.delay_min > 0.5 ? `${Math.round(v.delay_min)} min late` : "on time";

/** Vehicles as map markers: teal on time, red late (over 5 min), grey idle. The tooltip repeats the state in words. */
export function vehicleMarkers(vs: LiveVehicle[], onPick?: (v: LiveVehicle) => void): MapMarker[] {
  return vs.map((v) => ({
    lat: v.lat, lon: v.lon, heading: v.heading,
    kind: v.state === "late" ? "bus-late" : v.state === "idle" ? "bus-idle" : "bus",
    label: `${v.reg_no} · ${v.route_code ?? "no trip"} · ${stateText(v)}${v.state !== "idle" ? ` · ${v.boarded}/${v.seats} aboard` : ""}`,
    onClick: onPick && v.trip_id ? () => onPick(v) : undefined,
  }));
}

/** A fitKey that changes once after mount. Works around MapView remembering a fit made on the throwaway map that
 *  React StrictMode creates in development (the real map would otherwise never fit). Harmless in production. */
export function useFitKey(base: string | number | null | undefined): string | undefined {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  return base == null ? undefined : `${base}:${ready ? 1 : 0}`;
}

export function MapLegend() {
  return (
    <div className="legend small" aria-label="Legend">
      <span><i className="lg-bus" />On time</span>
      <span><i className="lg-bus late" />Late (over 5 min)</span>
      <span><i className="lg-bus idle" />Idle / between trips</span>
    </div>
  );
}
