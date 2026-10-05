import { createBashTool as bash, createEditTool as edit, createReadTool as read, createWriteTool as write } from "@earendil-works/pi-durable/tools";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentHarnessTool, ExecutionToolContext } from "./index.ts";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createReadTool as codingRead, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
/** Adapt native tools for Carmel's tool providers and nested codemode calls. */
function adapt<T extends ExecutionToolContext>(native: ToolRegistration): AgentHarnessTool<T> {
  return {
    ...native, label: native.name,
    async execute(_id, args, onUpdate, tools, invocation, context) {
      if (invocation.durableApi) {
        const result = await native.execute(args, invocation.durableApi, context);
        return { ...result, content: result.content ?? [], useStreamedOutput: result.content === undefined, terminate: result.control?.terminate };
      }
      let output = "";
      const diagnostics: string[] = [];
      const api = {
        env: tools.env, callId: _id, outputWindow: undefined,
        output(text: string | Uint8Array) { output = (output + (typeof text === "string" ? text : new TextDecoder().decode(text))).slice(-50_000); onUpdate({ content: [{ type: "text", text: output }] }); },
        diagnostic(value: { message: string }) { diagnostics.push(value.message); },
        async details(value: unknown) { onUpdate({ content: [], details: value }); },
      } as unknown as ToolExecutionApi;
      const result = await native.execute(args, api, context);
      return { ...result, content: [...(result.content ?? (output ? [{ type: "text" as const, text: output }] : [])), ...[...diagnostics, ...(result.diagnostics ?? []).map(item => item.message)].map(text => ({ type: "text" as const, text }))], terminate: result.control?.terminate };
    },
  };
}
export function createReadTool<T extends ExecutionToolContext>(): AgentHarnessTool<T> {
  const native = adapt<T>(read());
  return { ...native, replay: "safe", description: native.description + " Images can also be read.",
    async execute(id, args, update, tools, invocation, context) {
      const result = await native.execute(id, args, update, tools, invocation, context);
      if (!result.diagnostics?.some(diagnostic => diagnostic.code === "unsupported_image")) return result;
      // Durable 1.0.3 reads text only. Keep Pi's native image reader behind the same guarded environment.
      const imageReader = codingRead(tools.env.cwd, { operations: {
        readFile: async path => Buffer.from(getOrThrow(await tools.env.readBinaryFile(path, context))),
        access: async path => { getOrThrow(await tools.env.readBinaryFile(path, context)); },
        detectImageMimeType: async path => detectSupportedImageMimeTypeFromFile(getOrThrow(await tools.env.canonicalPath(path, context))),
      } });
      return imageReader.execute(id, args, context.abortSignal, update);
    },
  };
}
export function createWriteTool<T extends ExecutionToolContext>() { return adapt<T>(write()); }
export function createEditTool<T extends ExecutionToolContext>() { return adapt<T>(edit()); }
export function createBashTool<T extends ExecutionToolContext>() { return adapt<T>(bash()); }
