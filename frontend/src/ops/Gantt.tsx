import { useMemo, useState, type CSSProperties } from "react";
import type { AllocationView } from "../types";
import { Icon } from "../ui";
import { blockName } from "./shared";

type Duty = AllocationView["duties"][number];
type Item = Duty["items"][number];

const START = 5 * 60, END = 23 * 60, SPAN = END - START;
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const pos = (hhmm: string) => Math.max(0, Math.min(100, ((toMin(hhmm) - START) / SPAN) * 100));
export const isLong = (it: Item) => toMin(it.end) - toMin(it.start) >= 35;   // same rule as the driver app

const KIND_TEXT: Record<string, string> = { check: "Pre-trip check", deadhead: "Empty run", break: "Break" };

/**
 * One row per duty (a driver's block on a vehicle). A split shift shows as two rows for the same vehicle.
 * Bars: long run (teal), short loop (amber), pre-trip check (grey), empty run (hatched), break (light).
 */
export function Gantt({ duties, now, onTrip, onAssign }: {
  duties: Duty[]; now: string | null; onTrip: (tripId: number, label: string) => void; onAssign: (d: Duty) => void;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const rows = useMemo(() => [...duties].sort((a, b) => a.vehicle.localeCompare(b.vehicle) || a.report.localeCompare(b.report)), [duties]);
  const hours = Array.from({ length: (END - START) / 60 + 1 }, (_, i) => 5 + i);
  const nowPos = now ? pos(now) : null;

  const show = (e: { clientX: number; clientY: number } | null, el: HTMLElement, text: string) => {
    const r = el.getBoundingClientRect();
    setTip({ x: e ? e.clientX : r.left + r.width / 2, y: e ? e.clientY : r.top, text });
  };

  return (
    <div className="gantt" onMouseLeave={() => setTip(null)}>
      <div className="g-head">
        <div className="g-label lbl">Vehicle · driver</div>
        <div className="g-track g-axis" aria-hidden="true">
          {hours.map((h) => <span key={h} className="g-tick" style={{ left: `${((h * 60 - START) / SPAN) * 100}%` }}>{h % 3 === 0 && h < 23 ? `${String(h).padStart(2, "0")}:00` : ""}</span>)}
        </div>
      </div>
      {rows.map((d, i) => {
        const sameVehicle = i > 0 && rows[i - 1].vehicle === d.vehicle;
        return (
          <div key={d.id} className={`g-row${sameVehicle ? " g-cont" : ""}`}>
            <div className="g-label">
              <div className="row" style={{ gap: 6 }}>
                <b className="mono">{d.vehicle}</b>
                {d.block !== "FULL" && <span className="pill accent" title="Split shift: two drivers share this vehicle's day">{d.block === "AM" ? "Morning" : "Evening"}</span>}
              </div>
              {d.driver ? <div className="tiny muted ellipsis">{d.driver} · {Math.round(d.worked_min / 60 * 10) / 10} h worked · {Math.round(d.spread_min / 60 * 10) / 10} h spread</div>
                : <button className="btn warm sm g-assign" onClick={() => onAssign(d)}><Icon.alert size={14} />No driver: assign</button>}
            </div>
            <div className="g-track" role="list" aria-label={`${d.vehicle} ${blockName(d.block)}, ${d.report} to ${d.sign_off}`}>
              {hours.map((h) => <span key={h} className="g-grid" style={{ left: `${((h * 60 - START) / SPAN) * 100}%` }} aria-hidden="true" />)}
              {d.items.map((it, k) => {
                const left = pos(it.start), width = Math.max(0.35, pos(it.end) - left);
                const style: CSSProperties = { left: `${left}%`, width: `${width}%` };
                if (it.kind === "trip" && it.trip_id != null) {
                  const long = isLong(it);
                  const text = `${it.route_code} · ${it.start}–${it.end} · ${it.booked ?? 0} booked · ${long ? "long run" : "short loop"}`;
                  return (
                    <button key={k} role="listitem" className={`g-bar g-trip ${long ? "long" : "short"}`} style={style} aria-label={text}
                            onMouseMove={(e) => show(e, e.currentTarget, text)} onFocus={(e) => show(null, e.currentTarget, text)} onBlur={() => setTip(null)}
                            onClick={() => onTrip(it.trip_id!, `${it.route_code} ${it.start}`)}>
                      <span className="g-txt">{width > 3 ? it.route_code : ""}</span>
                    </button>
                  );
                }
                const text = `${KIND_TEXT[it.kind] ?? it.kind} · ${it.start}–${it.end}${it.km ? ` · ${it.km} km` : ""}`;
                return <span key={k} role="listitem" className={`g-bar g-${it.kind}`} style={style} aria-label={text}
                             onMouseMove={(e) => show(e, e.currentTarget, text)} />;
              })}
              {nowPos != null && nowPos > 0 && nowPos < 100 && <span className="g-now" style={{ left: `${nowPos}%` }} aria-hidden="true" />}
            </div>
          </div>
        );
      })}
      {tip && <div className="g-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

export function GanttLegend() {
  return (
    <div className="legend small" aria-label="Legend">
      <span><i className="sw g-trip long" />Long run (35 min or more)</span>
      <span><i className="sw g-trip short" />Short loop</span>
      <span><i className="sw g-check" />Pre-trip check</span>
      <span><i className="sw g-deadhead" />Empty run</span>
      <span><i className="sw g-break" />Break</span>
      <span><i className="sw g-nowsw" />Now</span>
    </div>
  );
}
