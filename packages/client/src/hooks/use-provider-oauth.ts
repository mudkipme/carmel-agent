import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useHarnessStore } from "@/store/harness-store";
import type { OAuthLoginFlowState, ProviderConfig } from "@carmel-agent/shared";

export function useProviderOAuth(selectedConfig?: ProviderConfig) {
  const bootstrap = useHarnessStore((state) => state.bootstrap);
  const [flow, setFlow] = useState<OAuthLoginFlowState | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (!flow || flow.status === "success" || flow.status === "error") return;
    const interval = window.setInterval(() => {
      void api.getOAuthLoginFlow(flow.id).then((next) => {
        setFlow(next);
        if (next.status === "success") void bootstrap();
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [bootstrap, flow]);

  const start = async () => {
    if (!selectedConfig) return;
    setInput("");
    const next = await api.startProviderOAuthLogin(selectedConfig.id);
    setFlow(next);
    if (next.auth?.url) window.open(next.auth.url, "_blank", "noopener,noreferrer");
  };

  const submit = async () => {
    if (!flow) return;
    const next = await api.submitOAuthLoginFlowInput(flow.id, input);
    setInput("");
    setFlow(next);
  };

  return {
    flow,
    input,
    reset: () => {
      setFlow(null);
      setInput("");
    },
    setFlow,
    setInput,
    start,
    submit,
  };
}
