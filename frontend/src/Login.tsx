import { useState } from "react";
import { api, ApiError, setSession, usePoll, type AppKind } from "./api";
import type { DemoAccount, User } from "./types";
import { ErrorNote, Icon, Wordmark } from "./ui";

const COPY: Record<AppKind, { title: string; sub: string }> = {
  rider: { title: "Ride to work together", sub: "Sign in with your mobile number. New here? The same steps create your account." },
  driver: { title: "Driver sign-in", sub: "Use the mobile number your operator registered." },
  ops: { title: "Control room sign-in", sub: "For platform operations staff." },
};

/** Phone + OTP sign-in shared by the three apps. In dev builds the API returns the code and lists demo accounts. */
export function Login({ app }: { app: AppKind }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [sent, setSent] = useState<{ phone: string; dev_code?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const demos = usePoll(() => api<DemoAccount[]>(null, "/auth/demo-accounts").catch(() => [] as DemoAccount[]), 0);

  async function send(p = phone) {
    setBusy(true); setError(null);
    try {
      const r = await api<{ phone: string; dev_code?: string }>(null, "/auth/otp", { body: { phone: p } });
      setSent(r); setPhone(p);
      if (r.dev_code) setCode(r.dev_code);
    } catch (e) { setError(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(false); }
  }

  async function verify() {
    if (!sent) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ token: string; user: User }>(null, "/auth/verify", { body: { phone: sent.phone, code, name: name || undefined } });
      if (r.user.role !== app) {
        setError(app === "rider" ? "This number belongs to a staff account. Open the driver or control-room app instead."
          : `This number isn't registered as ${app === "driver" ? "a driver" : "control-room staff"}.`);
        return;
      }
      setSession(app, r);
    } catch (e) { setError(e instanceof ApiError ? e.detail : String(e)); } finally { setBusy(false); }
  }

  const c = COPY[app];
  const mine = (demos.data || []).filter((d) => d.role === app);
  return (
    <div className="page" style={{ maxWidth: 420, margin: "0 auto", paddingTop: 40 }}>
      <Wordmark size={30} />
      <div className="stack" style={{ gap: 4 }}><h1>{c.title}</h1><p className="muted" style={{ margin: 0 }}>{c.sub}</p></div>
      {!sent ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label className="field"><span className="lbl">Mobile number</span>
            <input className="input mono" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={phone}
                   onChange={(e) => setPhone(e.target.value)} required /></label>
          <button className="btn block" disabled={busy || phone.replace(/\D/g, "").length < 10}>Send code</button>
        </form>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); verify(); }}>
          <p className="small muted" style={{ margin: 0 }}>Code sent to <span className="mono">{sent.phone}</span>.{" "}
            <button type="button" className="btn ghost sm" onClick={() => { setSent(null); setCode(""); }}>Change number</button></p>
          {sent.dev_code && <div className="banner warn"><Icon.info /><div>Demo build: your code is <b className="mono">{sent.dev_code}</b>. Real builds send it by SMS.</div></div>}
          <label className="field"><span className="lbl">6-digit code</span>
            <input className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          {app === "rider" && <label className="field"><span className="lbl">Your name (new accounts)</span>
            <input className="input" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" /></label>}
          <button className="btn block" disabled={busy || code.length < 4}>Sign in</button>
        </form>
      )}
      {error && <ErrorNote error={error} />}
      {mine.length > 0 && !sent && (
        <div className="card stack">
          <span className="lbl">Demo accounts</span>
          {mine.map((d) => (
            <button key={d.phone} className="btn alt block" style={{ justifyContent: "space-between" }} onClick={() => send(d.phone)}>
              <span style={{ textAlign: "left" }}>{d.name}{d.note && <span className="tiny muted" style={{ display: "block", fontWeight: 500 }}>{d.note}</span>}</span>
              <span className="mono small muted">{d.phone}</span>
            </button>
          ))}
          {app === "rider" && <p className="tiny muted" style={{ margin: 0 }}>Or type any number starting 00 to create a new demo rider.</p>}
        </div>
      )}
    </div>
  );
}
