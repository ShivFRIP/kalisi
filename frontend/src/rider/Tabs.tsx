import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, setSession, usePoll } from "../api";
import { clockTime, dayLabel, hm12, metres, rupees, rupeesFromPaise, WEEKDAYS } from "../fmt";
import type { HistoryItem, Pass, Wallet } from "../types";
import { ErrorNote, Icon, Spinner } from "../ui";
import { LEG_NAME, legStatus, Stars, useHome, windowLabel } from "./common";
import { RateSheet } from "./RateSheet";

// ------------------------------------------------------------------ Trips
export function Trips() {
  const { data, error, loading, reload } = usePoll(() => api<HistoryItem[]>("rider", "/rider/history"), 0);
  const [rate, setRate] = useState<HistoryItem | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  const items = data ?? [];
  const byDate = items.reduce<Record<string, HistoryItem[]>>((m, x) => ((m[x.date] ||= []).push(x), m), {});
  return (
    <>
      <h1 style={{ fontSize: "1.35rem" }}>Your trips</h1>
      {items.length === 0 && <div className="card empty"><Icon.calendar size={28} /><p>No trips yet. Your rides appear here after your first day.</p></div>}
      {Object.entries(byDate).map(([date, xs]) => (
        <section key={date} className="card" aria-label={dayLabel(date)} style={{ paddingTop: 10, paddingBottom: 4 }}>
          <span className="lbl">{dayLabel(date)}</span>
          <div className="list">
            {xs.map((x) => {
              const st = legStatus(x.status);
              return (
                <div key={x.booking_id} className="row" style={{ padding: "10px 0", alignItems: "flex-start" }}>
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}><b>{LEG_NAME[x.leg] ?? x.leg}</b><span className="pill route mono">{x.route_code}</span></div>
                    <div className="small">{x.pickup} → {x.drop}</div>
                    <div className="tiny muted">Pickup {hm12(x.pickup_time)}</div>
                    {x.rating && <div className="small">Driver <Stars n={x.rating.driver} /> · Vehicle <Stars n={x.rating.vehicle} /></div>}
                  </div>
                  <div className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
                    <span className={`pill ${st.tone}`}>{st.text}</span>
                    {x.status === "completed" && !x.rating && <button className="btn sm" onClick={() => setRate(x)}>Rate</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {rate && <RateSheet bookingId={rate.booking_id} subtitle={`${rate.route_code} · ${dayLabel(rate.date)} · ${rate.pickup} → ${rate.drop}`}
                          onClose={() => setRate(null)} onDone={() => { setRate(null); reload(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ Pass and wallet
export function PassTab() {
  const { home } = useHome();
  const wallet = usePoll(() => api<Wallet>("rider", "/rider/wallet"), 0);
  if (!home) return <Spinner />;
  return (
    <>
      <h1 style={{ fontSize: "1.35rem" }}>Pass and payments</h1>
      <div className="banner warn"><Icon.info /><div><b>Sandbox payments.</b> This prototype records payments but no real money moves.</div></div>
      {home.passes.length === 0 && (
        <div className="card stack" style={{ alignItems: "flex-start" }}>
          <b>No active pass</b>
          <span className="small muted">Book a seat on a route that fits your commute.</span>
          <Link className="btn sm" to={home.intent ? `/rider/options/${home.intent.id}` : "/rider/setup"}>Find a route</Link>
        </div>
      )}
      {home.passes.map((p) => <PassCard key={p.id} p={p} times={pickupTimes(home.days, p.id)} />)}
      <section className="card stack" aria-labelledby="h-credit">
        <div className="row between"><h2 id="h-credit">Ride credit</h2><span className="r-big">{rupeesFromPaise(wallet.data?.credit_paise ?? home.credit_paise)}</span></div>
        <span className="small muted">Earned by skipping a ride before the cut-off. Used automatically on your next pass.</span>
        {wallet.data && wallet.data.credit_lines.length > 0 && (
          <div className="list">{wallet.data.credit_lines.slice(0, 8).map((l, i) => (
            <div key={i} className="row between small" style={{ padding: "8px 0" }}>
              <span className="grow">{creditMemo(l.memo)}<span className="tiny muted" style={{ display: "block" }}>{dayLabel(l.at.slice(0, 10))}</span></span>
              <span className="mono" style={{ color: l.paise >= 0 ? "var(--good)" : "var(--ink)" }}>{l.paise >= 0 ? "+" : "−"}{rupeesFromPaise(Math.abs(l.paise))}</span>
            </div>))}
          </div>
        )}
      </section>
      <section className="card stack" aria-labelledby="h-pay">
        <h2 id="h-pay">Payments</h2>
        {wallet.loading && <Spinner />}
        {wallet.error && <ErrorNote error={wallet.error} onRetry={wallet.reload} />}
        {wallet.data && wallet.data.payments.length === 0 && <span className="small muted">No payments yet.</span>}
        {wallet.data && wallet.data.payments.length > 0 && (
          <div className="list">{wallet.data.payments.map((p, i) => (
            <div key={i} className="row between" style={{ padding: "8px 0" }}>
              <span className="grow small">{p.method === "credit_only" ? "Paid with ride credit" : p.method.toUpperCase()}
                <span className="tiny muted mono" style={{ display: "block" }}>{dayLabel(p.at.slice(0, 10))} · {clockTime(p.at)} · {p.gateway} {p.ref}</span></span>
              <span className="row" style={{ gap: 6 }}><span className="mono">{rupeesFromPaise(p.amount_paise)}</span>
                <span className={`pill ${p.status === "captured" ? "good" : "warn"}`}>{p.status === "captured" ? "Paid" : p.status}</span></span>
            </div>))}
          </div>
        )}
      </section>
    </>
  );
}

function pickupTimes(days: { legs: { subscription_id: number; leg: string; pickup_time: string }[] }[], subId: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of days) for (const l of d.legs) if (l.subscription_id === subId && !out[l.leg]) out[l.leg] = l.pickup_time;
  return out;
}

function creditMemo(m: string): string {
  const k = m.match(/(\d{4}-\d{2}-\d{2}) (AM|PM)/);
  const what = k ? `${dayLabel(k[1])}, ${k[2] === "AM" ? "to work" : "home"}` : "";
  if (m.startsWith("skip credit")) return `Skipped ride: ${what}`;
  if (m.startsWith("undo skip")) return `Skip undone: ${what}`;
  if (m.includes("pass")) return "Used on a pass";
  return m;
}

function PassCard({ p, times }: { p: Pass; times: Record<string, string> }) {
  const credit = p.price_paise - p.paid_paise;
  return (
    <section className="card stack" style={{ gap: 10 }} aria-label={`${p.product} pass`}>
      <div className="row between">
        <span className="row" style={{ gap: 8 }}><span className="pill good">Active</span><b>{p.product === "monthly" ? "Monthly pass" : "Weekly pass"}</b></span>
        <span className="small muted">{dayLabel(p.valid_from)} – {dayLabel(p.valid_to)}</span>
      </div>
      {[["AM", p.am], ["PM", p.pm]].map(([leg, l]) => l && typeof l !== "string" && (
        <div key={leg as string} className="soft stack" style={{ gap: 4 }}>
          <div className="row between"><span className="lbl">{LEG_NAME[leg as string]}</span><span className="pill route mono">{l.route_code}</span></div>
          <b>{times[leg as string] ? `${hm12(times[leg as string])} · ` : ""}{l.pickup} → {l.drop}</b>
          <span className="small muted">{l.vehicle} · {rupees(l.fare)} per ride</span>
        </div>
      ))}
      <dl className="r-kv">
        <dt>Days</dt><dd>{p.days.map((d) => WEEKDAYS[d]).join(", ")}</dd>
        <dt>Price</dt><dd>{rupeesFromPaise(p.price_paise)}</dd>
        {credit > 0 && <><dt>Ride credit used</dt><dd style={{ color: "var(--good)" }}>−{rupeesFromPaise(credit)}</dd></>}
        <dt>Paid</dt><dd>{rupeesFromPaise(p.paid_paise)}</dd>
      </dl>
    </section>
  );
}

// ------------------------------------------------------------------ Account
export function Account() {
  const { home } = useHome();
  const nav = useNavigate();
  if (!home) return <Spinner />;
  const it = home.intent;
  return (
    <>
      <h1 style={{ fontSize: "1.35rem" }}>Account</h1>
      <section className="card stack">
        <div className="row"><span className="r-place" style={{ border: 0, padding: 0, minHeight: 0, width: "auto" }}><span className="ic"><Icon.user /></span></span>
          <div className="grow"><b>{home.user.name || "Rider"}</b><div className="small muted mono">{home.user.phone.replace(/^\+91(\d{5})(\d{5})$/, "+91 $1 $2")}</div></div></div>
      </section>
      <section className="card stack" aria-labelledby="h-commute">
        <h2 id="h-commute">My commute</h2>
        {it ? (
          <dl className="r-kv">
            <dt>Home</dt><dd>{it.home.label}</dd>
            <dt>Office</dt><dd>{it.office.label}</dd>
            <dt>Reach office</dt><dd>{windowLabel(it.am_from, it.am_to)}</dd>
            <dt>Leave office</dt><dd>{it.pm_from ? windowLabel(it.pm_from, it.pm_to) : "No ride home"}</dd>
            <dt>Days</dt><dd>{it.days.map((d) => WEEKDAYS[d]).join(", ")}</dd>
            <dt>Preferences</dt><dd>{it.ac_only ? "AC only" : "AC or non-AC"} · walk up to {metres(it.max_walk_m)}</dd>
          </dl>
        ) : <span className="small muted">Not set yet.</span>}
        <button className="btn alt block" onClick={() => nav("/rider/setup")}>Change my commute</button>
      </section>
      <section className="card stack">
        <h2>Privacy</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          <li>Drivers see your first name, your stop and whether you've boarded. Never your phone number or home.</li>
          <li>Your home location is used only to find stops within walking distance.</li>
          <li>The bus is tracked, not your phone. Your location is shared only if you press SOS.</li>
        </ul>
      </section>
      <button className="btn alt block" onClick={() => { setSession("rider", null); nav("/rider", { replace: true }); }}><Icon.logout /> Sign out</button>
    </>
  );
}
