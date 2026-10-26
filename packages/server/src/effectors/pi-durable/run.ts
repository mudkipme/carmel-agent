import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
import type { ResolvedReferences } from "../../services/prompt-references.ts";
import type { UserRequestReceipt } from "@carmel-agent/shared";
import type { ImageContent, Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  defineExtension,
  section,
  watchEvents,
  type AgentChange,
  type AgentEvent,
  type AgentEventStream,
  type EntryId,
  type Extension,
  type HarnessSettings,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { scanEntries, type PiSession } from "../../services/pi-session-storage.ts";

export type PiRunOptions = {
  models: Models;
  agent: AgentChange;
  tools?: ToolRegistration[];
  env?: ExecutionEnv;
  extensions?: Extension[];
  sections?: Record<string, string | undefined>;
  settings?: HarnessSettings;
};

/** Application observation and input settlement; execution stays on native conversation handles. */
export class PiRun {
  private stream!: AgentEventStream;
  private lastEntryId = 0;
  private running = false;
  private readonly runningTools = new Map<string, string>();
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private constructor(
    readonly session: PiSession,
    private readonly context: Context,
  ) {}

  static async open(session: PiSession, options: PiRunOptions, context: Context) {
    session.models = options.models;
    session.env = options.env;

    for (const extension of options.extensions ?? []) session.registry.install(extension);
    const carmel = defineExtension({
      name: "carmel",
      tools: options.tools ?? [],
      sections: Object.entries(options.sections ?? {}).map(([key, text]) =>
        section(key, () => text, { tag: false }),
      ),
    });
    session.registry.install(carmel);
    session.settings = { ...options.settings, extensions: [...(options.extensions ?? []), carmel] };
    if (!(await session.native.snapshot(AgentDoc, session.conversation.id, context))?.model)
      await session.conversation.configure(options.agent, context);
    const run = new PiRun(session, context);
    await run.attach();
    return run;
  }

  get snapshot() {
    return this.stream.snapshot;
  }

  observe(listener: (event: AgentEvent) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reattach after a branch mutation; native watch captures history and progress atomically. */
  async attach() {
    await this.stream?.stop();
    this.stream = await watchEvents(
      this.session.native,
      this.session.conversation.id,
      this.context,
    );
    this.lastEntryId = Math.max(0, ...this.stream.snapshot.entries.map((entry) => entry.id));
    this.running = Boolean(this.stream.snapshot.run);
    this.runningTools.clear();
    this.stream.start(async (events) => {
      for (const event of events) await this.accept(event);
    });
  }

  private async emit(event: AgentEvent) {
    for (const listener of this.listeners) await listener(event);
  }

  private async accept(event: AgentEvent) {
    if (event.type === "snapshot") {
      // Native backlog replacement can omit old entries; recover only the missing committed range.
      const through = Math.max(0, ...event.entries.map((entry) => entry.id));
      const history = await this.session.native.commit(
        (tx) =>
          scanEntries(tx, this.session.conversation.id, {
            minEntryId: (this.lastEntryId + 1) as EntryId,
            maxEntryId: through as EntryId,
          }),
        this.context,
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
      for (const slot of event.tools.filter((tool) => tool.status === "running"))
        await this.accept({
          type: "tool_execution_start",
          toolCallId: slot.callId,
          toolName: slot.name,
          args: {},
          taskId: slot.taskId,
        });
      await this.emit(event);
      for (const [toolCallId, toolName] of this.runningTools)
        if (!event.tools.some((slot) => slot.callId === toolCallId && slot.status === "running"))
          await this.accept({ type: "tool_execution_end", toolCallId, toolName });
      if (event.generation?.message)
        await this.emit({ type: "message_start", message: event.generation.message });
      if (this.running && !event.run) {
        await this.emit({ type: "turn_end" });
        await this.emit({ type: "run_end", inputs: [] });
      }
      this.running = Boolean(event.run);
      return;
    }
    if (event.type === "message_end") {
      if (event.entry.id <= this.lastEntryId) return;
      this.lastEntryId = event.entry.id;
    } else if (event.type === "run_start") this.running = true;
    else if (event.type === "run_end") this.running = false;
    else if (event.type === "tool_execution_start" && !event.parentToolCallId) {
      if (this.runningTools.has(event.toolCallId)) return;
      this.runningTools.set(event.toolCallId, event.toolName);
    } else if (event.type === "tool_execution_end" && !event.parentToolCallId)
      this.runningTools.delete(event.toolCallId);
    await this.emit(event);
  }

  private nextRunEnd() {
    let unsubscribe = () => {};
    const delivered = new Promise<void>((resolve) => {
      unsubscribe = this.observe((event) => {
        if (event.type === "run_end") resolve();
      });
    });
    const result = Promise.race([
      delivered,
      this.stream.closed.then(() => {
        throw new Error("Pi Durable event stream closed before the run ended.");
      }),
    ]).finally(() => unsubscribe());
    void result.catch(() => {});
    return result;
  }

  async hasPending(context: Context) {
    // Inspect both documents in one native transaction; an input may move between inbox and live run.
    return this.session.conversation.commit(
      async (tx) =>
        Boolean(
          (await tx.doc(LiveDoc, this.session.conversation.id)).run ||
          (await tx.doc(InboxDoc, this.session.conversation.id)).items.length,
        ),
      context,
    );
  }

  async resume(context: Context) {
    if (!(await this.hasPending(context))) return;
    const delivered = this.nextRunEnd();
    await this.session.conversation.waitForIdle(context);
    await delivered;
  }

  async prompt(
    text: string,
    images: ImageContent[] | undefined,
    context: Context,
    resolved?: ResolvedReferences,
    delivery?: {
      requestId: string;
      receipt?: UserRequestReceipt;
      onSubmitted?: () => void;
      source?: Record<string, JsonValue>;
    },
  ) {
    await this.resume(context);
    const delivered = this.nextRunEnd();
    const submission = await this.session.conversation.submit(
      {
        type: "input",
        ...(delivery ? { requestId: delivery.requestId } : {}),
        content:
          resolved?.context || images?.length
            ? [
                { type: "text", text },
                ...(resolved?.context ? [{ type: "text" as const, text: resolved.context }] : []),
                ...(images ?? []),
              ]
            : text,
        ...(delivery?.receipt
          ? {
              entry: {
                kind: "carmel.user-request-response",
                data: { carmelUserRequestReceipt: delivery.receipt } as unknown as JsonValue,
              },
            }
          : resolved?.references.length
            ? {
                entry: {
                  kind: "carmel.referenced-input",
                  data: {
                    carmelDisplayText: text,
                    carmelReferences: resolved.references,
                    ...delivery?.source,
                  } as unknown as JsonValue,
                },
              }
            : delivery?.source
              ? {
                  entry: {
                    kind:
                      delivery.source.origin === "background"
                        ? "carmel.background-input"
                        : "carmel.home-input",
                    data: delivery.source,
                  },
                }
              : {}),
        whenBusy: "reject",
      },
      context,
    );
    // Same requestId repairs a crash between native admission and the host receipt.
    const admitted = delivery ? await submission.status(context) : undefined;
    delivery?.onSubmitted?.();
    const settled = await submission.wait(context);
    if (!admitted || admitted.status === "queued" || admitted.status === "placed") await delivered;
    if (settled.status === "unanswered" && !["aborted", "model_error"].includes(settled.reason))
      throw new Error(
        `Pi Durable could not answer the input: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ""}`,
      );
  }

  async close() {
    await this.stream.stop();
    this.listeners.clear();
  }
}
