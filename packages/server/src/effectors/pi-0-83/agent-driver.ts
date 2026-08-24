import {
  estimateContextTokens,
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  parseCommandArgs,
  type AgentHarness,
  type AgentHarnessEvent,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { errorMessage } from "../../errors.ts";
import { projectRunEvent } from "../../runtime/run-events.ts";
import type {
  AgentDriver,
  AgentRunObserver,
  DriverResources,
  PromptDispatcher,
} from "../contracts/agent-driver.ts";
import {
  decideCompaction,
  PI_083_COMPACTION_SETTINGS,
  type CompactionOutcome,
  type CompactionSettings,
} from "../compaction-policy.ts";
import type { SessionLog } from "../contracts/session-log.ts";

/**
 * `AgentDriver` over Pi 0.83's `AgentHarness`.
 *
 * This file is the blast radius. When the v2 harness lands it takes an explicit
 * `Context` on every method, unexports `AgentHarnessEvent`, and moves
 * `subscribe()` to `events.on(type, fn)` -- all of which stops here, because
 * nothing above imports Pi to talk to the loop.
 */

/** The 0.83 surface actually used, so a type error names the method that moved. */
export type Pi083Harness = Pick<
  AgentHarness<ExecutionToolContext>,
  "prompt" | "skill" | "promptFromTemplate" | "getResources" | "subscribe" | "abort" | "compact"
>;

export type Pi083DriverOptions = {
  harness: Pi083Harness;
  /** Read for context pressure; the harness owns the compaction itself. */
  log: Pick<SessionLog, "readState" | "readBranch">;
  model: Model<Api>;
  /** Defaults to Pi 0.83's; overridden in tests to reach the edge cases cheaply. */
  settings?: CompactionSettings;
  /** Present only so tests can drive pressure without a real transcript. */
  estimateTokens?: (log: Pick<SessionLog, "readBranch">) => Promise<number>;
};

/**
 * Dispatch-only slice. Separate from the full driver because it needs nothing
 * but the harness -- no model, no session log -- so every caller that merely
 * sends a prompt can be handed one without pretending to own a run.
 */
export function createPi083PromptDispatcher(harness: Pi083Harness): PromptDispatcher {
  return {
    listResources(): DriverResources {
      const resources = harness.getResources();
      return {
        skills: resources.skills ?? [],
        promptTemplates: resources.promptTemplates ?? [],
      };
    },

    async prompt(text, images) {
      await harness.prompt(text, { images });
    },

    async invokeSkill(name, instructions, images) {
      // The native call takes text only, so an attachment forces the invocation
      // to be inlined as a prompt instead. Pi's own formatter is used so the
      // inlined form matches what `harness.skill` would have produced.
      if (images?.length) {
        const skill = harness.getResources().skills?.find((candidate) => candidate.name === name);
        if (!skill) throw new Error(`Skill not loaded: ${name}`);
        await harness.prompt(formatSkillInvocation(skill, instructions), { images });
        return;
      }
      await harness.skill(name, instructions);
    },

    async invokeTemplate(name, args, images) {
      if (images?.length) {
        const template = harness.getResources().promptTemplates?.find((candidate) => candidate.name === name);
        if (!template) throw new Error(`Prompt template not loaded: ${name}`);
        await harness.prompt(formatPromptTemplateInvocation(template, parseCommandArgs(args)), { images });
        return;
      }
      await harness.promptFromTemplate(name, parseCommandArgs(args));
    },

  };
}

export function createPi083AgentDriver(options: Pi083DriverOptions): AgentDriver {
  const { harness, model } = options;
  const estimate = options.estimateTokens ?? estimateFromBranch;

  return {
    ...createPi083PromptDispatcher(harness),

    observe(observer: AgentRunObserver) {
      return harness.subscribe((event: AgentHarnessEvent) => {
        if (event.type === "message_end" && event.message.role === "user") {
          observer.onUserMessagePersisted();
        }
        const projected = projectRunEvent(event);
        if (projected) observer.onRunEvent(projected);
      });
    },

    async abort() {
      await harness.abort();
    },

    async relieveContextPressure(): Promise<CompactionOutcome> {
      const settings = options.settings ?? PI_083_COMPACTION_SETTINGS;
      const decision = decideCompaction({
        tokens: await estimate(options.log),
        contextWindow: model.contextWindow,
        settings,
      });

      if (decision.action === "none") {
        return { status: "not_needed", tokens: decision.tokens, headroom: decision.headroom };
      }
      if (decision.action === "impossible") {
        return {
          status: "impossible",
          tokens: decision.tokens,
          headroom: decision.headroom,
          reason: decision.reason,
        };
      }

      const tokensBefore = decision.tokens;
      try {
        await harness.compact();
      } catch (error) {
        // "Nothing to compact" is Pi telling us the branch has no history old
        // enough to summarize, which is a state of the session and not a fault.
        // It used to reach the log as a compaction failure.
        if (isNothingToCompact(error)) {
          return { status: "nothing_to_compact", tokens: tokensBefore, headroom: decision.headroom };
        }
        return {
          status: "failed",
          tokens: tokensBefore,
          headroom: decision.headroom,
          code: harnessErrorCode(error),
          reason: errorMessage(error),
        };
      }

      // Re-measure rather than trust the call. Pi returns `tokensBefore` and no
      // "after", and a compaction that succeeds without buying enough room is
      // the failure mode that repeats -- silently, once per turn, at the cost of
      // a summarization call each time.
      const tokensAfter = await estimate(options.log);
      const status = tokensAfter > decision.headroom ? "ineffective" : "compacted";
      return { status, tokensBefore, tokensAfter, headroom: decision.headroom };
    },
  };
}

/** Pi throws `AgentHarnessError("compaction", "Nothing to compact")` for this. */
function isNothingToCompact(error: unknown) {
  return /nothing to compact/i.test(errorMessage(error));
}

function harnessErrorCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

async function estimateFromBranch(log: Pick<SessionLog, "readBranch">) {
  const messages = (await log.readBranch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  return estimateContextTokens(messages).tokens;
}
