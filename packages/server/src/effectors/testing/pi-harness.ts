import {
  PiRun,
  BACKGROUND_CONTEXT,
  type PiRunOptions,
  type Context,
  type Skill,
  type PromptTemplate,
} from "../pi-durable/index.ts";
import type { AgentEvent, AgentChange, HarnessSettings } from "@earendil-works/pi-durable";
import type { Api, Model, ImageContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  closePiSession,
  openPiSession,
  readPiSessionBranch,
  type PiSession,
} from "../../services/pi-session-storage.ts";
import { createPiSessionLog } from "../pi-durable/session-log.ts";
import { dispatchPrompt } from "../dispatch-prompt.ts";

export const TEST_CONTEXT: Context = BACKGROUND_CONTEXT;
type Options = Omit<PiRunOptions, "agent"> & {
  model: Model<Api>;
  thinkingLevel?: AgentChange["thinkingLevel"];
  systemPrompt?: string;
  promptSections?: Record<string, string | undefined>;
  resources?: { skills?: Skill[]; promptTemplates?: PromptTemplate[] };
  retry?: { enabled: boolean; maxRetries: number; baseDelayMs?: number };
  compaction?: HarnessSettings["compaction"];
};

/** Test conveniences only; production uses native conversations directly. */
export async function attachTestHarness(session: PiSession, options: Options) {
  const context = TEST_CONTEXT;
  const harness = await PiRun.open(
    session,
    {
      ...options,
      agent: {
        model: { provider: options.model.provider, modelId: options.model.id },
        thinkingLevel: options.thinkingLevel ?? "off",
        tools: options.tools ?? [],
      },
      sections: options.promptSections ?? { system: options.systemPrompt },
      settings: {
        retry: {
          maxRetries: options.retry?.enabled ? options.retry.maxRetries : 0,
          baseDelayMs: options.retry?.baseDelayMs ?? 0,
        },
        compaction: options.compaction,
        progress: { partialIntervalMs: 20, outputIntervalMs: 50 },
      },
    },
    context,
  );
  const log = createPiSessionLog({ session, onNavigate: () => harness.attach() });
  const prompt = (text: string, images?: ImageContent[]) => harness.prompt(text, images, context);
  const resources = options.resources ?? {};
  return {
    session,
    harness,
    log,
    context,
    resources,
    prompt,
    branch: () => readPiSessionBranch(session),
    observe: (listener: (event: AgentEvent) => void | Promise<void>) => harness.observe(listener),
    lane: {
      prompt: (text: string, images: ImageContent[] | undefined, ctx: Context) =>
        harness.prompt(text, images, ctx),
      resume: (ctx: Context) => harness.resume(ctx),
      hasPending: (ctx: Context) => harness.hasPending(ctx),
      configure: (change: AgentChange, ctx: Context) => session.conversation.configure(change, ctx),
      abort: (ctx: Context) => session.conversation.abort(ctx),
      navigateTree: (id: string | null, _options: unknown, _ctx: Context) => log.moveTo(id),
      skill: (name: string, instructions: string | undefined, _ctx: Context) =>
        dispatchPrompt({ resources, prompt }, `/skill:${name} ${instructions ?? ""}`),
      promptFromTemplate: (name: string, args: string[], _ctx: Context) =>
        dispatchPrompt({ resources, prompt }, `/${name} ${args.join(" ")}`),
    },
    async close() {
      await harness.close();
      await closePiSession(session);
    },
  };
}
export type TestHarness = Awaited<ReturnType<typeof attachTestHarness>>;
export async function openTestHarness(sessionId: string, options: Options) {
  return attachTestHarness(await openPiSession(sessionId), options);
}
export function fauxHarnessModels() {
  const faux = fauxProvider({ provider: `faux-harness-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), faux };
}
