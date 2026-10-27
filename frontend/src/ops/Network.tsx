import { useEffect, useMemo, useState } from "react";
import { api, ApiError, usePoll } from "../api";
import { hm12 } from "../fmt";
import { MapView, type MapMarker } from "../MapView";
import type { PlannerResult, RouteView } from "../types";
import { ErrorNote, Icon, Sheet, Spinner, useToast } from "../ui";
import { useFitKey } from "./mapbits";
import { PageHead } from "./shared";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const daysText = (mask: number) => {
  const d = DAYS.filter((_, i) => mask & (1 << i));
  return d.length === 5 && !(mask & 0b1100000) ? "Mon–Fri" : d.join(", ");
};
const dirText = (d: string) => (d === "AM" ? "To office" : d === "PM" ? "Home" : d);

export function Network() {
  const toast = useToast();
  const routes = usePoll(() => api<RouteView[]>("ops", "/ops/routes"), 0);
  const [tab, setTab] = useState<"live" | "proposed">("live");
  const [sel, setSel] = useState<number | null>(null);
  const [plan, setPlan] = useState<PlannerResult | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [retire, setRetire] = useState<RouteView | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => (routes.data ?? []).filter((r) => r.status === tab), [routes.data, tab]);
  const counts = { live: (routes.data ?? []).filter((r) => r.status === "live").length, proposed: (routes.data ?? []).filter((r) => r.status === "proposed").length };
  const route = (routes.data ?? []).find((r) => r.id === sel) ?? null;
  useEffect(() => { if (routes.data && (!route || route.status !== tab) && list.length) setSel(list[0].id); }, [routes.data, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runPlanner() {
    setPlanning(true); setPlanErr(null);
    try {
      const r = await api<PlannerResult>("ops", "/ops/planner/run", { method: "POST" });
      setPlan(r); await routes.reload(); setTab("proposed");
    } catch (e) { setPlanErr(e instanceof ApiError ? e.detail : String(e)); } finally { setPlanning(false); }
  }
  async function publish(id: number) {
    setBusy(true);
    try {
      const r = await api<{ published: string[]; pooled_riders_now_matched: number }>("ops", `/ops/routes/${id}/publish`, { method: "POST" });
      toast(`${r.published.join(" + ")} is live. ${r.pooled_riders_now_matched} waiting rider${r.pooled_riders_now_matched === 1 ? "" : "s"} now have a route.`);
      setPlan((p) => p && { ...p, proposals: p.proposals.filter((x) => !r.published.includes(x.code)) });
      await routes.reload();
      setTab("live"); setSel(id);
    } catch (e) { toast(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(false); }
  }
  async function doRetire(r: RouteView) {
    setBusy(true);
    try { await api("ops", `/ops/routes/${r.id}/retire`, { method: "POST" }); toast(`${r.code} retired`); setRetire(null); setSel(null); await routes.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="Network" sub="Live routes and planner proposals. Proposals are drafts until you publish them; new stops need a safety audit before use."
        actions={<button className="btn warm" disabled={planning} onClick={runPlanner}><Icon.route size={16} />{planning ? "Planning… (a few seconds)" : "Run planner"}</button>} />
      {planErr && <ErrorNote error={planErr} />}
      {plan && <PlannerCard plan={plan} routes={routes.data ?? []} busy={busy} onPublish={publish} onShow={(id) => { setTab("proposed"); setSel(id); }} onClose={() => setPlan(null)} />}
      {routes.error && <ErrorNote error={routes.error} onRetry={routes.reload} />}
      <div className="net-grid">
        <section className="card flush" aria-label="Routes">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "live"} onClick={() => setTab("live")}>Live <span className="pill">{counts.live}</span></button>
            <button role="tab" aria-selected={tab === "proposed"} onClick={() => setTab("proposed")}>Proposed <span className="pill accent">{counts.proposed}</span></button>
          </div>
          {!routes.data ? <Spinner /> : list.length === 0 ? <div className="empty">{tab === "proposed" ? "No proposals. Run the planner to draft routes for riders who are waiting." : "No live routes."}</div> : (
            <ul className="route-list">
              {list.map((r) => (
                <li key={r.id}>
                  <button className={`route-row${r.id === sel ? " on" : ""}`} aria-current={r.id === sel} onClick={() => setSel(r.id)}>
                    <span className={`pill ${r.status === "proposed" ? "accent" : "route"}`}>{r.code}</span>
                    <span className="grow stack" style={{ gap: 0, alignItems: "flex-start" }}>
                      <span className="small ellipsis" style={{ maxWidth: "100%" }}>{r.name}</span>
                      <span className="tiny muted">{dirText(r.direction)} · {r.departures.length} departure{r.departures.length === 1 ? "" : "s"} · {r.stops.length} stops{r.express ? " · express" : ""}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {route ? <RouteDetail r={route} busy={busy} onPublish={() => publish(route.id)} onRetire={() => setRetire(route)} /> : <div className="card empty">Select a route.</div>}
      </div>
      {retire && <Sheet title={`Retire ${retire.code}?`} onClose={() => setRetire(null)}>
        <p style={{ margin: 0 }}>{retire.name} stops appearing in matches and won't be allocated from tomorrow's run. Riders with passes on it keep their passes until you contact them; plan replacement service first.</p>
        <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn alt" onClick={() => setRetire(null)}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={() => doRetire(retire)}>Retire route</button></div>
      </Sheet>}
    </>
  );
}

function RouteDetail({ r, busy, onPublish, onRetire }: { r: RouteView; busy: boolean; onPublish: () => void; onRetire: () => void }) {
  const markers: MapMarker[] = r.stops.map((s, i) => ({ lat: s.lat, lon: s.lon, kind: s.kind === "proposed" ? "stop-proposed" : i === 0 ? "stop-me" : "stop",
    label: `${s.name} · +${s.offset_min} min · ${s.action === "pickup" ? "pick-up" : s.action === "drop" ? "drop" : "pick-up and drop"}${s.audited ? "" : " · needs safety audit"}` }));
  const unaudited = r.stops.filter((s) => !s.audited).length;
  const fitKey = useFitKey(r.id);
  const sold = r.departures.reduce((a, d) => a + d.sold, 0), seats = r.departures.reduce((a, d) => a + d.seats, 0);
  return (
    <section className="card stack" aria-label={`Route ${r.code}`}>
      <div className="row between wrap">
        <div className="stack" style={{ gap: 2 }}>
          <h2><span className={`pill ${r.status === "proposed" ? "accent" : "route"}`} style={{ fontSize: 14 }}>{r.code}</span> {r.name}</h2>
          <span className="small muted">{dirText(r.direction)}{r.campus ? ` · ${r.campus}` : ""}{r.express ? " · express (limited stops)" : ""} · {sold}/{seats} seats sold across departures</span>
        </div>
        {r.status === "proposed" ? <button className="btn" disabled={busy} onClick={onPublish}><Icon.check size={16} />Publish route</button>
          : <button className="btn alt sm" onClick={onRetire}>Retire</button>}
      </div>
      {r.notes && <div className="banner info"><Icon.info /><div>{r.notes}</div></div>}
      {unaudited > 0 && <div className="banner warn"><Icon.shield /><div>{unaudited} stop{unaudited === 1 ? "" : "s"} need{unaudited === 1 ? "s" : ""} a field safety audit (lighting, footpath, a safe place to stop) before riders use {unaudited === 1 ? "it" : "them"}.</div></div>}
      <div className="net-detail">
        <MapView className="map tall" markers={markers} lines={[{ points: r.stops.map((s) => [s.lat, s.lon] as [number, number]), dashed: r.status === "proposed", color: r.status === "proposed" ? "#C47A00" : undefined }]}
                 fitKey={fitKey} ariaLabel={`Map of route ${r.code}`} />
        <div className="stack">
          <div className="lbl">Stops</div>
          <ol className="stops compact">
            {r.stops.map((s, i) => (
              <li key={i}>
                <span className={`dot ${s.kind === "proposed" ? "dot-prop" : ""}`} aria-hidden="true" />
                <span className="grow stack" style={{ gap: 0 }}>
                  <span className="small">{s.name}</span>
                  <span className="tiny muted">{s.action === "pickup" ? "Pick-up" : s.action === "drop" ? "Drop" : "Pick-up and drop"}{!s.audited && " · needs safety audit"}</span>
                </span>
                <span className="tiny mono muted">+{s.offset_min} min</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="lbl">Departures</div>
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th scope="col">Leaves first stop</th><th scope="col">Days</th><th scope="col">Vehicle</th><th scope="col">Seats sold</th></tr></thead>
          <tbody>
            {r.departures.map((d) => (
              <tr key={d.template_id}>
                <td className="mono">{hm12(d.start)}</td><td className="small">{daysText(d.days_mask)}</td><td className="small">{d.vehicle}</td>
                <td><div className="row" style={{ gap: 8 }}><span className="mono small" style={{ minWidth: 48 }}>{d.sold}/{d.seats}</span>
                  <span className="meter" aria-hidden="true"><i style={{ width: `${Math.min(100, (d.sold / d.seats) * 100)}%` }} /></span></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlannerCard({ plan, routes, busy, onPublish, onShow, onClose }: {
  plan: PlannerResult; routes: RouteView[]; busy: boolean; onPublish: (id: number) => void; onShow: (id: number) => void; onClose: () => void;
}) {
  const idOf = (code: string) => routes.find((r) => r.code === code)?.id;
  return (
    <section className="card stack summary" aria-label="Planner result">
      <div className="row between"><h2>Planner: {plan.proposals.length} proposal{plan.proposals.length === 1 ? "" : "s"} for {plan.pooled_riders} waiting riders</h2>
        <button className="btn ghost sm" onClick={onClose} aria-label="Dismiss"><Icon.x size={16} /></button></div>
      <p className="small muted" style={{ margin: 0 }}>Riders are grouped by office area and arrival half-hour; stops are sited to cover everyone within their walking limit, then routes are solved for the fleet's vehicle sizes with a 75-minute ride cap.
        {plan.unserved_riders > 0 && ` ${plan.unserved_riders} riders couldn't be fitted.`}</p>
      {plan.proposals.length > 0 && <div className="scroll-x"><table className="table">
        <thead><tr><th scope="col">Route</th><th scope="col">Arrives</th><th scope="col">Riders</th><th scope="col">Vehicle</th><th scope="col">Seats filled</th><th scope="col">Ride</th><th scope="col">Stops</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{plan.proposals.map((p) => {
          const id = idOf(p.code);
          return (
            <tr key={p.code}>
              <td><span className="pill accent">{p.code}</span> <span className="small">{p.name}</span>{p.return_code && <div className="tiny muted">+ evening return {p.return_code}</div>}</td>
              <td className="mono small">{hm12(p.arrive)}</td><td className="mono">{p.riders}</td><td className="small">{p.vehicle}</td>
              <td>{p.viable ? <span className="pill good"><Icon.check size={12} />{p.load_pct}% viable</span> : <span className="pill warn"><Icon.alert size={12} />{p.load_pct}% below target</span>}</td>
              <td className="mono small">{p.ride_min} min</td>
              <td className="tiny muted" style={{ maxWidth: 280 }}>{p.stops.join(" → ")}</td>
              <td><div className="row" style={{ gap: 6 }}>{id && <button className="btn ghost sm" onClick={() => onShow(id)}>Map</button>}
                {id && <button className="btn sm" disabled={busy} onClick={() => onPublish(id)}>Publish</button>}</div></td>
            </tr>);
        })}</tbody>
      </table></div>}
      {plan.groups_too_small.length > 0 && <div className="small muted"><b>Still waiting (too few for a route yet):</b>{" "}
        {plan.groups_too_small.map((g) => `${g.riders} to ${g.campus} arriving ${hm12(g.arrive)}`).join(" · ")}</div>}
    </section>
  );
}
