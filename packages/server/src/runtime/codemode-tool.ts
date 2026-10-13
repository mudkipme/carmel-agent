import { CodemodeSandbox, parseCodemodeSource } from "@earendil-works/pi-codemode";
import { createCodemodeExtension as nativeCodemode } from "@earendil-works/pi-durable/codemode";
import {
  NestedCallDoc,
  LiveDoc,
  ToolTask,
  hook,
  type Extension,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";

export type CodemodeHooks = {
  signal?: AbortSignal;
  beforeCall?: () => void;
  timeoutMs?: number;
  maxCalls?: number;
};

/** Native execution plus Carmel's resource/admission policy; no result or progress adapter. */
export function createCarmelCodemode(hooks: CodemodeHooks = {}): Extension {
  const extension = nativeCodemode({ sandbox: new CodemodeSandbox(), models: false });
  const tool = extension.tools![0]!;
  return {
    ...extension,
    hooks: [
      hook(ToolTask, {
        beforeTool(call) {
          if (call.parent) {
            hooks.signal?.throwIfAborted();
            hooks.beforeCall?.();
          }
        },
      }),
    ],
    tools: [
      {
        ...tool,
        executionMode: "sequential",
        async execute({ code }, api, context) {
          const signal = AbortSignal.any([
            ...(context.abortSignal ? [context.abortSignal] : []),
            ...(hooks.signal ? [hooks.signal] : []),
          ]);
          context = withAbortSignal(signal, context);
          const source = parseCodemodeSource(code);
          const limits = await api.memo(
            "carmel.codemode.limits",
            {
              timeoutMs: Math.min(hooks.timeoutMs ?? 60_000, source.options.timeoutMs ?? Infinity),
              maxOutputTokens: Math.min(10_000, source.options.maxOutputTokens ?? Infinity),
              maxCalls: hooks.maxCalls ?? 250,
            },
            context,
          );
          const agent = await api.agent(context);
          const tools = new Map(agent.callable.map((tool) => [tool.name, tool]));
          let calls =
            (await api.snapshot(LiveDoc, api.conversationId, context))?.nestedTools?.filter(
              (call) => call.parentTaskId === api.taskId,
            ).length ?? 0;
          let barrier: Promise<unknown> = Promise.resolve();
          const pending = new Set<Promise<unknown>>();
          let ended = false;
          const executeTool: ToolExecutionApi["executeTool"] = (
            name,
            args,
            callContext,
            options,
          ) => {
            const sequential = tools.get(name)?.executionMode === "sequential";
            const before = sequential ? Promise.allSettled(pending) : barrier;
            const call = before.then(async () => {
              signal.throwIfAborted();
              if (ended) throw new Error("The script has ended.");
              const existing =
                options?.key &&
                (await api.snapshot(NestedCallDoc, api.taskId, options.key, callContext));
              if (!existing && ++calls > limits.maxCalls)
                throw new Error("Codemode nested tool call limit reached.");
              return api.executeTool(name, args, callContext, options);
            });
            pending.add(call);
            if (sequential) barrier = call.catch(() => {});
            void call.then(
              () => pending.delete(call),
              () => pending.delete(call),
            );
            return call;
          };
          const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
          try {
            return await nativeCodemode({ sandbox, models: false }).tools![0]!.execute(
              {
                code: `// @options: ${JSON.stringify({ timeout_ms: limits.timeoutMs, max_output_tokens: limits.maxOutputTokens })}\n${source.code}`,
              },
              { ...api, executeTool },
              context,
            );
          } finally {
            ended = true;
            await sandbox.close();
          }
        },
      },
    ],
  };
}
