import type { Api, Model } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { ImPlatform, PromptInput, Session } from "@carmel-agent/shared";
import type { agents, modelRefs, sessions } from "../db/schema.ts";
import type { Context as PiContext } from "../effectors/pi-durable/index.ts";
import type { RunAbortReason } from "../effectors/run-outcome.ts";
import type { PiSession } from "../services/pi-session-storage.ts";
import type { createServerExecution } from "./tools.ts";

type AgentRecord = typeof agents.$inferSelect;
type ModelRefRecord = typeof modelRefs.$inferSelect;
type SessionRecord = typeof sessions.$inferSelect;
type ServerExecution = ReturnType<typeof createServerExecution>;

export type RunContributionContext = {
  agent: AgentRecord;
  session: SessionRecord;
  modelRef: ModelRefRecord;
  model: Model<Api>;
  thinkingLevel: Session["thinkingLevel"];
  promptInput?: PromptInput;
  promptDelivery?: {
    requestId: string;
    onSubmitted?: (entryId?: string) => void;
    source: Record<string, import("@earendil-works/chord").JsonValue>;
  };
  timezone?: string;
  notifyPlatform?: ImPlatform;
  abortSignal: AbortSignal;
};

export type RunContribution = {
  tools?: readonly ToolRegistration[];
  sectionsBeforeBase?: (activeToolNames: readonly string[]) => Record<string, string | undefined>;
  sections?: (activeToolNames: readonly string[]) => Record<string, string | undefined>;
  extensionsBeforeExecution?: readonly Extension[];
  extensions?: readonly Extension[];
};

export type RunContributor = {
  name: string;
  beforeOpen?: (ctx: RunContributionContext) => void | Promise<void>;
  contribute?: (ctx: RunContributionContext) => RunContribution | Promise<RunContribution>;
  afterConfigure?: (
    ctx: RunContributionContext,
    piSession: PiSession,
    piContext: PiContext,
  ) => void | Promise<void>;
  onFinalizeStart?: (ctx: RunContributionContext, abortReason?: RunAbortReason) => void;
  beforeSessionClose?: (ctx: RunContributionContext, piSession: PiSession) => void | Promise<void>;
  retainExecution?: (
    ctx: RunContributionContext,
    piSession: PiSession,
    execution: ServerExecution,
  ) => Promise<boolean>;
};

let registeredContributors: RunContributor[] | undefined;

export function registerRunContributors(contributors: readonly RunContributor[]) {
  registeredContributors = [...contributors];
}

export function hasRunContributors() {
  return registeredContributors !== undefined;
}

export function getRunContributors(): readonly RunContributor[] {
  return registeredContributors ?? [];
}
