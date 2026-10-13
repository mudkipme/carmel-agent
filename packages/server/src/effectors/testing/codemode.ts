import type { ToolRegistration } from "../pi-durable/index.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createCarmelCodemode, type CodemodeHooks } from "../../runtime/codemode-tool.ts";
import { createSession } from "../../test-support.ts";
import { fauxHarnessModels, openTestHarness } from "./pi-harness.ts";

/** Exercise the actual native tool tasks, not a fake in-memory executeTool API. */
export async function executeNativeCodemode(
  tools: readonly ToolRegistration[],
  code: string,
  options: {
    hooks?: CodemodeHooks;
    signal?: AbortSignal;
    env?: import("@earendil-works/pi-durable/env").ExecutionEnv;
    onEvent?: (event: import("../pi-durable/index.ts").AgentEvent) => void;
  } = {},
): Promise<import("@earendil-works/pi-ai").ToolResultMessage> {
  const { sessionId } = createSession();
  const { faux, ...models } = fauxHarnessModels();
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Done"),
  ]);
  const extension = createCarmelCodemode(options.hooks);
  const pi = await openTestHarness(sessionId, {
    ...models,
    tools: [...tools.filter((tool) => tool.name !== "codemode"), ...extension.tools!],
    extensions: [extension],
    env: options.env,
  });
  const unsubscribe = pi.observe((event) => options.onEvent?.(event));
  const abort = () => void pi.lane.abort(pi.context);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await pi.lane.prompt("Run script", undefined, pi.context);
    const entries = await pi.branch();
    const result = entries
      .flatMap((entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "codemode"
          ? [entry.message]
          : [],
      )
      .at(-1);
    if (!result) throw new Error("Native Codemode produced no result.");
    return result;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    await pi.close();
  }
}
