import { useEffect } from "react";
import { HarnessShell } from "@/components/harness/HarnessShell";
import { Splash } from "@/components/harness/Splash";
import { useHarnessStore } from "@/store/harness-store";

export default function App() {
  const status = useHarnessStore((state) => state.status);
  const error = useHarnessStore((state) => state.error);
  const bootstrap = useHarnessStore((state) => state.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status === "loading" || status === "idle") {
    return <Splash title="Loading harness" detail="Connecting to the SQLite-backed API." />;
  }

  if (status === "error") {
    return <Splash title="API unavailable" detail={error ?? "Start the server with pnpm dev:server."} />;
  }

  return <HarnessShell />;
}
