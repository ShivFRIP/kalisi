import "./rider.css";

import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { api, usePoll } from "../api";
import { Gate } from "../Gate";
import type { RiderHome } from "../types";
import { DemoClock, Icon, Wordmark } from "../ui";
import { HomeContext } from "./common";
import { Options } from "./Options";
import { Setup } from "./Setup";
import { Account, PassTab, Trips } from "./Tabs";
import { Today } from "./Today";

export default function RiderApp() {
  return <Gate app="rider"><RiderShell /></Gate>;
}

function RiderShell() {
  const { pathname } = useLocation();
  const onToday = pathname === "/rider" || pathname === "/rider/";
  // Live trip data refreshes every 5 s on Today; other screens need it less often.
  const { data, error, reload } = usePoll(() => api<RiderHome>("rider", "/rider/home"), onToday ? 5000 : 30000, [onToday]);
  return (
    <HomeContext.Provider value={{ home: data, error, reload }}>
      <div className="mobile">
        <DemoClock />
        <Routes>
          <Route path="setup" element={<Setup />} />
          <Route path="options/:id" element={<Options />} />
          <Route element={<Tabs />}>
            <Route index element={<Today />} />
            <Route path="trips" element={<Trips />} />
            <Route path="pass" element={<PassTab />} />
            <Route path="account" element={<Account />} />
          </Route>
          <Route path="*" element={<Navigate to="/rider" replace />} />
        </Routes>
      </div>
    </HomeContext.Provider>
  );
}

function Tabs() {
  const tabs = [
    { to: "/rider", end: true, icon: <Icon.bus />, label: "Today" },
    { to: "/rider/trips", icon: <Icon.calendar />, label: "Trips" },
    { to: "/rider/pass", icon: <Icon.wallet />, label: "Pass" },
    { to: "/rider/account", icon: <Icon.user />, label: "Account" },
  ];
  return (
    <>
      <header className="topbar"><Wordmark size={20} /></header>
      <main className="page" style={{ paddingBottom: 24 }}><Outlet /></main>
      <nav className="tabbar" aria-label="Rider app">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? "active" : "")}>{t.icon}{t.label}</NavLink>
        ))}
      </nav>
    </>
  );
}
