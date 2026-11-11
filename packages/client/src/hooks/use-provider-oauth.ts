import { useLingui } from "@lingui/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";
import type { OAuthLoginFlowState, ProviderConfig } from "@carmel-agent/shared";

export function useProviderOAuth(selectedConfig?: ProviderConfig) {
  const { i18n } = useLingui();
  const bootstrap = useHarnessStore((state) => state.bootstrap);
  const [flow, setFlow] = useState<OAuthLoginFlowState | null>(null);
  const [input, setInput] = useState("");
  // Ignore responses that arrive after the user dismissed or replaced the flow.
  const generation = useRef(0);

  useEffect(() => {
    if (!flow || flow.status === "success" || flow.status === "error") return;
    const current = generation.current;
    const interval = window.setInterval(() => {
      void api
        .getOAuthLoginFlow(flow.id)
        .then((next) => {
          if (generation.current !== current) return;
          setFlow(next);
          if (next.status === "success") void bootstrap();
        })
        .catch(() => {
          // A transient poll failure must not surface as an unhandled rejection.
        });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [bootstrap, flow]);

  const start = async () => {
    if (!selectedConfig) return;
    setInput("");
    generation.current += 1;
    try {
      const next = await api.startProviderOAuthLogin(selectedConfig.id);
      setFlow(next);
      if (next.auth?.url) window.open(next.auth.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      showError(i18n._("Unable to start OAuth login"), error);
    }
  };

  const submit = async () => {
    if (!flow) return;
    try {
      const next = await api.submitOAuthLoginFlowInput(flow.id, input);
      setInput("");
      setFlow(next);
    } catch (error) {
      showError(i18n._("Unable to submit OAuth login"), error);
    }
  };

  return {
    flow,
    input,
    reset: () => {
      generation.current += 1;
      setFlow(null);
      setInput("");
    },
    setFlow,
    setInput,
    start,
    submit,
  };
}
