import { useState } from "react";
import { api, usePoll } from "../api";
import { clockTime, timeRange } from "../fmt";
import type { FleetView } from "../types";
import { Chip, ErrorNote, Spinner } from "../ui";
import { Blocked, blockName, DocDate, PageHead, useServiceDay } from "./shared";

const DOCS: [string, string][] = [["permit", "Permit"], ["fitness", "Fitness"], ["insurance", "Insurance"], ["pollution", "Pollution (PUC)"]];

export function Fleet() {
  const { day } = useServiceDay();
  const f = usePoll(() => (day ? api<FleetView>("ops", "/ops/fleet", { query: { date: day } }) : Promise.resolve(null)), 30000, [day]);
  const [only, setOnly] = useState(false);
  const v = f.data;
  const vehicles = (v?.vehicles ?? []).filter((x) => !only || x.blocked.length || Object.values(x.documents).some((d) => soon(d, day)));
  const drivers = (v?.drivers ?? []).filter((x) => !only || x.blocked.length || soon(x.licence_valid_to, day));
  return (
    <>
      <PageHead title="Fleet" sub="Vehicles and drivers with expired documents are blocked automatically: allocation never assigns them."
        actions={<Chip on={only} onClick={() => setOnly(!only)}>Only problems</Chip>} />
      {f.error && <ErrorNote error={f.error} onRetry={f.reload} />}
      {!v ? <Spinner /> : (
        <>
          <section className="card stack" aria-label="Vehicles">
            <div className="row between"><h2>Vehicles</h2><span className="small muted">{v.vehicles.length} vehicles · {v.vehicles.filter((x) => x.blocked.length).length} blocked</span></div>
            <div className="scroll-x"><table className="table">
              <thead><tr>
                <th scope="col">Vehicle</th><th scope="col">Type</th><th scope="col">Operator · depot</th>
                {DOCS.map(([, l]) => <th scope="col" key={l}>{l}</th>)}<th scope="col">Can run?</th><th scope="col">Today</th>
              </tr></thead>
              <tbody>{vehicles.map((x) => (
                <tr key={x.id}>
                  <th scope="row" className="mono">{x.reg_no}</th>
                  <td className="small">{x.class}{!x.ac && <span className="pill" style={{ marginLeft: 4 }}>non-AC</span>}</td>
                  <td className="small">{x.operator}<div className="tiny muted">{x.depot}{x.status !== "active" ? ` · ${x.status}` : ""}</div></td>
                  {DOCS.map(([k]) => <td key={k}><DocDate iso={x.documents[k]} today={day} /></td>)}
                  <td><Blocked reasons={x.blocked} /></td>
                  <td className="tiny">{x.duties_today.length ? x.duties_today.map((d, i) => (
                    <div key={i} className="nowrap"><span className="muted">{d.block === "AM" ? "Morning" : d.block === "PM" ? "Evening" : "Full day"}</span> · {d.driver ?? <span className="txt-bad">no driver</span>} · {timeRange(d.report, d.sign_off)}</div>))
                    : <span className="muted">Not in service</span>}</td>
                </tr>))}</tbody>
            </table></div>
          </section>
          <section className="card stack" aria-label="Drivers">
            <div className="row between"><h2>Drivers</h2><span className="small muted">{v.drivers.length} drivers · {v.drivers.filter((x) => x.blocked.length).length} blocked</span></div>
            <div className="scroll-x"><table className="table">
              <thead><tr>
                <th scope="col">Driver</th><th scope="col">Phone</th><th scope="col">Operator</th><th scope="col">Licence valid to</th>
                <th scope="col">Rating</th><th scope="col">Can drive?</th><th scope="col">Today</th>
              </tr></thead>
              <tbody>{drivers.map((x) => (
                <tr key={x.id}>
                  <th scope="row">{x.name}</th>
                  <td className="mono small">{x.phone.replace(/^\+91/, "")}</td>
                  <td className="small">{x.operator || `Operator #${x.operator_id}`}</td>
                  <td><DocDate iso={x.licence_valid_to} today={day} /></td>
                  <td className="small">{x.rating != null ? <>★ {x.rating.toFixed(1)} <span className="muted">({x.ratings})</span></> : <span className="muted">No ratings</span>}</td>
                  <td><Blocked reasons={x.blocked} /></td>
                  <td className="tiny nowrap">{x.duty_today ? <><span className="mono">{x.duty_today.vehicle}</span> · {blockName(x.duty_today.block)} · reports {clockTime(x.duty_today.report)}</> : <span className="muted">Off today</span>}</td>
                </tr>))}</tbody>
            </table></div>
          </section>
        </>
      )}
    </>
  );
}

function soon(iso: string, today: string | null) {
  if (!today) return false;
  return (new Date(iso).getTime() - new Date(today).getTime()) / 86400000 <= 7;
}
