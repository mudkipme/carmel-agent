import { applyImmutable } from "@earendil-works/chord/delta";
import type { LiveState } from "@earendil-works/pi-durable";
import type { AgentRunEvent } from "./index.ts";

export type RunProgress = {
  live?: LiveState;
  errorMessage?: string;
  contextPressure?: { level: "warning" | "critical"; message: string };
};

export function applyRunProgress(progress: RunProgress, event: AgentRunEvent): RunProgress {
  switch (event.type) {
    case "live_update":
      return { ...progress, live: applyImmutable<LiveState>(progress.live ?? {}, event.ops) };
    case "run_finished":
      return { ...progress, live: undefined };
    case "turn_end":
      return event.errorMessage ? { ...progress, errorMessage: event.errorMessage } : progress;
    case "context_pressure":
      return { ...progress, contextPressure: { level: event.level, message: event.message } };
    case "run_recovered":
      return {
        ...progress,
        errorMessage: undefined,
        contextPressure: { level: "warning", message: event.message },
      };
    default:
      return progress;
  }
}
