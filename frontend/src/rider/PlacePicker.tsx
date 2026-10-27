import { useMemo, useState } from "react";
import { api, usePoll } from "../api";
import { MapView } from "../MapView";
import type { LatLon, Place, PlacesResponse } from "../types";
import { Icon, Sheet, Spinner } from "../ui";

export type PlaceValue = LatLon & { label: string };

const HYD: [number, number] = [17.43, 78.43];
const inRegion = (p: LatLon) => p.lat >= 16.8 && p.lat <= 18.2 && p.lon >= 77.8 && p.lon <= 79.2;
const KIND_ICON = { office: Icon.office, area: Icon.home, metro: Icon.route } as const;
const KIND_LABEL = { office: "Office area", area: "Area", metro: "Metro station" } as const;

/**
 * Pick a point: search the built-in place list (OpenStreetMap areas, offices, Metro stations), then move the map so
 * the pin sits on the exact spot. The pin, not the search result, is what gets saved.
 */
export function PlacePicker({ kind, value, onDone, onClose }: {
  kind: "home" | "office"; value: PlaceValue | null; onDone: (v: PlaceValue) => void; onClose: () => void;
}) {
  const places = usePoll(() => api<PlacesResponse>(null, "/public/places"), 0);
  const [q, setQ] = useState("");
  const [label, setLabel] = useState(value?.label ?? "");
  const [picked, setPicked] = useState<LatLon>(value ?? { lat: HYD[0], lon: HYD[1] });
  const [view, setView] = useState<{ key: number; center: [number, number]; zoom: number }>(
    { key: 0, center: value ? [value.lat, value.lon] : HYD, zoom: value ? 16 : 12 });
  const [moved, setMoved] = useState(!!value);

  const results = useMemo(() => {
    // interchange Metro stations appear once per line in the feed: keep one entry per name
    const all = [...new Map((places.data?.places ?? []).map((p) => [`${p.kind}:${p.name}`, p])).values()];
    const needle = q.trim().toLowerCase();
    if (!needle) return kind === "office" ? all.filter((p) => p.kind === "office") : [];
    const rank = (p: Place) => (p.name.toLowerCase().startsWith(needle) ? 0 : 1) + (kind === "office" && p.kind === "office" ? -0.5 : 0);
    return all.filter((p) => p.name.toLowerCase().includes(needle)).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  }, [places.data, q, kind]);

  function choose(p: Place) {
    setView((v) => ({ key: v.key + 1, center: [p.lat, p.lon], zoom: 16 }));
    setPicked({ lat: p.lat, lon: p.lon });
    setMoved(true);
    if (!label || label === value?.label || (places.data?.places ?? []).some((x) => x.name === label)) setLabel(p.name);
    setQ("");
  }

  const ok = moved && inRegion(picked);
  const what = kind === "home" ? "home" : "office";
  return (
    <Sheet title={kind === "home" ? "Where do you start?" : "Where do you work?"} onClose={onClose}>
      <label className="field">
        <span className="lbl">Search an area, office park or Metro station</span>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
               placeholder={kind === "home" ? "e.g. Kukatpally, Miyapur Metro" : "e.g. Waverock, HITEC City"} aria-controls="r-place-results" />
      </label>
      {places.loading && <Spinner label="Loading places" />}
      {results.length > 0 && (
        <div className="r-results" id="r-place-results" role="listbox" aria-label="Matching places">
          {results.map((p) => {
            const I = KIND_ICON[p.kind];
            return (
              <button key={`${p.kind}:${p.name}`} role="option" aria-selected={false} onClick={() => choose(p)}>
                <I size={18} /><span className="grow"><span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span className="tiny muted" style={{ display: "block" }}>{KIND_LABEL[p.kind]}</span></span>
              </button>
            );
          })}
        </div>
      )}
      <div className="r-pickwrap">
        <MapView key={view.key} className="map tall" center={view.center} zoom={view.zoom}
                 onMove={(lat, lon) => { setPicked({ lat, lon }); setMoved(true); }} ariaLabel={`Map: move it so the pin sits on your ${what}`} />
        <span className="r-crosshair" aria-hidden="true">
          <svg viewBox="0 0 24 24" strokeWidth="1.5"><path d="M12 22s-7-6.4-7-12a7 7 0 1 1 14 0c0 5.6-7 12-7 12Z" /><circle cx="12" cy="10" r="2.6" fill="#fff" stroke="none" /></svg>
        </span>
        <span className="r-crossdot" aria-hidden="true" />
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Drag the map so the pin sits on your {what}{kind === "home" ? " or the gate you walk out of" : " gate"}. Zoom in for accuracy.
      </p>
      {!inRegion(picked) && <div className="banner warn"><Icon.info /><div>Kalisi serves the Hyderabad area. Move the pin inside the city.</div></div>}
      {kind === "home" && (
        <div className="banner info"><Icon.shield /><div>Drivers never see your home. We use it only to find stops within walking distance.</div></div>
      )}
      <label className="field">
        <span className="lbl">Name this place (optional)</span>
        <input className="input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "home" ? "Home" : "Office"} />
      </label>
      <button className="btn block" disabled={!ok} onClick={() => onDone({ ...picked, label: label.trim() || (kind === "home" ? "Home" : "Office") })}>
        {moved ? `Use this spot as my ${what}` : "Search or move the map first"}
      </button>
      <p className="tiny muted" style={{ margin: 0 }}>Places: {places.data?.sources?.localities_and_offices ? "OpenStreetMap contributors; Metro stations from the HMRL timetable feed." : "OpenStreetMap contributors."}</p>
    </Sheet>
  );
}
