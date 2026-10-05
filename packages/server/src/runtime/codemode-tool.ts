import type { CodemodeCallInfo } from "@carmel-agent/shared";
import {
  withAbortSignal,
  truncateHead,
  type AgentHarnessTool,
  type AgentToolResult,
  type ExecutionToolContext,
  type JsonValue,
} from "../effectors/pi-durable/index.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { CodemodeSandbox, parseCodemodeSource, renderDeclarations, type CodemodeJsonSchema, type CodemodeTool } from "@earendil-works/pi-codemode";
import { errorMessage } from "../errors.ts";

type Tool = AgentHarnessTool<ExecutionToolContext>;
export type CodemodeHooks = {
  signal?: AbortSignal;
  /** Admission happens before any nested external effect, including parallel calls. */
  beforeCall?: () => void;
  onActivity?: () => void;
  timeoutMs?: number;
  maxCalls?: number;
};

/** Expose the final permitted harness tools through Pi's VM; never expose codemode to itself. */
export function createCodemodeTool(availableTools: readonly Tool[], hooks: CodemodeHooks = {}): Tool {
  const tools = availableTools.filter((tool) => tool.name !== "codemode");
  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    // A declared output schema describes structuredContent; otherwise expose content blocks.
    outputSchema: tool.outputSchema as CodemodeJsonSchema | undefined ?? { type: "object", properties: { content: { type: "array", items: {} }, structuredContent: {} } },
    execute: () => {},
  } satisfies CodemodeTool));
  return {
    name: "codemode",
    label: "Codemode",
    description: `Run JavaScript to combine this agent's permitted tools, run independent calls with Promise.all, and filter results before returning them. Workspace, shell, network, MCP, and session tools are available only when listed below. Use await tools.<name>(args), text(value), return, or image("data:image/png;base64,..."). Check availability with "name" in tools; accessing an unknown tool throws. Tools with an output schema return their structuredContent; other tools return {content, structuredContent?}. Failed tools throw and can be caught. Only the script output and return value enter the model context. No direct filesystem, network, shell, or imports: use the injected tools with their existing permissions and workspace boundaries. An optional first line // @options: {"max_output_tokens": 1000, "timeout_ms": 10000} can lower the output and deadline limits. Each call uses a fresh sandbox; store/load are not persisted between calls. Execution is limited to ${hooks.timeoutMs ?? 60_000} ms, 64 MiB, and ${hooks.maxCalls ?? 250} nested calls.\n\n${renderDeclarations({ tools: declarations })}`,
    executionMode: "sequential",
    replay: "unsafe",
    parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript async function body; top-level await and return are supported." } }, required: ["code"], additionalProperties: false },
    async execute(toolCallId, { code }, onUpdate, toolContext, invocation, context) {
      const source = parseCodemodeSource(code as string);
      const calls: CodemodeCallInfo[] = [];
      const pending = new Set<Promise<unknown>>();
      const controller = new AbortController();
      let terminate = false;
      let sequentialBarrier: Promise<unknown> = Promise.resolve();
      const effects = new Set<Promise<unknown>>();
      const schedule = <T>(tool: Tool, run: () => Promise<T>): Promise<T> => {
        const before = tool.executionMode === "sequential" ? Promise.allSettled(effects) : sequentialBarrier;
        const effect = before.then(run);
        effects.add(effect);
        if (tool.executionMode === "sequential") sequentialBarrier = effect.then(() => {}, () => {});
        void effect.then(() => effects.delete(effect), () => effects.delete(effect));
        return effect;
      };
      const signal = AbortSignal.any([controller.signal, ...(context.abortSignal ? [context.abortSignal] : []), ...(hooks.signal ? [hooks.signal] : [])]);
      const snapshot = () => calls.map((call) => ({ ...call }));
      const update = () => {
        hooks.onActivity?.();
        onUpdate({ content: [], details: { codemodeCalls: snapshot() } }, { checkpoint: true });
      };
      signal.throwIfAborted();

      const sandbox = new CodemodeSandbox({
        timeoutMs: hooks.timeoutMs ?? 60_000,
        memoryLimitBytes: 64 * 1024 * 1024,
        tools: tools.map((tool, index) => ({
          ...declarations[index]!,
          execute(args, { signal: nestedSignal }) {
            const nestedContext = withAbortSignal(AbortSignal.any([signal, nestedSignal]), context);
            const task = (async () => {
              nestedContext.abortSignal?.throwIfAborted();
              if (calls.length >= (hooks.maxCalls ?? 250)) {
                controller.abort(new Error("Codemode nested tool call limit reached."));
                signal.throwIfAborted();
              }
              const startedAt = performance.now();
              const call: CodemodeCallInfo = { id: `${toolCallId}:${calls.length}`, name: tool.name, label: tool.label, status: "running", durationMs: 0 };
              calls.push(call);
              try {
                hooks.beforeCall?.();
                nestedContext.abortSignal?.throwIfAborted();
                update();
                const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
                if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) throw new Error("Tool arguments must be an object.");
                const params = validateToolArguments(tool, { type: "toolCall", id: call.id, name: tool.name, arguments: prepared as Record<string, JsonValue> });
                const childInvocation = {
                  ...invocation, durableApi: undefined, invocationId: `${invocation.invocationId}:${call.id}`,
                };
                const result = await schedule(tool, async () => {
                  nestedContext.abortSignal?.throwIfAborted();
                  if (terminate) throw new Error("A tool requested the end of this batch.");
                  const result = await tool.execute(call.id, params, () => update(), toolContext, childInvocation, nestedContext);
                  if (result.terminate) terminate = true;
                  return result;
                });
                nestedContext.abortSignal?.throwIfAborted();
                if (result.isError) throw new Error(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "Tool failed.");
                call.status = "ok";
                return tool.outputSchema && result.structuredContent !== undefined
                  ? result.structuredContent
                  : { content: result.content, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
              } catch (error) {
                call.status = nestedContext.abortSignal?.aborted ? "cancelled" : "error";
                throw error;
              } finally {
                call.durationMs = Math.round(performance.now() - startedAt);
                update();
              }
            })();
            pending.add(task);
            void task.then(() => pending.delete(task), () => pending.delete(task));
            return task;
          },
        })),
      });
      try {
        const result = await sandbox.execute(source.code, { signal, timeoutMs: Math.min(hooks.timeoutMs ?? 60_000, source.options.timeoutMs ?? Infinity) });
        // Pi aborts unfinished calls on timeout, cancellation, and script return. Drain their
        // host-side cleanup before finalizing details or releasing the execution environment.
        await Promise.allSettled(pending);
        const output = [...result.output];
        if (result.ok && result.value !== undefined) output.push({ type: "text", text: JSON.stringify(result.value) });
        if (!result.ok) output.push({ type: "text", text: result.error.stack ?? result.error.message });
        const text = truncateHead(output.filter((part) => part.type === "text").map((part) => part.text).join("\n"), { maxBytes: Math.min(50 * 1024, (source.options.maxOutputTokens ?? Infinity) * 4) });
        const final: AgentToolResult = {
          content: [
            { type: "text", text: text.content + (text.truncated ? "\n[Output truncated. Return a smaller summary.]" : "") },
            ...output.filter((part) => part.type === "image"),
          ],
          details: { codemodeCalls: snapshot(), codemodeError: !result.ok }, isError: !result.ok,
          ...(terminate ? { terminate: true } : {}),
        };
        return final;
      } catch (error) {
        throw new Error(`Codemode: ${errorMessage(error)}`);
      } finally {
        await sandbox.close();
      }
    },
  };
}
