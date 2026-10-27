import { useState } from "react";
import { api } from "../api";
import { tagLabel } from "../fmt";
import { RATING_TAGS_BAD, RATING_TAGS_GOOD } from "../types";
import { Chip, Icon, Sheet, useAction } from "../ui";

/** Driver and vehicle stars plus quick tags. GPS already measures punctuality, so we ask only what people can judge. */
export function RateSheet({ bookingId, subtitle, onClose, onDone }: { bookingId: number; subtitle: string; onClose: () => void; onDone: () => void }) {
  const [driver, setDriver] = useState(0);
  const [vehicle, setVehicle] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const { busy, run } = useAction();
  const toggle = (t: string) => setTags((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : ts.length < 8 ? [...ts, t] : ts));
  const low = (driver && driver <= 3) || (vehicle && vehicle <= 3);

  async function submit() {
    const ok = await run(() => api("rider", `/rider/bookings/${bookingId}/rating`, { body: { driver_score: driver, vehicle_score: vehicle, tags, comment } }),
      "Thanks. Your rating helps drivers and operators improve.");
    if (ok !== undefined) onDone();
  }

  return (
    <Sheet title="Rate your ride" onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>{subtitle}</p>
      <StarRow label="Driver" value={driver} onChange={setDriver} />
      <StarRow label="Bus or minibus" value={vehicle} onChange={setVehicle} />
      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl" id="r-good">What went well?</span>
        <div className="chips" role="group" aria-labelledby="r-good">
          {RATING_TAGS_GOOD.map((t) => <Chip key={t} on={tags.includes(t)} onClick={() => toggle(t)}>{tagLabel(t)}</Chip>)}
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl" id="r-bad">{low ? "What went wrong?" : "Anything to improve?"}</span>
        <div className="chips" role="group" aria-labelledby="r-bad">
          {RATING_TAGS_BAD.map((t) => <Chip key={t} on={tags.includes(t)} onClick={() => toggle(t)}>{tagLabel(t)}</Chip>)}
        </div>
      </div>
      <label className="field"><span className="lbl">Comment (optional)</span>
        <textarea className="input r-textarea" maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Tell the operator more" /></label>
      <div className="banner info"><Icon.shield /><div>Felt unsafe? Ratings are read later. For anything urgent during a ride, use SOS.</div></div>
      <button className="btn block" disabled={busy || !driver || !vehicle} onClick={submit}>{busy ? "Sending…" : "Send rating"}</button>
    </Sheet>
  );
}

function StarRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const id = `stars-${label.replace(/\W+/g, "-")}`;
  return (
    <div className="row between">
      <b id={id}>{label}</b>
      <div className="r-stars" role="group" aria-labelledby={id}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-pressed={n <= value} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => onChange(n)}><Icon.star /></button>
        ))}
      </div>
    </div>
  );
}
