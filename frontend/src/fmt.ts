const TZ = "Asia/Kolkata";

/** Rs 1,234 from paise. */
export const rupeesFromPaise = (p: number) => "₹" + Math.round(p / 100).toLocaleString("en-IN");
/** Rs 1,234 from whole rupees. */
export const rupees = (r: number) => "₹" + Math.round(r).toLocaleString("en-IN");

/** "08:30" -> "8:30 AM" */
export function hm12(hhmm: string | null | undefined): string {
  if (!hhmm) return "—";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** ISO instant -> "8:30 AM" in Hyderabad time. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ }).toUpperCase();
}

/** ISO range -> "8:41–8:44 AM" */
export function timeRange(fromIso: string, toIso: string): string {
  const a = clockTime(fromIso), b = clockTime(toIso);
  const [at, ap] = a.split(" "), [bt, bp] = b.split(" ");
  return ap === bp ? `${at}–${bt} ${bp}` : `${a}–${b}`;
}

/** "2026-10-28" -> "Wed 28 Oct" */
export function dayLabel(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00+05:30");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
}

export const minutesText = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
export const metres = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
export const tagLabel = (t: string) => t.replace(/_/g, " ").replace(/^ac /, "AC ").replace(/^\w/, (c) => c.toUpperCase());
export function newId(): string {
  try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
