import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AgentDoc,
  GenerationTask,
  InboxDoc,
  LiveDoc,
  defineExtension,
  hook,
  section,
  watchEvents,
  type AgentEvent,
  type AgentChange,
  type AgentEventStream,
  type EntryId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  appendPiMessage,
  displayEntries,
  navigatePiSession,
  readPiSessionBranch,
  scanEntries,
  type PiSession,
} from "../../services/pi-session-storage.ts";
import type {
  AgentHarnessTool,
  ExecutionToolContext,
  HarnessEvent,
  HarnessEventType,
} from "./index.ts";
import {
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  type Skill,
  type PromptTemplate,
} from "./resources.ts";
const ctx = BACKGROUND_CONTEXT;
export type AgentHarnessOptions<T = ExecutionToolContext> = {
  session: PiSession;
  models: Models;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  promptSections?: Record<string, string | undefined>;
  tools?: AgentHarnessTool<T>[];
  toolContext?: T;
  activeToolNames?: string[];
  resources?: { skills?: Skill[]; promptTemplates?: PromptTemplate[] };
  retry?: { enabled: boolean; maxRetries: number; baseDelayMs?: number };
  compaction?: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
    backgroundTokens?: number;
  };
  streamOptions?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
};
/** Thin adaptation of Carmel's run/tool contracts. Pi Durable owns execution and persistence. */
export class AgentHarness<T = ExecutionToolContext> {
  readonly events = {
    on: (type: HarnessEventType, listener: (event: HarnessEvent) => void | Promise<void>) => {
      const handler = (event: HarnessEvent) => {
        if (event.type === type) return listener(event);
      };
      this.listeners.add(handler);
      return () => {
        this.listeners.delete(handler);
      };
    },
  };
  readonly hooks = {
    on: (_type: "before_request", listener: () => Promise<unknown>) => {
      this.beforeRequests.add(listener);
      return () => {
        this.beforeRequests.delete(listener);
      };
    },
  };
  private readonly beforeRequests = new Set<() => Promise<unknown>>();
  private readonly listeners = new Set<(event: HarnessEvent) => void | Promise<void>>();
  private stream?: AgentEventStream;
  private lastAssistant?: AssistantMessage;
  private streaming?: AssistantMessage;
  private lastEntryId = 0;
  private running = false;
  private readonly runningTools = new Map<string, string>();
  private constructor(readonly options: AgentHarnessOptions<T>) {}
  static async create<T = ExecutionToolContext>(options: AgentHarnessOptions<T>, context: Context) {
    const harness = new AgentHarness(options);
    const session = options.session;
    session.models = options.models;
    session.env = (options.toolContext as ExecutionToolContext | undefined)?.env;
    session.settings = {
      stream: options.streamOptions,
      retry: {
        maxRetries: options.retry?.enabled === false ? 0 : (options.retry?.maxRetries ?? 2),
        baseDelayMs: options.retry?.baseDelayMs ?? 1_000,
      },
      compaction: options.compaction,
      progress: { partialIntervalMs: 20, outputIntervalMs: 50 },
    };
    const tools = (options.tools ?? []).map((tool) => toDurableTool(tool, options.toolContext!));
    session.registry.install(
      defineExtension({
        name: "carmel",
        tools,
        sections: Object.entries(options.promptSections ?? { system: options.systemPrompt }).map(
          ([key, text]) => section(key, () => text, { tag: false }),
        ),
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async () => {
              for (const listener of harness.beforeRequests) await listener();
            },
          }),
        ],
      }),
    );
    const state = await session.native.snapshot(AgentDoc, session.conversation.id, context);
    // Existing choices stay until the run explicitly reconciles them.
    if (!state?.model)
      await session.conversation.configure(
        {
          model: { provider: options.model.provider, modelId: options.model.id },
          thinkingLevel: options.thinkingLevel ?? "off",
          tools: tools.filter(
            (t) => !options.activeToolNames || options.activeToolNames.includes(t.name),
          ),
        },
        context,
      );
    await harness.attachEvents(context);
    return { harness, tools };
  }
  private async attachEvents(context: Context) {
    await this.stream?.stop();
    this.stream = await watchEvents(
      this.options.session.native,
      this.options.session.conversation.id,
      context,
    );
    this.lastEntryId = Math.max(0, ...this.stream.snapshot.entries.map((entry) => entry.id));
    this.running = Boolean(this.stream.snapshot.run);
    this.streaming = undefined;
    this.runningTools.clear();
    this.stream.start(async (events) => {
      for (const event of events) await this.accept(event);
    });
  }
  async emit(event: HarnessEvent) {
    for (const listener of this.listeners) await listener(event);
  }
  private async updateBlock(contentIndex: number, block: AssistantMessage["content"][number]) {
    const previous = this.streaming?.content[contentIndex];
    if (block.type === "text" || block.type === "thinking") {
      const field = block.type === "text" ? "text" : "thinking";
      const text = block.type === "text" ? block.text : block.thinking;
      const before =
        previous?.type === "text" && field === "text"
          ? previous.text
          : previous?.type === "thinking" && field === "thinking"
            ? previous.thinking
            : "";
      if (text.startsWith(before)) {
        if (text.length > before.length)
          await this.emit({
            type: "message_update",
            event: {
              type: `${field}_delta`,
              contentIndex,
              delta: text.slice(before.length),
              partial: this.streaming!,
            } as AssistantMessageEvent,
          });
      } else await this.emit({ type: "message_part", contentIndex, part: structuredClone(block) });
    } else if (JSON.stringify(block) !== JSON.stringify(previous))
      await this.emit({ type: "message_part", contentIndex, part: structuredClone(block) });
    if (this.streaming) this.streaming.content[contentIndex] = structuredClone(block);
  }
  private async accept(event: AgentEvent) {
    switch (event.type) {
      case "snapshot": {
        // A slow listener receives one committed snapshot instead of an unbounded event backlog.
        const through = Math.max(0, ...event.entries.map((entry) => entry.id));
        const history = await this.options.session.native.commit(
          (tx) =>
            scanEntries(tx, this.options.session.conversation.id, {
              minEntryId: (this.lastEntryId + 1) as EntryId,
              maxEntryId: through as EntryId,
            }),
          ctx,
        );
        for (const entry of history) {
          const message = entry.model?.[0];
          if (message?.role === "toolResult")
            await this.accept({
              type: "tool_execution_end",
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              entry,
            });
          await this.accept({ type: "message_end", entry });
        }
        for (const slot of event.tools.filter((tool) => tool.status === "running")) {
          await this.accept({
            type: "tool_execution_start",
            toolCallId: slot.callId,
            toolName: slot.name,
            args: {},
          });
          await this.accept({
            type: "tool_execution_update",
            toolCallId: slot.callId,
            toolName: slot.name,
            details: slot.details,
          });
        }
        for (const [toolCallId, toolName] of this.runningTools)
          if (!event.tools.some((tool) => tool.callId === toolCallId && tool.status === "running"))
            await this.accept({ type: "tool_execution_end", toolCallId, toolName });
        if (event.generation?.message) {
          this.streaming = structuredClone(event.generation.message);
          await this.emit({
            type: "message_start",
            message: structuredClone(event.generation.message),
          });
        }
        await this.emit({
          type: "queue_update",
          queues: event.inbox.map((item) => ({ entryId: `submission:${item.id}` })),
        });
        if (this.running && !event.run) {
          if (this.lastAssistant)
            await this.emit({ type: "turn_end", message: this.lastAssistant, toolResults: [] });
          await this.emit({ type: "run_end" });
        }
        this.running = Boolean(event.run);
        break;
      }
      case "run_start":
        this.running = true;
        break;
      case "message_start":
        if (event.message.role === "assistant") this.streaming = structuredClone(event.message);
        await this.emit({ type: "message_start", message: event.message });
        break;
      case "message_update": {
        for (const change of event.changes) {
          if (change.type === "message") {
            if (!this.streaming) {
              this.streaming = structuredClone(change.message);
              await this.emit({ type: "message_start", message: structuredClone(change.message) });
            } else
              for (const [index, block] of change.message.content.entries())
                await this.updateBlock(index, block);
            continue;
          }
          const partial = this.streaming;
          if (!partial) continue;
          partial.usage = event.usage;
          if ("block" in change) {
            await this.updateBlock(change.contentIndex, change.block);
          } else if (change.type === "text_delta" || change.type === "thinking_delta") {
            const block = partial.content[change.contentIndex];
            if (block?.type === "text" && change.type === "text_delta") block.text += change.delta;
            if (block?.type === "thinking" && change.type === "thinking_delta")
              block.thinking += change.delta;
            await this.emit({
              type: "message_update",
              event: {
                type: change.type,
                contentIndex: change.contentIndex,
                delta: change.delta,
                partial,
              } as AssistantMessageEvent,
            });
          }
        }
        break;
      }
      case "message_end": {
        if (event.entry.id <= this.lastEntryId) break;
        this.lastEntryId = event.entry.id;
        const display = displayEntries([event.entry])[0];
        if (display?.type !== "message") break;
        if (display.message.role === "assistant") {
          // The final commit may include deltas not yet flushed by progress batching.
          if (this.streaming)
            for (const [index, block] of display.message.content.entries())
              await this.updateBlock(index, block);
          this.lastAssistant = display.message;
          this.streaming = undefined;
        }
        await this.emit({ type: "message_end", message: display.message });
        break;
      }
      case "turn_end":
        if (this.lastAssistant)
          await this.emit({ type: "turn_end", message: this.lastAssistant, toolResults: [] });
        break;
      case "run_end":
        this.running = false;
        await this.emit({ type: "run_end" });
        break;
      case "tool_execution_start":
        if (this.runningTools.has(event.toolCallId)) break;
        this.runningTools.set(event.toolCallId, event.toolName);
        await this.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        await this.emit({
          type: "tool_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: { content: [], details: event.details },
        });
        break;
      case "tool_execution_end":
        this.runningTools.delete(event.toolCallId);
        await this.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.entry?.model?.some((m) => m.role === "toolResult" && m.isError) ?? true,
        });
        break;
      case "inbox_update": {
        await this.emit({
          type: "queue_update",
          queues: event.items.map((item) => ({ entryId: `submission:${item.id}` })),
        });
        break;
      }
      case "compaction_end": {
        const task = await this.options.session.native.getTask(event.taskId, ctx);
        const outcome = task?.state.status === "terminal" ? task.state.outcome : undefined;
        await this.emit({
          type: "compaction_end",
          reason: event.reason,
          status:
            outcome?.status === "completed"
              ? outcome.result &&
                typeof outcome.result === "object" &&
                ("entryId" in outcome.result || "submissionId" in outcome.result)
                ? "completed"
                : "skipped"
              : "failed",
          error: {
            message:
              outcome && "error" in outcome
                ? (outcome.error?.message ?? "Compaction failed.")
                : "Compaction did not complete.",
          },
        });
        break;
      }
    }
  }
  nextRunEnd() {
    let unsubscribe = () => {};
    const delivered = new Promise<void>((resolve) => {
      unsubscribe = this.events.on("run_end", () => resolve());
    });
    const result = Promise.race([
      delivered,
      this.stream!.closed.then(() => {
        throw new Error("Pi Durable event stream closed before the run ended.");
      }),
    ]).finally(() => unsubscribe());
    void result.catch(() => {});
    return result;
  }
  async getResources(_context: Context) {
    return this.options.resources ?? {};
  }
  async lane(_name: string, _context: Context) {
    return new AgentLane(this);
  }
  async close(_context: Context) {
    await this.stream?.stop();
    this.listeners.clear();
  }
  async navigate(id: string | null) {
    await navigatePiSession(this.options.session, id);
    await this.attachEvents(ctx);
  }
}
export class AgentLane {
  constructor(private readonly harness: AgentHarness<any>) {}
  private get session() {
    return this.harness.options.session;
  }
  async hasPending(context: Context) {
    const live = await this.session.native.snapshot(LiveDoc, this.session.conversation.id, context);
    const inbox = await this.session.native.snapshot(
      InboxDoc,
      this.session.conversation.id,
      context,
    );
    return Boolean(live?.run || inbox?.items.length);
  }
  async resume(context: Context) {
    if (!(await this.hasPending(context))) return;
    const delivered = this.harness.nextRunEnd();
    this.session.native.resume();
    await this.session.conversation.waitForIdle(context);
    await delivered;
  }
  async prompt(text: string, images: ImageContent[] | undefined, context: Context) {
    // Recovery runs only after the application has installed credentials and permitted tools.
    await this.resume(context);
    const delivered = this.harness.nextRunEnd();
    const submission = await this.session.conversation.submit(
      {
        type: "input",
        content: images?.length ? [{ type: "text", text }, ...images] : text,
        whenBusy: "reject",
      },
      context,
    );
    const settled = await submission.wait(context);
    await delivered;
    if (settled.status === "unanswered" && !["aborted", "model_error"].includes(settled.reason))
      throw new Error(
        `Pi Durable could not answer the input: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ""}`,
      );
  }
  async skill(name: string, instructions: string | undefined, context: Context) {
    const skill = this.harness.options.resources?.skills?.find((s) => s.name === name);
    if (!skill) throw new Error(`Skill not loaded: ${name}`);
    await this.prompt(formatSkillInvocation(skill, instructions), undefined, context);
  }
  async promptFromTemplate(name: string, args: string[], context: Context) {
    const template = this.harness.options.resources?.promptTemplates?.find((t) => t.name === name);
    if (!template) throw new Error(`Prompt template not loaded: ${name}`);
    await this.prompt(formatPromptTemplateInvocation(template, args), undefined, context);
  }
  async configure(change: AgentChange, context: Context) {
    await this.session.conversation.configure(change, context);
  }
  async findEntries(_query: { order?: string }, _context: Context) {
    return readPiSessionBranch(this.session);
  }
  async appendMessage(
    message: import("@earendil-works/pi-agent-core").AgentMessage,
    _context: Context,
  ) {
    return appendPiMessage(this.session, message);
  }
  async navigateTree(id: string | null, _options: { summarize: boolean }, _context: Context) {
    await this.harness.navigate(id);
  }
  async abort(context: Context) {
    await this.session.conversation.abort(context);
  }
  async steer(text: string, images: ImageContent[] | undefined, context: Context) {
    const submission = await this.session.conversation.submit(
      {
        type: "input",
        content: images?.length ? [{ type: "text", text }, ...images] : text,
        whenBusy: "steer",
      },
      context,
    );
    const record = await submission.status(context);
    return {
      ok: true as const,
      value: {
        entryId:
          "entry" in record && record.entry
            ? `durable:${record.entry}`
            : `submission:${submission.id}`,
      },
    };
  }
  async cancelQueued(id: string, context: Context) {
    if (id.startsWith("submission:"))
      await this.session.native.abortSubmission(
        Number(id.slice(11)) as import("@earendil-works/pi-durable").SubmissionId,
        context,
        this.session.conversation.id,
      );
  }
  async watch(context: Context) {
    const inbox = await this.session.native.snapshot(
      InboxDoc,
      this.session.conversation.id,
      context,
    );
    return {
      snapshot: {
        queues: (inbox?.items ?? []).map((item) => ({ entryId: `submission:${item.id}` })),
      },
      unsubscribe() {},
    };
  }
}
function toDurableTool<T>(tool: AgentHarnessTool<T>, toolContext: T): ToolRegistration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: tool.replay ?? "unsafe",
    executionMode: tool.executionMode,
    outputLimits: tool.outputLimits,
    prepareArguments: tool.prepareArguments,
    async execute(args, api, context) {
      const updates: Promise<void>[] = [];
      const result = await tool.execute(
        api.callId,
        args,
        (partial) => {
          if (partial.details !== undefined) {
            const update = api.details(JSON.parse(JSON.stringify(partial.details)), context);
            updates.push(update);
            // Keep synchronous update callbacks from producing unhandled rejections.
            void update.catch(() => {});
          }
          for (const part of partial.content) if (part.type === "text") api.output(part.text);
        },
        toolContext,
        {
          durableApi: api,
          invocationId: String(api.taskId),
          operationId: String(api.taskId),
          turnId: String(api.taskId),
        },
        context,
      );
      await Promise.all(updates);
      return {
        content: result.useStreamedOutput ? undefined : result.content,
        details:
          result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details)),
        diagnostics: result.diagnostics,
        isError: result.isError,
        usage: result.usage,
        ...(result.terminate ? { control: { terminate: true } } : {}),
      };
    },
  };
}
