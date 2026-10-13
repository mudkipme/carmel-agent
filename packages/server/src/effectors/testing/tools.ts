import type { Context } from "@earendil-works/chord";
import type { ToolRegistration, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { initialize } from "../../db/index.ts";
import { createSession } from "../../test-support.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxHarnessModels, openTestHarness } from "./pi-harness.ts";

/** Run the real native task/validation/output machinery for tool unit fixtures. */
export async function executeNativeTool(
  tool: ToolRegistration,
  args: unknown,
  env?: ExecutionEnv,
  context: Context = BACKGROUND_CONTEXT,
  onEvent?: (event: import("../pi-durable/index.ts").AgentEvent) => void,
): Promise<ToolExecutionResult> {
  initialize();
  const { sessionId } = createSession();
  const { faux, ...models } = fauxHarnessModels();
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall(tool.name, args as never)], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Done"),
  ]);
  let saved: ToolExecutionResult | undefined;
  let failure: unknown;
  const wrapped: ToolRegistration = {
    ...tool,
    async execute(args, api, ctx) {
      try {
        saved = await tool.execute(args, api, {
          ...ctx,
          abortSignal: context.abortSignal ?? ctx.abortSignal,
        });
        return saved;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  };
  const pi = await openTestHarness(sessionId, { ...models, tools: [wrapped], env });
  const unsubscribe = pi.observe((event) => onEvent?.(event));
  const stop = () => void pi.lane.abort(pi.context);
  context.abortSignal?.addEventListener("abort", stop, { once: true });
  try {
    await pi.lane.prompt("Call tool", undefined, pi.context);
    if (failure) throw failure;
    const message = (await pi.branch())
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
      )
      .at(-1);
    if (!message) throw new Error("Tool produced no result.");
    return { ...saved, output: message.content, isError: message.isError };
  } finally {
    context.abortSignal?.removeEventListener("abort", stop);
    unsubscribe();
    await pi.close();
  }
}
