import { api, ApiError } from "../api";
import type { DriverEvent, EventResult } from "../types";

/**
 * Offline-first event queue. Every driver action becomes an event with a client-generated id, is saved to
 * localStorage first, then sent in a batch. Events the server answered (applied, duplicate or rejected) leave the
 * queue; events whose request failed (no signal, server down) stay and are retried. Because ids are generated on
 * the phone, resending a batch after a dropped connection can never double-count.
 *
 * GPS pings are not queued: a stale position is worse than none, so they are sent only while online.
 */
const KEY = "kalisi.driver.queue";
const DEPARTED_KEY = "kalisi.driver.departed";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode): the queue lives in memory for this page */
  }
}

let queue: DriverEvent[] = read<DriverEvent[]>(KEY, []);
const listeners = new Set<() => void>();
/** Events the server applied, with the time it answered; used to show them until a fresh fetch includes them. */
const recent: { ev: DriverEvent; at: number }[] = [];
let rejectedHandler: ((reason: string, ev: DriverEvent) => void) | null = null;
/** Events whose caller is awaiting the answer itself (so the global handler doesn't announce them twice). */
const awaited = new Set<string>();

function changed(): void {
  write(KEY, queue);
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { queue = read<DriverEvent[]>(KEY, []); l(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
}
export const pendingCount = () => queue.length;
export const pendingEvents = () => queue;
export function onRejected(h: ((reason: string, ev: DriverEvent) => void) | null): void { rejectedHandler = h; }

/** Pending events plus applied events newer than `since` (the start time of the data being displayed). */
export function unconfirmed(tripId: number, since: number): DriverEvent[] {
  const cutoff = Date.now() - 120_000;
  while (recent.length && recent[0].at < cutoff) recent.shift();
  return [...recent.filter((r) => r.at >= since).map((r) => r.ev), ...queue].filter((e) => e.trip_id === tripId);
}

interface FlushResult { results: Map<string, EventResult>; attempted: Set<string>; }
let inflight: Promise<FlushResult> | null = null;

/** Send everything queued. Returns the server's answer per event id. Safe to call often. */
export function flush(): Promise<FlushResult> {
  if (inflight) return inflight;
  inflight = (async (): Promise<FlushResult> => {
    const batch = queue.slice(0, 200);
    const results = new Map<string, EventResult>();
    const attempted = new Set(batch.map((e) => e.client_event_id));
    if (!batch.length) return { results, attempted };
    try {
      const r = await api<{ results: EventResult[] }>("driver", "/driver/events", { body: batch });
      const now = Date.now();
      for (const res of r.results) results.set(res.client_event_id, res);
      queue = queue.filter((e) => !results.has(e.client_event_id));
      for (const e of batch) {
        const res = results.get(e.client_event_id);
        if (res && res.status !== "rejected") recent.push({ ev: e, at: now });
        if (res?.status === "rejected" && !awaited.has(e.client_event_id)) rejectedHandler?.(res.reason || "The server refused this update", e);
      }
      changed();
    } catch (err) {
      // A 4xx for the whole batch means it can never succeed (e.g. malformed): drop it so the queue can't jam.
      // Network errors (status 0), 5xx, 401 (sign in again), 408 and 429 keep the events for a retry.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status)) {
        for (const e of batch) {
          results.set(e.client_event_id, { client_event_id: e.client_event_id, status: "rejected", reason: err.detail });
          if (!awaited.has(e.client_event_id)) rejectedHandler?.(err.detail, e);
        }
        queue = queue.filter((e) => !attempted.has(e.client_event_id));
        changed();
      }
    }
    return { results, attempted };
  })();
  return inflight.finally(() => { inflight = null; });
}

/**
 * Queue an event and try to send it now. Resolves with the server's answer, or undefined if it is waiting
 * for a connection (the UI should then treat it as done, optimistically).
 */
export async function send(ev: DriverEvent): Promise<EventResult | undefined> {
  if (ev.type === "depart" && ev.seq !== undefined) markDeparted(ev.trip_id, ev.seq);
  queue = [...queue, ev];
  changed();
  awaited.add(ev.client_event_id);
  try {
    for (let i = 0; i < 4; i++) {
      const { results, attempted } = await flush();
      const res = results.get(ev.client_event_id);
      if (res) return res;
      if (attempted.has(ev.client_event_id) || !queue.some((e) => e.client_event_id === ev.client_event_id)) return undefined;
    }
    return undefined;
  } finally {
    awaited.delete(ev.client_event_id);   // if it is still queued, a later background send announces any rejection
  }
}

/** GPS ping: sent directly, never queued. Returns true if the server stored it. */
export async function sendPing(ev: DriverEvent): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const r = await api<{ results: EventResult[] }>("driver", "/driver/events", { body: [ev] });
    return r.results[0]?.status === "applied";
  } catch {
    return false;
  }
}

// The API doesn't report departures per stop, so the phone remembers which stops it has left.
export function departedSeqs(tripId: number): Set<number> {
  return new Set(read<Record<string, number[]>>(DEPARTED_KEY, {})[String(tripId)] || []);
}
function markDeparted(tripId: number, seq: number): void {
  const all = read<Record<string, number[]>>(DEPARTED_KEY, {});
  const keys = Object.keys(all);
  if (keys.length > 30) delete all[keys[0]];   // keep the store small
  all[String(tripId)] = Array.from(new Set([...(all[String(tripId)] || []), seq]));
  write(DEPARTED_KEY, all);
}
