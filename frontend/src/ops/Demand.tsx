import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, usePoll } from "../api";
import { hm12 } from "../fmt";
import { MapView, type MapLine, type MapPolygon } from "../MapView";
import type { DemandView } from "../types";
import { ErrorNote, Icon, Spinner } from "../ui";
import { useFitKey } from "./mapbits";
import { PageHead } from "./shared";

/** One-hue sequential ramp (light -> dark teal), five classes. The first class is also the below-k class. */
const BINS = [
  { min: 1, max: 4, label: "1–4", color: "#C9E8E3" },
  { min: 5, max: 9, label: "5–9", color: "#8CCFC4" },
  { min: 10, max: 19, label: "10–19", color: "#4DB0A2" },
  { min: 20, max: 39, label: "20–39", color: "#16867A" },
  { min: 40, max: Infinity, label: "40+", color: "#0A5A52" },
];
const binOf = (n: number) => BINS.find((b) => n >= b.min && n <= b.max) ?? BINS[0];
const POOLED = "#C47A00";

type Hex = DemandView["hexes"][number];

export function Demand() {
  const d = usePoll(() => api<DemandView>("ops", "/ops/demand"), 60000);
  const [sel, setSel] = useState<string | null>(null);
  const hexes = d.data?.hexes ?? [];
  const polys: MapPolygon[] = useMemo(() => hexes.map((h) => ({
    points: h.boundary, color: binOf(h.total).color, opacity: 0.62, onClick: () => setSel(h.h3),
    label: `${h.total} rider${h.total === 1 ? "" : "s"}${h.pooled ? ` · ${h.pooled} waiting for a route` : ""} · mostly to ${h.top_campus}${h.below_k ? " · fewer than 5: internal only" : ""}`,
  })), [hexes]);
  const outlines: MapLine[] = useMemo(() => hexes.filter((h) => h.pooled > 0).map((h) => ({
    points: [...h.boundary, h.boundary[0]], color: POOLED, weight: 2.5,
  })), [hexes]);
  const s = hexes.find((h) => h.h3 === sel) ?? null;
  const fitKey = useFitKey(d.data ? "hexes" : null);
  const totals = useMemo(() => ({ riders: hexes.reduce((a, h) => a + h.total, 0), pooled: hexes.reduce((a, h) => a + h.pooled, 0),
    belowK: hexes.filter((h) => h.below_k).length }), [hexes]);

  return (
    <>
      <PageHead title="Demand" sub="Where riders live, by H3 hexagon (resolution 8, about 0.7 km²). Shading = riders who set up a commute; amber outline = some are still waiting for a route." />
      {d.error && <ErrorNote error={d.error} onRetry={d.reload} />}
      {!d.data ? <Spinner /> : (
        <div className="dem-grid">
          <section className="card stack" aria-label="Demand map">
            <MapView className="map dem-map" polygons={polys} lines={outlines} fitKey={fitKey} ariaLabel="Riders by home hexagon" />
            <div className="legend small" aria-label="Legend">
              <span className="lbl" style={{ marginRight: 4 }}>Riders per hexagon</span>
              {BINS.map((b) => <span key={b.label}><i className="sw" style={{ background: b.color }} />{b.label}</span>)}
              <span><i className="sw sw-ring" style={{ borderColor: POOLED }} />Riders waiting for a route</span>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              {hexes.length} hexagons · {totals.riders} riders · {totals.pooled} waiting. {totals.belowK} hexagons have fewer than {d.data.k} riders:
              fine for planning here, but never publish them outside the team (someone's home could be inferred). Roll them up first.
            </p>
          </section>
          <div className="stack" style={{ gap: 14 }}>
            <section className="card stack" aria-label="Selected hexagon">
              {s ? <HexDetail h={s} k={d.data.k} /> : <div className="small muted"><Icon.hex size={16} /> Select a hexagon on the map for its numbers.</div>}
            </section>
            <section className="card stack" aria-label="Waiting riders">
              <div className="row between"><h2>Waiting for a route</h2><Link className="btn ghost sm" to="/ops/network">Planner <Icon.chevron size={14} /></Link></div>
              <p className="tiny muted" style={{ margin: 0 }}>By office area and the start of their arrival window. The planner needs 6 riders in a group to propose a route.</p>
              {d.data.pooled_by_campus_time.length === 0 ? <div className="empty">Nobody is waiting: every rider has a route.</div> : (
                <table className="table">
                  <thead><tr><th scope="col">Office area</th><th scope="col">Arrive from</th><th scope="col">Riders</th></tr></thead>
                  <tbody>{d.data.pooled_by_campus_time.map((g, i) => (
                    <tr key={i}><td className="small">{g.campus}</td><td className="mono small">{hm12(g.arrive_from)}</td>
                      <td><span className="mono">{g.riders}</span> {g.riders >= 6 ? <span className="pill good">enough for a route</span> : null}</td></tr>))}</tbody>
                </table>
              )}
            </section>
          </div>
          <section className="card stack dem-table" aria-label="Busiest hexagons">
            <h2>Busiest hexagons</h2>
            <div className="scroll-x"><table className="table">
              <thead><tr><th scope="col">Hexagon (H3)</th><th scope="col">Riders</th><th scope="col">With a pass</th><th scope="col">Waiting</th><th scope="col">Mostly going to</th><th scope="col">Sharing</th></tr></thead>
              <tbody>{hexes.slice(0, 15).map((h) => (
                <tr key={h.h3} className={h.h3 === sel ? "row-sel" : ""} onClick={() => setSel(h.h3)}>
                  <td className="mono tiny">{h.h3}</td><td className="mono">{h.total}</td><td className="mono">{h.subscribed}</td>
                  <td className="mono">{h.pooled || "—"}</td><td className="small">{h.top_campus}</td>
                  <td>{h.below_k ? <span className="pill warn">internal only</span> : <span className="pill">OK to publish</span>}</td>
                </tr>))}</tbody>
            </table></div>
          </section>
        </div>
      )}
    </>
  );
}

function HexDetail({ h, k }: { h: Hex; k: number }) {
  return (
    <>
      <div className="row between"><h2>Hexagon</h2><span className="mono tiny muted">{h.h3}</span></div>
      <div className="grid cols-3">
        <div className="stat"><span className="v">{h.total}</span><span className="k">riders</span></div>
        <div className="stat"><span className="v">{h.subscribed}</span><span className="k">with a pass</span></div>
        <div className="stat"><span className={`v ${h.pooled ? "txt-warn" : ""}`}>{h.pooled}</span><span className="k">waiting</span></div>
      </div>
      <div className="small">Most go to <b>{h.top_campus}</b>.</div>
      {h.below_k && <div className="banner warn"><Icon.shield /><div>Fewer than {k} riders: keep this hexagon inside the team.</div></div>}
    </>
  );
}
