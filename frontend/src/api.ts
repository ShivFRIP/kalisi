import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "./types";

export type AppKind = "rider" | "driver" | "ops";
export interface Session { token: string; user: User; }

const key = (app: AppKind) => `kalisi.session.${app}`;

export function getSession(app: AppKind): Session | null {
  try {
    const raw = localStorage.getItem(key(app));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(app: AppKind, s: Session | null): void {
  try {
    if (s) localStorage.setItem(key(app), JSON.stringify(s));
    else localStorage.removeItem(key(app));
  } catch {
    /* private mode: the session lasts for this page only */
  }
  window.dispatchEvent(new CustomEvent("kalisi:session", { detail: app }));
}

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** Calls the Kalisi API as the signed-in user of `app`. Throws ApiError with the server's message. */
export async function api<T>(app: AppKind | null, path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  const qs = opts.query
    ? "?" + Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
    : "";
  const headers: Record<string, string> = {};
  const s = app ? getSession(app) : null;
  if (s) headers.Authorization = `Bearer ${s.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs}`, { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, "No connection. Check your internet and try again.");
  }
  if (res.status === 401 && app) setSession(app, null);
  if (!res.ok) {
    let detail = `Something went wrong (${res.status})`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") detail = j.detail;
      else if (Array.isArray(j.detail) && j.detail[0]?.msg) detail = j.detail.map((d: { msg: string }) => d.msg).join("; ");
    } catch { /* not JSON */ }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** Load data and keep it fresh. `ms` = polling interval (0 = load once). */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(async () => {
    try {
      const d = await loader.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    reload();
    if (!ms) return;
    const id = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, ms);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, reload, ...deps]);
  return { data, error, loading, reload, setData };
}

/** Re-render when this app's session changes (sign-in, sign-out, expiry). */
export function useSession(app: AppKind): Session | null {
  const [s, setS] = useState(() => getSession(app));
  useEffect(() => {
    const on = () => setS(getSession(app));
    window.addEventListener("kalisi:session", on);
    window.addEventListener("storage", on);
    return () => { window.removeEventListener("kalisi:session", on); window.removeEventListener("storage", on); };
  }, [app]);
  return s;
}
