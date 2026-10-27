import { Link } from "react-router-dom";
import { DemoClock, Icon, Wordmark } from "./ui";

export function Landing() {
  const apps = [
    { to: "/rider", icon: <Icon.user size={22} />, title: "Rider app", text: "Set your commute once, get a seat on a shared AC bus or minibus, track it live, skip days, rate rides." },
    { to: "/driver", icon: <Icon.bus size={22} />, title: "Driver app", text: "Today's duty (long run, then short loops), stop list, rider check-in by code, GPS sharing." },
    { to: "/ops", icon: <Icon.grid size={22} />, title: "Control room", text: "Live map and exceptions, daily allocation and duties, route planner, demand map, fleet compliance." },
  ];
  return (
    <div style={{ minHeight: "100%", background: "var(--app)" }}>
      <DemoClock />
      <div className="page" style={{ maxWidth: 880, margin: "0 auto", paddingTop: 32 }}>
        <Wordmark size={34} />
        <div className="stack" style={{ gap: 6 }}>
          <h1 style={{ fontSize: "2rem" }}>Shared office commutes for Hyderabad</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>Working prototype: three apps on one backend. Data is a seeded demo network. Places come from
            OpenStreetMap and the Hyderabad Metro timetable feed. Routes, vehicles, drivers and riders are invented.</p>
        </div>
        <div className="grid cols-3">
          {apps.map((a) => (
            <Link key={a.to} to={a.to} className="card stack" style={{ textDecoration: "none", color: "inherit", gap: 10 }}>
              <span className="row" style={{ color: "var(--route)" }}>{a.icon}<h2>{a.title}</h2></span>
              <span className="small muted">{a.text}</span>
              <span className="row small" style={{ color: "var(--route)", fontWeight: 700 }}>Open <Icon.chevron size={16} /></span>
            </Link>
          ))}
        </div>
        <p className="tiny muted">API documentation: <a href="/docs">/docs</a> · Open data: <a href="/api/v1/public/gtfs.zip">GTFS feed of live routes</a></p>
      </div>
    </div>
  );
}
