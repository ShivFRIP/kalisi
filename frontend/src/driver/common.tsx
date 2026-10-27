import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { api, getSession, setSession } from "../api";
import { Icon, Sheet, useToast } from "../ui";
import { flush, pendingCount, subscribe } from "./queue";

export function useOnline(): boolean {
  const [on, setOn] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return on;
}

export const usePending = () => useSyncExternalStore(subscribe, pendingCount);

/** Tells the driver when taps are saved on the phone but not yet sent. */
export function QueueBanner() {
  const online = useOnline();
  const n = usePending();
  const [busy, setBusy] = useState(false);
  if (online && n === 0) return null;
  return (
    <div className={"drv-queue" + (online ? "" : " offline")} role="status" aria-live="polite">
      <Icon.refresh />
      <span className="grow">
        {!online ? "No signal. " : ""}
        {n > 0 ? `${n} update${n === 1 ? "" : "s"} waiting to send` : "Your taps are saved on this phone"}
        {!online && n > 0 ? "; they'll go when you're back online." : "."}
      </span>
      {online && n > 0 && (
        <button className="btn sm alt" disabled={busy} onClick={async () => { setBusy(true); await flush(); setBusy(false); }}>Send now</button>
      )}
    </div>
  );
}

function currentPosition(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 });
  });
}

/** Emergency alert to the control room, with the trip and (if available) the phone's location. */
export function SosButton({ tripId, fallback }: { tripId?: number; fallback?: { lat: number; lon: number } | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const toast = useToast();
  async function fire() {
    setBusy(true);
    const here = (await currentPosition()) ?? fallback ?? null;
    try {
      const r = await api<{ incident_id: number; message: string }>("driver", "/sos", { body: { trip_id: tripId ?? null, lat: here?.lat, lon: here?.lon, note } });
      setSent(r.message);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="drv-iconbtn drv-sos" onClick={() => { setSent(null); setNote(""); setOpen(true); }} aria-label="SOS: alert the control room">SOS</button>
      {open && createPortal(   // portal: the sticky top bar's backdrop-filter would otherwise trap the fixed overlay
        <Sheet title="Emergency alert" onClose={() => setOpen(false)}>
          {sent ? (
            <>
              <div className="banner good" role="alert"><Icon.check /><div><b>{sent}</b> Stay safe. If anyone is hurt, call 112.</div></div>
              <button className="btn drv-big" onClick={() => setOpen(false)}>Close</button>
            </>
          ) : (
            <>
              <p style={{ margin: 0 }}>This alerts the control room immediately with your vehicle, trip and location. For an accident or medical emergency, also call <b>112</b>.</p>
              <label className="field"><span className="lbl">What's happening? (optional)</span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. breakdown, accident, unwell passenger" /></label>
              <button className="btn danger drv-big" disabled={busy} onClick={fire}><Icon.sos /> Send SOS</button>
              <button className="btn alt drv-btn" onClick={() => setOpen(false)}>Cancel</button>
            </>
          )}
        </Sheet>, document.body,
      )}
    </>
  );
}

export function MenuSheet({ onClose }: { onClose: () => void }) {
  const s = getSession("driver");
  const n = usePending();
  return (
    <Sheet title="Account" onClose={onClose}>
      <div className="row"><Icon.user size={28} /><div className="stack" style={{ gap: 0 }}><b>{s?.user.name}</b><span className="mono drv-sub">{s?.user.phone}</span></div></div>
      {n > 0 && <div className="banner warn"><Icon.alert /><div>{n} update{n === 1 ? "" : "s"} still waiting to send. Signing out keeps them on this phone; they send when you sign in again.</div></div>}
      <button className="btn alt drv-big" onClick={() => { setSession("driver", null); onClose(); }}><Icon.logout /> Sign out</button>
    </Sheet>
  );
}
