import { NavLink, Route, Routes } from "react-router-dom";
import { setSession, useSession } from "../api";
import { Gate } from "../Gate";
import { DemoClock, Icon, Wordmark } from "../ui";
import { Allocation } from "./Allocation";
import { ClockPage } from "./ClockPage";
import { Demand } from "./Demand";
import { Fleet } from "./Fleet";
import { LiveMap } from "./LiveMap";
import { Network } from "./Network";
import "./ops.css";
import { Overview } from "./Overview";

const NAV = [
  { to: "/ops", end: true, label: "Overview", icon: <Icon.grid /> },
  { to: "/ops/live", label: "Live map", icon: <Icon.map /> },
  { to: "/ops/allocation", label: "Allocation", icon: <Icon.calendar /> },
  { to: "/ops/network", label: "Network", icon: <Icon.route /> },
  { to: "/ops/demand", label: "Demand", icon: <Icon.hex /> },
  { to: "/ops/fleet", label: "Fleet", icon: <Icon.truck /> },
  { to: "/ops/clock", label: "Clock", icon: <Icon.clock /> },
];

function Shell() {
  const s = useSession("ops");
  return (
    <div className="ops">
      <DemoClock />
      <div className="desk">
        <nav className="side" aria-label="Control room">
          <div className="ops-brand"><Wordmark size={20} /><span className="tiny muted">Control room</span></div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>{n.icon}{n.label}</NavLink>
          ))}
          <div className="ops-me">
            <div className="small ellipsis" title={s?.user.name}><Icon.user size={14} /> {s?.user.name || "Signed in"}</div>
            <button className="btn ghost sm" onClick={() => setSession("ops", null)}><Icon.logout size={16} />Sign out</button>
          </div>
        </nav>
        <main className="main" id="ops-main">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="live" element={<LiveMap />} />
            <Route path="allocation" element={<Allocation />} />
            <Route path="network" element={<Network />} />
            <Route path="demand" element={<Demand />} />
            <Route path="fleet" element={<Fleet />} />
            <Route path="clock" element={<ClockPage />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function OpsApp() {
  return <Gate app="ops"><Shell /></Gate>;
}
