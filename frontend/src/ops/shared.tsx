import { useMemo, useState, type ReactNode } from "react";
import { api, ApiError, usePoll } from "../api";
import type { ClockInfo, FleetView, OpsException } from "../types";
import { ErrorNote, Icon, Sheet, Spinner } from "../ui";

/** The control room's "today": the service day of the (possibly simulated) clock, plus the clock itself. */
export function useServiceDay() {
  const { data } = usePoll(() => api<ClockInfo>(null, "/clock"), 30000);
  const day = data ? data.now.slice(0, 10) : null;
  return { clock: data, day };
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="ops-head">
      <div className="stack" style={{ gap: 2 }}>
        <h1>{title}</h1>
        {sub && <div className="small muted">{sub}</div>}
      </div>
      {actions && <div className="row wrap" style={{ gap: 8 }}>{actions}</div>}
    </header>
  );
}

/** A KPI stat tile: the number is the chart. */
export function Kpi({ label, value, sub, tone, icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "warn" | "bad"; icon?: ReactNode }) {
  return (
    <div className={`card kpi${tone ? " kpi-" + tone : ""}`}>
      <div className="row between"><span className="lbl">{label}</span>{icon && <span className="kpi-icon">{icon}</span>}</div>
      <div className="kpi-v">{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

const SEV: Record<OpsException["severity"], { label: string; cls: string; icon: ReactNode }> = {
  critical: { label: "Critical", cls: "bad", icon: <Icon.sos size={14} /> },
  high: { label: "High", cls: "warn", icon: <Icon.alert size={14} /> },
  normal: { label: "Watch", cls: "", icon: <Icon.info size={14} /> },
};
export function SeverityPill({ severity }: { severity: OpsException["severity"] }) {
  const s = SEV[severity];
  return <span className={`pill ${s.cls}`}>{s.icon}{s.label}</span>;
}

export const KIND_LABEL: Record<string, string> = {
  sos: "SOS", breakdown: "Breakdown", delay: "Delay", unassigned: "No vehicle", no_driver: "No driver", document: "Documents",
  road_blocked: "Road blocked", misconduct: "Misconduct", other: "Other",
};

export const TRIP_STATUS: Record<string, { label: string; cls: string }> = {
  planned: { label: "Planned", cls: "" },
  in_progress: { label: "On the road", cls: "route" },
  completed: { label: "Completed", cls: "good" },
  cancelled: { label: "Cancelled", cls: "warn" },
};
export function TripStatus({ status }: { status: string }) {
  const s = TRIP_STATUS[status] ?? { label: status, cls: "" };
  return <span className={`pill ${s.cls}`}>{s.label}</span>;
}

export const seatsOf = (cls: string) => Number(/^(\d+)-seat/.exec(cls)?.[1] ?? 0);

/** Document expiry as a pill: expired / within 7 days / fine. */
export function DocDate({ iso, today }: { iso: string; today: string | null }) {
  const d = new Date(iso + "T00:00:00+05:30");
  const label = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: "Asia/Kolkata" });
  if (!today) return <span className="mono small nowrap">{label}</span>;
  const days = Math.round((d.getTime() - new Date(today + "T00:00:00+05:30").getTime()) / 86400000);
  if (days < 0) return <span className="pill bad" title={`Expired ${-days} days ago`}><Icon.x size={12} />Expired {label}</span>;
  if (days <= 7) return <span className="pill warn" title={`Expires in ${days} days`}><Icon.alert size={12} />{label}</span>;
  return <span className="mono small muted nowrap">{label}</span>;
}

export function Blocked({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return <span className="pill good"><Icon.check size={12} />OK</span>;
  return <span className="pill bad"><Icon.x size={12} />Blocked: {reasons.join(", ")}</span>;
}

/** Pick a vehicle to take over a trip. Blocked vehicles are shown, disabled, with the reason. */
export function VehiclePicker({ tripLabel, current, booked, date, onPick, onClose }: {
  tripLabel: string; current: string | null; booked: number; date?: string | null; onPick: (vehicleId: number) => Promise<void>; onClose: () => void;
}) {
  const fleet = usePoll(() => api<FleetView>("ops", "/ops/fleet", { query: { date } }), 0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const rows = useMemo(() => (fleet.data?.vehicles ?? []).filter((v) => v.reg_no !== current)
    .sort((a, b) => (a.blocked.length - b.blocked.length) || (a.seats - b.seats)), [fleet.data, current]);
  async function pick(id: number) {
    setBusy(id); setErr(null);
    try { await onPick(id); } catch (e) { setErr(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(null); }
  }
  return (
    <Sheet title={`Reassign ${tripLabel}`} onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>
        {booked} rider{booked === 1 ? "" : "s"} booked{current ? ` · now on ${current}` : ""}. The server checks documents, seats and
        clashes with the vehicle's other trips, and refuses a vehicle that can't make it.
      </p>
      {err && <ErrorNote error={err} />}
      {fleet.loading && !fleet.data ? <Spinner /> : fleet.error ? <ErrorNote error={fleet.error} onRetry={fleet.reload} /> : (
        <div className="list card flush picker">
          {rows.map((v) => {
            const tooSmall = v.seats < booked;
            const why = v.blocked.length ? `Blocked: ${v.blocked.join(", ")}` : tooSmall ? `Only ${v.seats} seats` : null;
            return (
              <button key={v.id} className="picker-row" disabled={!!why || busy !== null} onClick={() => pick(v.id)}>
                <span className="stack" style={{ gap: 0, alignItems: "flex-start" }}>
                  <span><b className="mono">{v.reg_no}</b> · {v.class}</span>
                  <span className="tiny muted">{v.depot} depot · {v.duties_today.length ? `${v.duties_today.length} dut${v.duties_today.length > 1 ? "ies" : "y"} that day` : "free all day"}</span>
                </span>
                {why ? <span className="pill bad">{why}</span> : busy === v.id ? <span className="spinner" /> : <span className="pill route">Use</span>}
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/** Pick a driver for a duty. Free, unblocked drivers first. */
export function DriverPicker({ dutyLabel, date, onPick, onClose }: { dutyLabel: string; date?: string | null; onPick: (driverId: number) => Promise<void>; onClose: () => void }) {
  const fleet = usePoll(() => api<FleetView>("ops", "/ops/fleet", { query: { date } }), 0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const rows = useMemo(() => (fleet.data?.drivers ?? []).slice().sort((a, b) =>
    (a.blocked.length - b.blocked.length) || (Number(!!a.duty_today) - Number(!!b.duty_today)) || a.name.localeCompare(b.name)), [fleet.data]);
  async function pick(id: number) {
    setBusy(id); setErr(null);
    try { await onPick(id); } catch (e) { setErr(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(null); }
  }
  return (
    <Sheet title={`Driver for ${dutyLabel}`} onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>The server refuses drivers with expired documents, on leave, or whose other duty would overlap or stretch the day past 12 hours.</p>
      {err && <ErrorNote error={err} />}
      {fleet.loading && !fleet.data ? <Spinner /> : (
        <div className="list card flush picker">
          {rows.map((d) => (
            <button key={d.id} className="picker-row" disabled={d.blocked.length > 0 || busy !== null} onClick={() => pick(d.id)}>
              <span className="stack" style={{ gap: 0, alignItems: "flex-start" }}>
                <b>{d.name}</b>
                <span className="tiny muted">{d.duty_today ? `On duty: ${d.duty_today.vehicle} (${blockName(d.duty_today.block)})` : "No duty that day"}
                  {d.rating ? ` · ★ ${d.rating.toFixed(1)}` : ""}</span>
              </span>
              {d.blocked.length ? <span className="pill bad">{d.blocked.join(", ")}</span>
                : busy === d.id ? <span className="spinner" /> : <span className={`pill ${d.duty_today ? "" : "route"}`}>{d.duty_today ? "Try" : "Assign"}</span>}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export const blockName = (b: string) => (b === "AM" ? "morning shift" : b === "PM" ? "evening shift" : "full day");
