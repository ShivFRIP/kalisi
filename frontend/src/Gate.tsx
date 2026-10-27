import type { ReactNode } from "react";
import { useSession, type AppKind } from "./api";
import { Login } from "./Login";
import { DemoClock } from "./ui";

/** Shows the sign-in screen until this app has a session. */
export function Gate({ app, children }: { app: AppKind; children: ReactNode }) {
  const s = useSession(app);
  if (!s) return <div className={app === "ops" ? "" : "mobile"} style={app === "ops" ? { minHeight: "100%", background: "var(--app)" } : undefined}><DemoClock /><Login app={app} /></div>;
  return <>{children}</>;
}
