import { useEffect, useRef, useState } from "react";
import { newId } from "../fmt";
import { sendPing } from "./queue";
import type { TripView } from "./state";

export interface Fix { lat: number; lon: number; speed_kmh?: number; heading?: number; at: number; }
const PING_EVERY_MS = 5000;
const HEARTBEAT_MS = 15000;

function bearing(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function km(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

/**
 * Location for the current trip. "share" uses the phone's GPS; "simulate" moves a point along the stops for testing
 * at a desk (a 5-second step covers 15% of the way to the next stop). Pings go to the server at most every 5 seconds
 * (plus a 15-second heartbeat when stationary), only while the trip is in progress.
 */
export function useGps(trip: TripView | null) {
  const [mode, setMode] = useState<"off" | "share" | "simulate">("off");
  const [fix, setFix] = useState<Fix | null>(null);
  const [lastSent, setLastSent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastPing = useRef(0);
  const sim = useRef<{ idx: number; frac: number } | null>(null);
  const tripRef = useRef(trip);
  tripRef.current = trip;

  useEffect(() => {
    if (mode !== "share") return;
    if (!("geolocation" in navigator)) { setError("This phone can't share its location."); setMode("off"); return; }
    setError(null);
    let lastFixAt = 0;
    const id = navigator.geolocation.watchPosition(
      (p) => { lastFixAt = Date.now(); setError(null); setFix({ lat: p.coords.latitude, lon: p.coords.longitude, at: Date.now(),
                      speed_kmh: p.coords.speed != null ? Math.round(p.coords.speed * 36) / 10 : undefined,
                      heading: p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : undefined }); },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setError("Location permission was refused. Allow it in your browser settings, then switch this on again.");
          setMode("off");
        } else if (Date.now() - lastFixAt > 30_000) {
          setError("Can't get a location fix right now. Still trying.");   // only if the last good fix is stale
        }
      },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [mode]);

  useEffect(() => {
    if (mode !== "simulate") { sim.current = null; return; }
    setError(null);
    const step = () => {
      const t = tripRef.current;
      if (!t || !t.stops.length) return;
      const stops = t.stops.map((s) => [s.lat, s.lon] as [number, number]);
      const target = Math.min(t.idx, stops.length - 1);
      if (!sim.current || sim.current.idx !== target) sim.current = { idx: target, frac: 0 };
      const atStop = t.phase !== "to_stop" || target === 0;
      const from = stops[Math.max(0, target - 1)], to = stops[target];
      sim.current.frac = atStop ? 1 : Math.min(1, sim.current.frac + 0.15);
      const f = sim.current.frac;
      // No speed is reported: the simulation moves much faster than a real bus, and a fake speed would mislead.
      setFix({ lat: from[0] + (to[0] - from[0]) * f, lon: from[1] + (to[1] - from[1]) * f, at: Date.now(),
               heading: km(from, to) > 0.01 ? bearing(from, to) : undefined });
    };
    step();
    const id = window.setInterval(step, PING_EVERY_MS);
    return () => window.clearInterval(id);
  }, [mode]);

  // Sender: every second, send the newest fix if 5 s have passed since the last ping. A stationary vehicle (no new
  // fix) still sends a heartbeat every 15 s so the control room can tell "parked" from "lost signal".
  const fixRef = useRef<Fix | null>(null);
  fixRef.current = mode === "off" ? null : fix;
  useEffect(() => {
    if (mode === "off") return;
    let sentFixAt = 0;
    const id = window.setInterval(() => {
      const t = tripRef.current, f = fixRef.current, now = Date.now();
      if (!f || !t || t.status !== "in_progress") return;
      const fresh = f.at > sentFixAt;
      if (now - lastPing.current < PING_EVERY_MS - 250 || (!fresh && now - lastPing.current < HEARTBEAT_MS)) return;
      lastPing.current = now;
      sentFixAt = f.at;
      sendPing({ client_event_id: newId(), trip_id: t.trip_id, type: "ping", lat: f.lat, lon: f.lon,
                 speed_kmh: f.speed_kmh, heading: f.heading, device_ts: new Date(f.at).toISOString() })
        .then((ok) => { if (ok) setLastSent(Date.now()); });
    }, 1000);
    return () => window.clearInterval(id);
  }, [mode]);

  return { mode, setMode, fix: mode === "off" ? null : fix, lastSent, error };
}
