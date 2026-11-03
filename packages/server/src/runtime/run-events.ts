import type { Op } from "@earendil-works/chord/delta";
import type { RunChange } from "../effectors/pi-durable/run.ts";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { type AgentRunEvent } from "@carmel-agent/shared";
import { displayEntries } from "../services/pi-session-storage.ts";
import { classifyTurnFailure, type TurnFailure } from "../effectors/failure-classifier.ts";

export function isOverflowMessage(message: string): boolean {
  return isContextOverflow({ stopReason: "error", errorMessage: message } as AssistantMessage);
}

export function classifyAssistantFailure(
  message: AssistantMessage,
  contextWindow?: number,
): TurnFailure | undefined {
  const overflowHint = isContextOverflow(message, contextWindow);
  if (!message.errorMessage && !overflowHint) return undefined;
  return classifyTurnFailure({
    message: message.errorMessage ?? "",
    aborted: message.stopReason === "aborted",
    transientHint: isRetryableAssistantError(message),
    overflowHint,
  });
}

/** Keep Pi's live deltas in their native vocabulary; transcript IDs use Carmel's serializer. */
export function projectRunEvent(event: RunChange): AgentRunEvent | undefined {
  if (event.type === "message_end") {
    const display = displayEntries([event.entry])[0];
    return display?.type === "message"
      ? { type: "message_end", message: display.message }
      : undefined;
  }
  const ops: Op[] = [];
  for (const op of event.ops) {
    if (op[0] === "r" || (op[1][0] === "docs" && op[1].length <= 2)) {
      if (op[0] === "r" || op[1].length === 1 || op[1][1] === "pi.live") {
        ops.push(["r", event.value.docs["pi.live"] ?? {}]);
        break;
      }
    } else if (op[1][0] === "docs" && op[1][1] === "pi.live") {
      ops.push([op[0], op[1].slice(2), ...op.slice(2)] as unknown as Op);
    }
  }
  return ops.length ? { type: "live_update", ops } : undefined;
}
