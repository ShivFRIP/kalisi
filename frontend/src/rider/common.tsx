import { createContext, useContext } from "react";
import { hm12, metres } from "../fmt";
import type { RiderHome } from "../types";

/** Arrival windows (30 min) in the survey's label format. */
export const AM_WINDOWS: { from: string; to: string; label: string }[] = [
  ["07:00", "07:30"], ["07:30", "08:00"], ["08:00", "08:30"], ["08:30", "09:00"],
  ["09:00", "09:30"], ["09:30", "10:00"], ["10:00", "10:30"], ["10:30", "11:00"],
].map(([from, to]) => ({ from, to, label: `${short(from)}–${short(to)} AM` }));

/** Leaving windows (1 hour). */
export const PM_WINDOWS: { from: string; to: string; label: string }[] = [
  ["16:00", "17:00"], ["17:00", "18:00"], ["18:00", "19:00"], ["19:00", "20:00"], ["20:00", "21:00"],
].map(([from, to]) => ({ from, to, label: `${short(from)}–${short(to)} PM` }));

function short(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`;
}

export const WALK_CHOICES = [400, 600, 800, 1000];

/** "09:30","10:00" -> "9:30–10:00 AM"; mixed halves keep both suffixes. */
export function windowLabel(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const a = hm12(from), b = hm12(to);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

/** Walking distance in plain words. */
export const walkText = (m: number) => (m < 50 ? "right there" : `${metres(m)} walk`);

export const LEG_NAME: Record<string, string> = { AM: "To work", PM: "Home" };

/** Plain-English status for a leg or booking. */
export function legStatus(s: string): { text: string; tone: "good" | "warn" | "bad" | "route" | "" } {
  switch (s) {
    case "scheduled": case "confirmed": return { text: "Booked", tone: "route" };
    case "skipped": return { text: "Not joining", tone: "warn" };
    case "on_trip": return { text: "Bus on its way", tone: "good" };
    case "boarded": return { text: "On board", tone: "good" };
    case "completed": return { text: "Done", tone: "good" };
    case "no_show": return { text: "Missed", tone: "bad" };
    case "missed": return { text: "Missed", tone: "bad" };
    case "cancelled": return { text: "Cancelled", tone: "" };
    default: return { text: s.replace(/_/g, " "), tone: "" };
  }
}

export interface HomeCtx { home: RiderHome | null; error: string | null; reload: () => Promise<void>; }
export const HomeContext = createContext<HomeCtx>({ home: null, error: null, reload: async () => {} });
export const useHome = () => useContext(HomeContext);

/** Asks the browser for a position, giving up quietly after `ms`. */
export function currentPosition(ms = 5000): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    const t = window.setTimeout(() => resolve(null), ms);
    navigator.geolocation.getCurrentPosition(
      (p) => { window.clearTimeout(t); resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
      () => { window.clearTimeout(t); resolve(null); },
      { enableHighAccuracy: true, timeout: ms, maximumAge: 60000 },
    );
  });
}

export function Stars({ n }: { n: number }) {
  return <span className="r-mini-stars" aria-label={`${n} out of 5`}>{"★".repeat(n)}<span style={{ color: "var(--line)" }}>{"★".repeat(5 - n)}</span></span>;
}
