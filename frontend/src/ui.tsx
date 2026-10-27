import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, usePoll } from "./api";
import { clockTime } from "./fmt";
import type { ClockInfo } from "./types";

// ---------------------------------------------------------------- icons (24px, stroke = currentColor)
const P = (d: ReactNode) => (p: { size?: number }) => (
  <svg width={p.size ?? 20} height={p.size ?? 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
export const Icon = {
  bus: P(<><rect x="4" y="3" width="16" height="15" rx="3" /><path d="M4 11h16M8 18v3M16 18v3" /><circle cx="8" cy="14.5" r=".8" fill="currentColor" /><circle cx="16" cy="14.5" r=".8" fill="currentColor" /></>),
  home: P(<><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></>),
  office: P(<><rect x="5" y="3" width="14" height="18" rx="1" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /></>),
  pin: P(<><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></>),
  clock: P(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  calendar: P(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>),
  wallet: P(<><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18" /><circle cx="16.5" cy="14.5" r="1" fill="currentColor" /></>),
  star: P(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z" />),
  check: P(<path d="m5 12 5 5 9-10" />),
  x: P(<path d="M6 6l12 12M18 6 6 18" />),
  back: P(<path d="m15 5-7 7 7 7" />),
  chevron: P(<path d="m9 5 7 7-7 7" />),
  info: P(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>),
  alert: P(<><path d="M12 3 2 20h20Z" /><path d="M12 10v5M12 17.5v.5" /></>),
  shield: P(<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6Z" />),
  sos: P(<><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16v.5" /></>),
  user: P(<><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>),
  logout: P(<><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4M6 12h10" /></>),
  map: P(<><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2Z" /><path d="M9 4v14M15 6v14" /></>),
  grid: P(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>),
  route: P(<><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" /></>),
  people: P(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2" /></>),
  hex: P(<path d="M12 2.5 20.5 7.3v9.4L12 21.5l-8.5-4.8V7.3Z" />),
  truck: P(<><rect x="2" y="6" width="13" height="11" rx="1" /><path d="M15 9h4l3 3v5h-7" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /></>),
  play: P(<path d="M7 4v16l13-8Z" />),
  stop: P(<rect x="6" y="6" width="12" height="12" rx="1" />),
  refresh: P(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>),
  gps: P(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="7" /></>),
  ac: P(<><path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9" /></>),
  walk: P(<><circle cx="13" cy="4" r="2" /><path d="m9 21 2-6 3 3v3M7 12l3-4 4 1 2 4M11 15l-1-5" /></>),
  download: P(<><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 21h16" /></>),
};

// ---------------------------------------------------------------- toast
const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 3200);
    return () => window.clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={setMsg}>
      {children}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- small components
export function Spinner({ label = "Loading" }: { label?: string }) {
  return <div className="row" style={{ justifyContent: "center", padding: 24 }} role="status"><div className="spinner" /><span className="sr-only">{label}</span></div>;
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="banner bad" role="alert"><Icon.alert /><div className="grow">{error}</div>
      {onRetry && <button className="btn ghost sm" onClick={onRetry}>Retry</button>}</div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

export function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return <button type="button" className="chip" aria-pressed={on} aria-label={label} onClick={onClick}>{children}</button>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key !== "Tab" || !box.current) return;          // keep Tab inside the dialog
      const f = box.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", k);
    return () => { window.removeEventListener("keydown", k); before?.focus?.(); };
  }, []);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={box} tabIndex={-1} className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon.x /></button></div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Runs an async action with a busy flag and shows errors as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

/** Amber strip shown whenever the system runs on the demo clock, so nobody mistakes simulated time for real time. */
export function DemoClock() {
  const { data } = usePoll(() => api<ClockInfo>(null, "/clock").then((c) => ({ ...c, fetched: Date.now() })), 10000);
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);
  if (!data || data.mode !== "sim") return null;
  const now = new Date(new Date(data.now).getTime() + (Date.now() - data.fetched) * data.speed).toISOString();
  return (
    <div className="demo-clock" role="note"><Icon.clock size={14} />
      Demo clock: {new Date(now).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })},{" "}
      {clockTime(now)}{data.speed !== 1 ? ` · ${data.speed}× speed` : ""}
    </div>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="row" style={{ gap: 6, alignItems: "baseline" }}>
      <span className="wordmark" lang="te" style={{ fontSize: size }}>కలిసి</span>
      <span style={{ fontFamily: "var(--f-display)", fontWeight: 700, fontSize: size * 0.8 }}>Kalisi</span>
    </span>
  );
}
