import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

/**
 * A small declarative wrapper around Leaflet. Pass the layers to draw; the map redraws them when they change and
 * fits the view to `fit` (or to everything drawn) the first time, and again whenever `fitKey` changes.
 *
 * Base map: OpenStreetMap's public tile server, fine for a prototype under its usage policy. A pilot should use a
 * tile provider or self-hosted tiles. Attribution is required and shown.
 */
export interface MapMarker { lat: number; lon: number; kind: "bus" | "bus-late" | "bus-idle" | "stop" | "stop-me" | "stop-proposed" | "home" | "office";
  label?: string; heading?: number | null; onClick?: () => void; }
export interface MapLine { points: [number, number][]; color?: string; dashed?: boolean; weight?: number; }
export interface MapPolygon { points: [number, number][]; color: string; opacity: number; label?: string; onClick?: () => void; }

const HYD: [number, number] = [17.43, 78.43];
const BUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14M8 17v3M16 17v3"/></svg>';

function icon(m: MapMarker): L.DivIcon {
  switch (m.kind) {
    case "bus": case "bus-late": case "bus-idle":
      return L.divIcon({ className: "k-pin", iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<div class="k-bus ${m.kind === "bus-late" ? "late" : m.kind === "bus-idle" ? "idle" : ""}">` +
          (m.heading != null && m.kind !== "bus-idle" ? `<span class="k-hd" style="transform:rotate(${Math.round(m.heading)}deg)"></span>` : "") + `${BUS_SVG}</div>` });
    case "stop-me": return L.divIcon({ className: "k-pin", html: '<div class="k-stop me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    case "stop-proposed": return L.divIcon({ className: "k-pin", html: '<div class="k-stop proposed"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
    case "home": return L.divIcon({ className: "k-pin", html: '<div class="k-home"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
    case "office": return L.divIcon({ className: "k-pin", html: '<div class="k-home" style="background:var(--route)"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
    default: return L.divIcon({ className: "k-pin", html: '<div class="k-stop"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
  }
}

export function MapView({ markers = [], lines = [], polygons = [], fit, fitKey, className = "map", center, zoom = 11, onMove, ariaLabel = "Map" }: {
  markers?: MapMarker[]; lines?: MapLine[]; polygons?: MapPolygon[]; fit?: [number, number][]; fitKey?: string | number;
  className?: string; center?: [number, number]; zoom?: number; onMove?: (lat: number, lon: number) => void; ariaLabel?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef<string | number | undefined>(undefined);
  const lastFit = useRef<[number, number][] | null>(null);   // re-applied while the container settles, until the user moves the map
  const touched = useRef(false);
  const moveCb = useRef(onMove);
  moveCb.current = onMove;

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(center ?? HYD, zoom);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on("moveend", () => { const c = m.getCenter(); moveCb.current?.(c.lat, c.lng); });
    m.on("dragstart zoomstart", (e: L.LeafletEvent) => { if ((e as L.LeafletEvent & { originalEvent?: Event }).originalEvent || e.type === "dragstart") touched.current = true; });
    el.current.addEventListener("wheel", () => { touched.current = true; }, { passive: true });
    map.current = m;
    const ro = new ResizeObserver(() => {
      m.invalidateSize();
      const pts = lastFit.current;
      if (pts && !touched.current) {
        if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 15, animate: false });
        else if (pts.length === 1) m.setView(pts[0], 15, { animate: false });
      }
    });
    ro.observe(el.current);
    return () => { ro.disconnect(); m.stop(); m.remove(); map.current = null; fitted.current = undefined; lastFit.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const css = getComputedStyle(document.documentElement);
    const routeColor = css.getPropertyValue("--route").trim() || "#0C6B66";
    for (const pg of polygons) {
      const poly = L.polygon(pg.points, { color: pg.color, weight: 1, fillColor: pg.color, fillOpacity: pg.opacity });
      if (pg.label) poly.bindTooltip(pg.label);
      if (pg.onClick) poly.on("click", pg.onClick);
      poly.addTo(g);
    }
    for (const ln of lines) {
      L.polyline(ln.points, { color: ln.color || routeColor, weight: ln.weight ?? 4, opacity: 0.85, dashArray: ln.dashed ? "6 8" : undefined }).addTo(g);
    }
    for (const mk of markers) {
      const marker = L.marker([mk.lat, mk.lon], { icon: icon(mk), keyboard: !!mk.onClick, zIndexOffset: mk.kind.startsWith("bus") ? 1000 : 0 });
      if (mk.label) marker.bindTooltip(mk.label);
      if (mk.onClick) marker.on("click", mk.onClick);
      marker.addTo(g);
    }
    const key = fitKey ?? "once";
    if (fitted.current !== key) {
      const pts: [number, number][] = fit ?? [...markers.map((x) => [x.lat, x.lon] as [number, number]), ...lines.flatMap((x) => x.points), ...polygons.flatMap((x) => x.points)];
      if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 15 });
      else if (pts.length === 1) m.setView(pts[0], 15);
      if (pts.length) { fitted.current = key; lastFit.current = pts; touched.current = false; }
    }
  }, [markers, lines, polygons, fit, fitKey]);

  useEffect(() => {
    if (center && map.current) map.current.setView(center, map.current.getZoom());
    // only when the caller moves the centre explicitly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1]]);

  return <div ref={el} className={className} role="region" aria-label={ariaLabel} />;
}
