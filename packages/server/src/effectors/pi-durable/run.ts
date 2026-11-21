import type { Op } from "@earendil-works/chord/delta";
import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type { ResolvedReferences } from "../../services/prompt-references.ts";
import type { UserRequestReceipt } from "@carmel-agent/shared";
import type { ImageContent, Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  defineExtension,
  section,
  ConversationTranscript,
  type AgentChange,
  type ConversationView,
  type EntryRecord,
  type LiveState,
  type Extension,
  type HarnessSettings,
  type ToolNamespace,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { fitImages } from "@earendil-works/pi-durable/images/fit";
import { imageLimits } from "@earendil-works/pi-durable/tools";
import { imageProcessor } from "./tools.ts";
import type { PiSession } from "../../services/pi-session-storage.ts";

export type PiRunOptions = {
  models: Models;
  agent: AgentChange;
  tools?: ToolRegistration[];
  /** Codemode groups for some of `tools`, each brought by its own extension. */
  namespaces?: readonly {
    extension: string;
    namespace: ToolNamespace;
    tools: readonly string[];
  }[];
  env?: ExecutionEnv;
  extensions?: Extension[];
  sections?: Record<string, string | undefined>;
  settings?: HarnessSettings;
};

export type RunChange =
  | { type: "state"; value: ConversationView; ops: readonly Op[] }
  | { type: "message_end"; entry: EntryRecord };

/** Application observation and input settlement; execution stays on native conversation handles. */
export class PiRun {
  private stream!: WatchHandle<ConversationView>;
  private lastEntryId = 0;
  private readonly listeners = new Set<(event: RunChange) => void | Promise<void>>();
  private constructor(
    readonly session: PiSession,
    private readonly context: Context,
  ) {}

  static async open(session: PiSession, options: PiRunOptions, context: Context) {
    session.models = options.models;
    session.env = options.env;

    const tools = options.tools ?? [];
    const grouped = new Set(options.namespaces?.flatMap((group) => group.tools));
    const namespaced = (options.namespaces ?? []).map(({ extension, namespace, tools: names }) =>
      defineExtension({
        name: extension,
        namespace,
        tools: tools.filter((tool) => names.includes(tool.name)),
      }),
    );
    const carmel = defineExtension({
      name: "carmel",
      tools: tools.filter((tool) => !grouped.has(tool.name)),
      sections: Object.entries(options.sections ?? {}).map(([key, text]) =>
        section(key, () => text, { tag: false }),
      ),
    });
    const extensions = [...(options.extensions ?? []), ...namespaced, carmel];
    for (const extension of extensions) session.registry.install(extension);
    session.settings = { ...options.settings, extensions };
    if (!(await session.native.snapshot(AgentDoc, session.conversation.id, context))?.model)
      await session.conversation.configure(options.agent, context);
    const run = new PiRun(session, context);
    await run.attach();
    return run;
  }

  get snapshot() {
    return this.stream.value;
  }

  observe(listener: (event: RunChange) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reattach after a branch mutation; native watch captures history and progress atomically. */
  async attach() {
    await this.stream?.stop();
    const conversation = this.session.conversation;
    const transcript = new ConversationTranscript((query, limit, ctx) =>
      conversation.entries(query, limit, undefined, ctx),
    );
    this.stream = await conversation.watch(this.context);
    transcript.merge(this.stream.value);
    this.lastEntryId = transcript.newest ?? 0;
    const initialEntryId = this.lastEntryId;
    let first = true;
    this.stream.start(async (call) => {
      if (call.kind !== "value") return;
      let view = transcript.merge(call.value);
      while (initialEntryId === 0 && view.items[0]?.kind === "earlier")
        view = await transcript.loadEarlier(this.context);
      let gap;
      while ((gap = view.items.find((item) => item.kind === "gap")))
        view = await transcript.fillGap(gap, this.context);
      for (const item of view.items) {
        if (item.kind !== "entry" || item.entry.id <= this.lastEntryId) continue;
        this.lastEntryId = item.entry.id;
        await this.emit({ type: "message_end", entry: item.entry });
      }
      await this.emit({
        type: "state",
        value: call.value,
        ops: first ? [["r", call.value as unknown as JsonValue]] : call.ops,
      });
      first = false;
    });
  }

  private async emit(change: RunChange) {
    for (const listener of this.listeners) await listener(change);
  }

  private nextRunEnd() {
    let unsubscribe = () => {};
    const delivered = new Promise<void>((resolve) => {
      unsubscribe = this.observe((event) => {
        if (event.type === "state" && !(event.value.docs["pi.live"] as LiveState | undefined)?.run)
          resolve();
      });
    });
    const result = Promise.race([
      delivered,
      this.stream.closed.then(() => {
        throw new Error("Pi Durable conversation watch closed before the run ended.");
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

  /**
   * Resolves once the run is parked: it is still open, a tool call sleeps or waits (a question for the user), and
   * nothing can run. Pi keeps the parked run without a process, so Carmel's run can end and release its resources.
   */
  private whenParked() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const live = this.stream.value.docs["pi.live"] as LiveState | undefined;
      if (!live?.run || !live.tools?.some((slot) => ["sleeping", "waiting"].includes(slot.status)))
        return;
      // The park is committed before the scheduler lets go of the run; look again once it has.
      if (this.session.native.wake().active)
        timer ??= setTimeout(() => ((timer = undefined), check()), 50);
      else resolve();
    };
    const unsubscribe = this.observe((event) => {
      if (event.type === "state") check();
    });
    check();
    const cancel = () => {
      unsubscribe();
      clearTimeout(timer);
    };
    return { promise: promise.finally(cancel), cancel };
  }

  /** `wait`'s value, or undefined when the run parks first. */
  private async unlessParked<T>(wait: (context: Context) => Promise<T>, context: Context) {
    const parked = this.whenParked();
    const stop = new AbortController();
    try {
      return await Promise.race([
        wait(withAbortSignal(stop.signal, context)).then((value) => ({ value })),
        parked.promise.then(() => undefined),
      ]);
    } finally {
      parked.cancel();
      stop.abort();
    }
  }

  async resume(context: Context) {
    if (!(await this.hasPending(context))) return;
    const delivered = this.nextRunEnd();
    if (await this.unlessParked((ctx) => this.session.conversation.waitForIdle(ctx), context))
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
      onSubmitted?: (entryId?: string) => void;
      source?: Record<string, JsonValue>;
    },
  ) {
    await this.resume(context);
    const fitted = images?.length ? await this.fitImages(images, context) : undefined;
    if (fitted) images = fitted.images;
    // Model-only, like reference excerpts: the transcript shows the user's own text.
    const hidden = [resolved?.context, fitted?.notes].filter(Boolean).join("\n\n");
    const delivered = this.nextRunEnd();
    const submission = await this.session.conversation.submit(
      {
        type: "input",
        ...(delivery ? { requestId: delivery.requestId } : {}),
        content:
          hidden || images?.length
            ? [
                { type: "text", text },
                ...(hidden ? [{ type: "text" as const, text: hidden }] : []),
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
          : resolved?.references.length || (fitted?.notes && !delivery?.source)
            ? {
                entry: {
                  kind: "carmel.referenced-input",
                  data: {
                    carmelDisplayText: text,
                    carmelReferences: resolved?.references ?? [],
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
    delivery?.onSubmitted?.(
      admitted?.status === "placed" ? `durable:${admitted.entry}` : undefined,
    );
    const answer = await this.unlessParked((ctx) => submission.wait(ctx), context);
    if (!answer) return;
    const settled = answer.value;
    if (!admitted || admitted.status === "queued" || admitted.status === "placed") await delivered;
    if (settled.status === "unanswered" && !["aborted", "model_error"].includes(settled.reason))
      throw new Error(
        `Pi Durable could not answer the input: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ""}`,
      );
  }

  /** Attachments get the treatment `read` gives image files: fitted to the model's limits before they are stored. */
  private async fitImages(images: ImageContent[], context: Context) {
    const ref = (
      await this.session.native.snapshot(AgentDoc, this.session.conversation.id, context)
    )?.model;
    const model = ref && this.session.models.getModel(ref.provider, ref.modelId);
    const fitted = await fitImages(images, imageLimits(model), imageProcessor);
    if (fitted.kind === "unchanged") return undefined;
    return {
      images: fitted.content.filter((part) => part.type === "image"),
      notes: fitted.notes.join(" "),
    };
  }

  async close() {
    await this.stream.stop();
    this.listeners.clear();
  }
}
