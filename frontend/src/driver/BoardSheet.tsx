import { useCallback, useEffect, useState } from "react";
import type { ManifestRider } from "../types";
import { Icon, Sheet } from "../ui";

/**
 * Numeric keypad for the rider's 4-digit boarding code. The code is checked by the server, never shown to the driver.
 * `onBoard(code)` resolves to an error message to show, or null when the rider is on board (or queued offline).
 */
export function BoardSheet({ rider, onClose, onBoard }: {
  rider: ManifestRider; onClose: () => void; onBoard: (code: string | undefined) => Promise<string | null>;
}) {
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async (code: string | undefined) => {
    setBusy(true);
    const err = await onBoard(code);
    setBusy(false);
    if (err) { setError(err); setDigits(""); }
  }, [onBoard]);

  const press = useCallback((k: string) => {
    if (busy) return;
    setError(null);
    if (k === "del") { setDigits(digits.slice(0, -1)); return; }
    if (digits.length >= 4) return;
    const next = digits + k;
    setDigits(next);
    if (next.length === 4) void submit(next);   // submit outside the state updater (StrictMode runs updaters twice)
  }, [busy, digits, submit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("del");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  return (
    <Sheet title={`Board ${rider.name}`} onClose={onClose}>
      <p className="drv-sub" style={{ margin: 0 }}>Ask for the 4-digit code on their phone and type it in.</p>
      <div className={"drv-code-boxes" + (error ? " err" : "")} aria-label={`Code entered: ${digits.length} of 4 digits`} role="group">
        {[0, 1, 2, 3].map((i) => <span key={i} className={digits[i] ? "filled" : ""}>{digits[i] ?? ""}</span>)}
      </div>
      <div role="alert" aria-live="assertive">{error && <div className="banner bad"><Icon.alert /><div><b>{error}.</b> Check the code and try again.</div></div>}</div>
      <div className="drv-keys">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
          <button key={k} type="button" onClick={() => press(k)} disabled={busy}>{k}</button>
        ))}
        <button type="button" onClick={() => press("del")} aria-label="Delete last digit" disabled={busy || !digits}><Icon.back /></button>
        <button type="button" onClick={() => press("0")} disabled={busy}>0</button>
        <button type="button" onClick={onClose} aria-label="Cancel" disabled={busy}><Icon.x /></button>
      </div>
      <button className="btn alt drv-btn block" type="button" disabled={busy} onClick={() => submit(undefined)}>
        Rider has no phone: board without code
      </button>
    </Sheet>
  );
}
