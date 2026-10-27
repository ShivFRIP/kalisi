import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Gate } from "../Gate";
import { DemoClock, useToast } from "../ui";
import { QueueBanner } from "./common";
import "./driver.css";
import { flush, onRejected, pendingCount } from "./queue";
import { Today } from "./Today";
import { TripScreen } from "./TripScreen";

/** Background sender: retries queued events every few seconds and as soon as the phone is back online. */
function Sender() {
  const toast = useToast();
  useEffect(() => {
    onRejected((reason) => toast(`Not saved: ${reason}`));
    void flush();
    const id = window.setInterval(() => { if (pendingCount() && navigator.onLine) void flush(); }, 4000);
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => { window.clearInterval(id); window.removeEventListener("online", online); onRejected(null); };
  }, [toast]);
  return null;
}

export default function DriverApp() {
  return (
    <Gate app="driver">
      <div className="mobile drv">
        <Sender />
        <DemoClock />
        <QueueBanner />
        <Routes>
          <Route index element={<Today />} />
          <Route path="trip/:id" element={<TripScreen />} />
          <Route path="*" element={<Navigate to="/driver" replace />} />
        </Routes>
      </div>
    </Gate>
  );
}
