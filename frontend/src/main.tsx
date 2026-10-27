import "@fontsource/bricolage-grotesque/600.css";
import "@fontsource/bricolage-grotesque/700.css";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/noto-sans-telugu/700.css";
import "./styles.css";

import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Landing } from "./Landing";
import { Spinner, ToastProvider } from "./ui";

const RiderApp = lazy(() => import("./rider/RiderApp"));
const DriverApp = lazy(() => import("./driver/DriverApp"));
const OpsApp = lazy(() => import("./ops/OpsApp"));

/** Each app has its own install manifest, so riders, drivers and ops staff can each add "their" app to the home screen. */
function ManifestSwitch() {
  const { pathname } = useLocation();
  useEffect(() => {
    const app = ["rider", "driver", "ops"].find((a) => pathname.startsWith("/" + a));
    const link = document.getElementById("manifest") as HTMLLinkElement | null;
    if (link) link.href = app ? `/manifest-${app}.webmanifest` : "/manifest.webmanifest";
    document.title = app === "rider" ? "Kalisi" : app === "driver" ? "Kalisi Driver" : app === "ops" ? "Kalisi Control Room" : "Kalisi";
  }, [pathname]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ManifestSwitch />
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/rider/*" element={<RiderApp />} />
            <Route path="/driver/*" element={<DriverApp />} />
            <Route path="/ops/*" element={<OpsApp />} />
            <Route path="*" element={<Landing />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
