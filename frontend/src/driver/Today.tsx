import { useState } from "react";
import { Link } from "react-router-dom";
import { api, usePoll } from "../api";
import { dayLabel, hm12, minutesText } from "../fmt";
import type { DriverToday, DutyItemView, DutyView } from "../types";
import { ErrorNote, Icon, Spinner, Wordmark } from "../ui";
import { MenuSheet, SosButton } from "./common";

const BLOCK: Record<DutyView["block"], string> = { FULL: "Full day", AM: "Morning shift", PM: "Evening shift" };
export const TRIP_STATUS: Record<string, { text: string; cls: string }> = {
  planned: { text: "Not started", cls: "" }, in_progress: { text: "On the road", cls: "route" },
  completed: { text: "Done", cls: "good" }, cancelled: { text: "Cancelled", cls: "bad" },
};

/** "7:00–7:20 AM", or "11:40 AM–12:10 PM" across noon. */
export function hmRange(a: string, b: string): string {
  const A = hm12(a), B = hm12(b);
  return A.slice(-2) === B.slice(-2) ? `${A.slice(0, -3)}–${B}` : `${A}–${B}`;
}

function itemTitle(i: DutyItemView): string {
  if (i.kind === "check") return "Pre-trip check";
  if (i.kind === "deadhead") return `Empty run · ${i.km.toFixed(1)} km`;
  if (i.kind === "break") return "Break";
  return i.route_code ?? "Trip";
}

function Timeline({ duty, nextTripId }: { duty: DutyView; nextTripId: number | null }) {
  return (
    <ol className="drv-tl" aria-label="Your day, in order">
      {duty.items.map((i, k) => {
        const done = i.status === "completed" || i.status === "cancelled";
        const now = i.status === "in_progress";
        return (
          <li key={k}>
            <span className="t">{hm12(i.start).replace(" AM", "").replace(" PM", "")}<span className="tiny" style={{ display: "block", fontWeight: 500 }}>{hm12(i.start).slice(-2)}</span></span>
            <span className="rail"><span className={"dot " + (now ? "now" : i.kind === "trip" ? (done ? "done" : "trip") : "")} /></span>
            <div className="body">
              {i.kind === "trip" && i.trip_id ? (
                <Link to={`trip/${i.trip_id}`} className={"drv-tripcard" + (i.trip_id === nextTripId ? " next" : "")}
                      style={{ textDecoration: "none" }} aria-label={`Trip ${i.route_code} ${i.route_name}, ${hm12(i.start)}, ${i.booked} riders`}>
                  <span className="row between wrap" style={{ gap: 6 }}>
                    <span className="drv-code">{i.route_code}</span>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={"pill " + (i.length === "long" ? "accent" : "")}>{i.length === "long" ? "Long run" : "Short loop"}</span>
                      <span className={"pill " + (TRIP_STATUS[i.status ?? "planned"]?.cls ?? "")}>{TRIP_STATUS[i.status ?? "planned"]?.text ?? i.status}</span>
                    </span>
                  </span>
                  <span style={{ fontWeight: 600 }}>{i.route_name}</span>
                  <span className="drv-sub">{hmRange(i.start, i.end)}</span>
                  <span className="drv-count drv-sub"><Icon.people />{i.booked} riders · {i.stops} stops</span>
                  {i.trip_id === nextTripId && <span className="row" style={{ color: "var(--route)", fontWeight: 700 }}>{now ? "Continue this trip" : "Next: open this trip"} <Icon.chevron size={18} /></span>}
                </Link>
              ) : (
                <div style={{ paddingTop: 4 }}>
                  <div style={{ fontWeight: 700 }}>{itemTitle(i)}</div>
                  <div className="drv-sub">{hmRange(i.start, i.end)}{i.kind === "check" ? ` · ${duty.depot} depot` : i.kind === "deadhead" ? " · no riders" : ""}</div>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DutyCard({ duty, nextTripId }: { duty: DutyView; nextTripId: number | null }) {
  return (
    <section className="card stack" style={{ gap: 14 }} aria-label={`${BLOCK[duty.block]} on ${duty.vehicle.reg_no}`}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="lbl">{BLOCK[duty.block]}</span>
          <span className="drv-reg">{duty.vehicle.reg_no}</span>
          <span className="drv-sub">{duty.vehicle.class}</span>
        </div>
        {duty.vehicle.ac ? <span className="pill route">AC</span> : <span className="pill">Non-AC</span>}
      </div>
      <div className="drv-facts">
        <div><div className="k">Report</div><div className="v">{hm12(duty.report)}</div><div className="k">{duty.depot} depot</div></div>
        <div><div className="k">Sign off</div><div className="v">{hm12(duty.sign_off)}</div></div>
        <div><div className="k">Working time</div><div className="v">{minutesText(duty.worked_min)}</div></div>
        <div><div className="k">Start to finish</div><div className="v">{minutesText(duty.spread_min)}</div></div>
      </div>
      <div className="divider" />
      <Timeline duty={duty} nextTripId={nextTripId} />
    </section>
  );
}

export function Today() {
  const { data, error, loading, reload } = usePoll(() => api<DriverToday>("driver", "/driver/today"), 20000);
  const [menu, setMenu] = useState(false);
  const trips = (data?.duties ?? []).flatMap((d) => d.items).filter((i) => i.kind === "trip" && i.trip_id);
  const running = trips.find((i) => i.status === "in_progress");
  const next = running ?? trips.find((i) => i.status === "planned");

  return (
    <>
      <header className="topbar">
        <Wordmark size={18} />
        <h1 className="sr-only">Today's duty</h1>
        <span className="grow" />
        <SosButton tripId={running?.trip_id} />
        <button className="drv-iconbtn" onClick={() => setMenu(true)} aria-label="Menu"><Icon.user /></button>
      </header>
      <main className="page">
        {loading && !data && <Spinner />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && (
          <>
            <div className="stack" style={{ gap: 2 }}>
              <h2 style={{ fontSize: "1.45rem" }}>Hello, {data.driver.name.split(" ")[0]}</h2>
              <span className="drv-sub">{dayLabel(data.date)}</span>
            </div>
            {next?.trip_id && (
              <Link to={`trip/${next.trip_id}`} className="btn drv-big" style={{ textDecoration: "none" }}>
                {running ? <Icon.bus /> : <Icon.play />}
                {running ? `Continue ${next.route_code}` : `Next trip: ${next.route_code} at ${hm12(next.start)}`}
              </Link>
            )}
            {trips.length > 0 && !next && (
              <div className="banner good" role="status"><Icon.check /><div><b>All trips done.</b>{" "}
                {(() => { const d = data.duties[data.duties.length - 1]; return `Return to the ${d.depot} depot and sign off by ${hm12(d.sign_off)}.`; })()}</div></div>
            )}
            {data.duties.length === 0 && (
              <div className="card empty stack" style={{ alignItems: "center", gap: 10 }}>
                <Icon.calendar size={32} />
                <h2>No duty today</h2>
                <p style={{ margin: 0 }}>Nothing is assigned to you for {dayLabel(data.date)}. Your operator will add duties after the evening allocation.</p>
              </div>
            )}
            {data.duties.map((d) => <DutyCard key={d.duty_id} duty={d} nextTripId={next?.trip_id ?? null} />)}
          </>
        )}
      </main>
      {menu && <MenuSheet onClose={() => setMenu(false)} />}
    </>
  );
}
