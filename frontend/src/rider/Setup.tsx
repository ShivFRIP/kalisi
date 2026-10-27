import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { metres, WEEKDAYS, WEEKDAY_LETTERS } from "../fmt";
import type { IntentIn, OptionsResponse } from "../types";
import { Chip, Icon, Switch, useAction } from "../ui";
import { AM_WINDOWS, PM_WINDOWS, useHome, WALK_CHOICES } from "./common";
import { PlacePicker, type PlaceValue } from "./PlacePicker";

/** Two short steps: where (home + office) and when (windows, days, preferences). Creates a commute and shows options. */
export function Setup() {
  const { home, reload } = useHome();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [step, setStep] = useState<"where" | "when">("where");
  const [picking, setPicking] = useState<"home" | "office" | null>(null);
  const [homeP, setHomeP] = useState<PlaceValue | null>(null);
  const [office, setOffice] = useState<PlaceValue | null>(null);
  const [am, setAm] = useState<string | null>(null);        // window start
  const [pm, setPm] = useState<string | null | "none">(null);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [acOnly, setAcOnly] = useState(true);
  const [walk, setWalk] = useState(800);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {   // "Change my commute": start from what the rider told us last time
    const it = home?.intent;
    if (prefilled || !home) return;
    setPrefilled(true);
    if (!it) return;
    setHomeP(it.home); setOffice(it.office);
    const within = (ws: typeof AM_WINDOWS, t: string) => ws.find((w) => w.from <= t && t < w.to)?.from ?? null;
    setAm(within(AM_WINDOWS, it.am_from));
    setPm(it.pm_from ? within(PM_WINDOWS, it.pm_from) : "none");
    setDays(it.days); setAcOnly(it.ac_only); setWalk(WALK_CHOICES.includes(it.max_walk_m) ? it.max_walk_m : 800);
  }, [home, prefilled]);

  const editing = !!home?.intent;
  const toggleDay = (d: number) => setDays((ds) => (ds.includes(d) ? (ds.length > 1 ? ds.filter((x) => x !== d) : ds) : [...ds, d].sort()));

  async function submit() {
    if (!homeP || !office || !am || pm === null) return;
    const aw = AM_WINDOWS.find((w) => w.from === am)!;
    const pw = pm === "none" ? null : PM_WINDOWS.find((w) => w.from === pm)!;
    const body: IntentIn = { home: homeP, office, am_from: aw.from, am_to: aw.to, pm_from: pw?.from ?? null, pm_to: pw?.to ?? null,
                             days, ac_only: acOnly, max_walk_m: walk };
    const r = await run(async () => { const x = await api<OptionsResponse>("rider", "/rider/intents", { body }); await reload(); return x; });
    if (r) nav(`/rider/options/${r.intent.id}`, { state: r });
  }

  const back = () => (step === "when" ? setStep("where") : nav(editing ? "/rider/account" : "/rider"));
  return (
    <>
      <header className="topbar">
        {(step === "when" || editing) ? <button className="btn ghost sm" onClick={back} aria-label="Back"><Icon.back /></button> : null}
        <h1>{editing ? "Change my commute" : "Your daily commute"}</h1>
        <span className="small muted">Step {step === "where" ? 1 : 2} of 2</span>
      </header>
      <div className="page">
        <div className="r-steps" aria-hidden="true"><span className="on" /><span className={step === "when" ? "on" : ""} /></div>
        {step === "where" ? (
          <>
            <div className="stack" style={{ gap: 4 }}>
              <h2>Where do you travel?</h2>
              <p className="small muted" style={{ margin: 0 }}>Tell us once. We'll find a seat on a shared AC bus or minibus from a stop near your home.</p>
            </div>
            <PlaceButton kind="home" value={homeP} onClick={() => setPicking("home")} />
            <PlaceButton kind="office" value={office} onClick={() => setPicking("office")} />
            <div className="r-sticky-cta">
              <button className="btn block" disabled={!homeP || !office} onClick={() => setStep("when")}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <section className="stack" aria-labelledby="h-am">
              <h2 id="h-am">When do you usually reach the office?</h2>
              <div className="chips" role="group" aria-labelledby="h-am">
                {AM_WINDOWS.map((w) => <Chip key={w.from} on={am === w.from} onClick={() => setAm(w.from)}>{w.label}</Chip>)}
              </div>
            </section>
            <section className="stack" aria-labelledby="h-pm">
              <h2 id="h-pm">And leave for home?</h2>
              <div className="chips" role="group" aria-labelledby="h-pm">
                {PM_WINDOWS.map((w) => <Chip key={w.from} on={pm === w.from} onClick={() => setPm(w.from)}>{w.label}</Chip>)}
                <Chip on={pm === "none"} onClick={() => setPm("none")}>No ride home</Chip>
              </div>
              <span className="tiny muted">The ride home is optional. You can add it later.</span>
            </section>
            <section className="stack" aria-labelledby="h-days">
              <h2 id="h-days">Days you go to the office</h2>
              <div className="chips" role="group" aria-labelledby="h-days">
                {WEEKDAY_LETTERS.map((l, i) => (
                  <Chip key={i} on={days.includes(i)} onClick={() => toggleDay(i)} label={WEEKDAYS[i]}>
                    <span style={{ display: "inline-block", minWidth: 14, textAlign: "center" }}>{l}</span>
                  </Chip>
                ))}
              </div>
              <span className="tiny muted">Hybrid? Pick your usual office days.</span>
            </section>
            <section className="card stack" aria-label="Preferences">
              <div className="row between">
                <div><b>AC only</b><div className="small muted">Turn off to also see non-AC buses (often cheaper routes).</div></div>
                <Switch checked={acOnly} onChange={setAcOnly} label="AC only" />
              </div>
              <div className="divider" />
              <div className="stack" style={{ gap: 6 }}>
                <b id="h-walk">Longest walk to a stop</b>
                <div className="chips" role="group" aria-labelledby="h-walk">
                  {WALK_CHOICES.map((m) => <Chip key={m} on={walk === m} onClick={() => setWalk(m)}>{metres(m)}</Chip>)}
                </div>
              </div>
            </section>
            <div className="r-sticky-cta">
              <button className="btn block" disabled={busy || !am || pm === null || !days.length} onClick={submit}>
                {busy ? "Finding routes…" : "Find my seat"}
              </button>
              {(!am || pm === null) && <p className="tiny muted" style={{ margin: "6px 0 0", textAlign: "center" }}>Pick an arrival time and a leaving time (or "No ride home").</p>}
            </div>
          </>
        )}
      </div>
      {picking && (
        <PlacePicker kind={picking} value={picking === "home" ? homeP : office} onClose={() => setPicking(null)}
                     onDone={(v) => { (picking === "home" ? setHomeP : setOffice)(v); setPicking(null); }} />
      )}
    </>
  );
}

function PlaceButton({ kind, value, onClick }: { kind: "home" | "office"; value: PlaceValue | null; onClick: () => void }) {
  const I = kind === "home" ? Icon.home : Icon.office;
  const title = kind === "home" ? "Home" : "Office";
  return (
    <button type="button" className={`r-place ${kind}`} onClick={onClick} aria-label={`${title}: ${value ? value.label : "not set"}. ${value ? "Change" : "Set"}`}>
      <span className="ic"><I /></span>
      <span className="grow">
        <span className="lbl">{title}</span>
        <span className="nm ellipsis">{value ? value.label : kind === "home" ? "Set your home" : "Set your office"}</span>
        {value && <span className="tiny muted mono">{value.lat.toFixed(4)}, {value.lon.toFixed(4)}</span>}
      </span>
      <span className="chg">{value ? "Change" : "Set"}</span>
    </button>
  );
}
