import {
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  parseCommandArgs,
  type AgentHarness,
  type AgentLane,
  type Context,
  type ExecutionToolContext,
  type HarnessEvent,
  type HarnessEventType,
} from "./index.ts";
import type { DriverResources, PromptDispatcher } from "../contracts/agent-driver.ts";

/**
 * Prompt dispatch, wire-event subscription, and configuration of the selected
 * Pi Durable conversation.
 */

/** The session-scoped surface actually used, so a type error names what moved. */
export type PiHarness = Pick<AgentHarness<ExecutionToolContext>, "getResources" | "events">;

/** The lane-scoped surface actually used. Everything that runs the loop is here now. */
export type PiLane = Pick<AgentLane, "prompt" | "skill" | "promptFromTemplate">;

export type PiDispatcherOptions = { harness: PiHarness; lane: PiLane; context: Context };

export function createPiPromptDispatcher({
  harness,
  lane,
  context,
}: PiDispatcherOptions): PromptDispatcher {
  return {
    async listResources(): Promise<DriverResources> {
      const resources = await harness.getResources(context);
      return {
        skills: resources.skills ?? [],
        promptTemplates: resources.promptTemplates ?? [],
      };
    },

    async prompt(text, images) {
      await lane.prompt(text, images, context);
    },

    async invokeSkill(name, instructions, images) {
      // Use the shared invocation formatter when an attachment accompanies the skill.
      if (images?.length) {
        const resources = await harness.getResources(context);
        const skill = resources.skills?.find((candidate) => candidate.name === name);
        if (!skill) throw new Error(`Skill not loaded: ${name}`);
        await lane.prompt(formatSkillInvocation(skill, instructions), images, context);
        return;
      }
      await lane.skill(name, instructions, context);
    },

    async invokeTemplate(name, args, images) {
      if (images?.length) {
        const resources = await harness.getResources(context);
        const template = resources.promptTemplates?.find((candidate) => candidate.name === name);
        if (!template) throw new Error(`Prompt template not loaded: ${name}`);
        await lane.prompt(
          formatPromptTemplateInvocation(template, parseCommandArgs(args)),
          images,
          context,
        );
        return;
      }
      await lane.promptFromTemplate(name, parseCommandArgs(args), context);
    },
  };
}

/**
 * The harness event types Carmel projects onto the wire.
 *
 * The adapter subscribes only to events the run needs, including its internal
 * queue and compaction notifications.
 */
const OBSERVED_EVENTS = [
  "message_start",
  "message_update",
  "message_part",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "turn_end",
  "run_end",
  // Durable issue updates need to distinguish queued instructions from ones
  // already admitted by the lane; this event is not sent on the chat wire.
  "queue_update",
  // Not projected onto the wire -- nothing renders it -- but the run needs to
  // know when Pi has spent its own overflow recovery, so that Carmel's does not
  // pay for the same compaction twice.
  "compaction_end",
] as const satisfies readonly HarnessEventType[];

/**
 * Subscribe to every harness event Carmel projects, as one handle.
 *
 * One release handle covers every projected event type.
 */
export function observeHarnessEvents(
  harness: PiHarness,
  listener: (event: HarnessEvent) => void,
): () => void {
  const unsubscribes = OBSERVED_EVENTS.map((type) =>
    harness.events.on(type, (event) => listener(event)),
  );
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
