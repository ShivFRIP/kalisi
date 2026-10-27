import { useEffect, useState } from "react";
import { api, ApiError, usePoll } from "../api";
import { clockTime, dayLabel } from "../fmt";
import type { ClockInfo } from "../types";
import { Chip, ErrorNote, Icon, Spinner, useToast } from "../ui";
import { PageHead } from "./shared";

const SPEEDS = [1, 5, 10, 30, 60];

export function ClockPage() {
  const toast = useToast();
  const c = usePoll(() => api<ClockInfo>(null, "/clock"), 5000);
  const [mode, setMode] = useState<"real" | "sim">("sim");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("07:30");
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replay, setReplay] = useState<{ warning: string; date: string } | null>(null);
  useEffect(() => {
    if (c.data && !date) { setDate(c.data.now.slice(0, 10)); setMode(c.data.mode); setSpeed(c.data.speed || 1); }
  }, [c.data, date]);

  async function apply(m: "real" | "sim", d = date, t = time, sp = speed) {
    setBusy(true); setErr(null);
    try {
      const r = await api<ClockInfo & { warning: string | null; replay_date: string }>("ops", "/ops/clock",
        { body: m === "real" ? { mode: "real", speed: 1 } : { mode: "sim", start: `${d}T${t}`, speed: sp } });
      c.setData(r);
      setMode(r.mode);
      setReplay(r.warning ? { warning: r.warning, date: r.replay_date } : null);
      toast(r.mode === "real" ? "Back on real time" : `Demo clock set to ${dayLabel(r.now.slice(0, 10))}, ${clockTime(r.now)}`);
    } catch (e) { setErr(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(false); }
  }

  async function resetDay() {
    if (!replay) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ departures_running: number }>("ops", "/ops/allocation/run", { body: { date: replay.date, force: true } });
      toast(`Day reset: ${r.departures_running} departures will replay from the new time`);
      setReplay(null);
    } catch (e) { setErr(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="Clock" sub="Run a morning or evening peak at any time of day for demonstrations." />
      <div className="banner warn" role="note"><Icon.alert /><div><b>This changes time for everyone using this server</b>: riders, drivers and the control room.
        Skip cut-offs, trip progress and allocation all follow it. Use it on demo servers only, and switch back to real time afterwards.</div></div>
      {err && <ErrorNote error={err} />}
      {replay && (
        <div className="banner warn" role="alert"><Icon.refresh /><div className="grow">{replay.warning}
          <div className="tiny muted">Resetting rebuilds the day's trips and duties from current passes and skips. Ratings and boardings from that day are cleared.</div></div>
          <button className="btn sm" disabled={busy} onClick={resetDay}>Reset {dayLabel(replay.date)}</button></div>
      )}
      <div className="grid cols-2">
        <section className="card stack" aria-label="Current time">
          <span className="lbl">Now</span>
          {!c.data ? <Spinner /> : <>
            <div className="clock-big mono">{clockTime(c.data.now)}</div>
            <div className="small">{dayLabel(c.data.now.slice(0, 10))} · {c.data.timezone}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {c.data.mode === "sim" ? <span className="pill accent"><Icon.clock size={12} />Demo clock{c.data.speed !== 1 ? ` · ${c.data.speed}× speed` : ""}{c.data.speed === 0 ? " (frozen)" : ""}</span>
                : <span className="pill good"><Icon.check size={12} />Real time</span>}
            </div>
          </>}
          <div className="divider" />
          <span className="lbl">Quick start</span>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn alt sm" disabled={busy || !date} onClick={() => { setTime("07:30"); apply("sim", date, "07:30", speed); }}>Morning peak 7:30 AM</button>
            <button className="btn alt sm" disabled={busy || !date} onClick={() => { setTime("17:30"); apply("sim", date, "17:30", speed); }}>Evening peak 5:30 PM</button>
            <button className="btn alt sm" disabled={busy || c.data?.mode === "real"} onClick={() => apply("real")}>Back to real time</button>
          </div>
        </section>
        <section className="card stack" aria-label="Set the clock">
          <span className="lbl">Set the clock</span>
          <div className="chips" role="radiogroup" aria-label="Mode">
            <Chip on={mode === "sim"} onClick={() => setMode("sim")}>Demo clock</Chip>
            <Chip on={mode === "real"} onClick={() => setMode("real")}>Real time</Chip>
          </div>
          {mode === "sim" && <>
            <div className="row wrap" style={{ gap: 12 }}>
              <label className="field"><span className="lbl">Date</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
              <label className="field"><span className="lbl">Time</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
            </div>
            <div className="field"><span className="lbl">Speed</span>
              <div className="chips" role="radiogroup" aria-label="Speed">{SPEEDS.map((s) => <Chip key={s} on={speed === s} onClick={() => setSpeed(s)}>{s}×</Chip>)}</div>
              <span className="tiny muted">At 10×, a 75-minute morning run passes in about 7½ minutes.</span></div>
          </>}
          <button className="btn" disabled={busy || (mode === "sim" && (!date || !time))} onClick={() => apply(mode)}>{busy ? "Setting…" : mode === "sim" ? "Start demo clock" : "Use real time"}</button>
        </section>
      </div>
    </>
  );
}
