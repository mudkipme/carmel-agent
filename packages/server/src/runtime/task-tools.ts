import { z } from "zod";
import { eq } from "drizzle-orm";
import { timezoneSchema, type AgentThinkingLevel } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import type { AgentHarnessTool, ExecutionToolContext } from "../effectors/pi-durable/index.ts";
import { createAgentTask } from "../services/agent-tasks.ts";

const scheduleTaskSchema = z
  .object({
    name: z.string().trim().min(1).describe("Short title for the reminder or scheduled task."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Self-contained instructions to execute when due. Include the reminder text and necessary context; the future run cannot see this conversation. Do not ask it to schedule the reminder again.",
      ),
    scheduleKind: z.enum(["once", "cron", "interval"]),
    scheduleValue: z
      .string()
      .min(1)
      .describe(
        "once: ISO 8601 date-time with Z or an explicit UTC offset; cron: cron expression; interval: milliseconds, at least 30000.",
      ),
    timezone: timezoneSchema
      .optional()
      .describe(
        "IANA time zone for calendar schedules, e.g. Asia/Singapore. Defaults to the browser time zone when known.",
      ),
  })
  .strict();

type SchedulingContext = {
  userId: string;
  agentId: string;
  modelRefId: string;
  thinkingLevel: AgentThinkingLevel;
  timezone?: string;
};

/** Identity and model settings come from the run, never from model arguments. */
export function createScheduleTaskTool(
  context: SchedulingContext,
): AgentHarnessTool<ExecutionToolContext> {
  return {
    name: "schedule_task",
    label: "Schedule task",
    description:
      "Create an active reminder or scheduled task when the user asks to be reminded or to run something later/repeatedly. Use once for a single reminder, cron for calendar recurrence, interval for elapsed-time recurrence. Ask about missing or ambiguous timing before calling. Runs use this agent and the current model, with results in the agent's Tasks history; no automatic push/email notification. Only confirm scheduling after this tool succeeds.",
    parameters: z.toJSONSchema(scheduleTaskSchema) as never,
    executionMode: "sequential",
    // A crash after the database write must not replay the creation.
    replay: "unsafe",
    async execute(_id, args, _update, _tools, _invocation, executionContext) {
      executionContext.abortSignal?.throwIfAborted();
      const input = scheduleTaskSchema.parse(args);
      const timezone = input.timezone ?? context.timezone;
      if (timezone) timezoneSchema.parse(timezone);
      if (input.scheduleKind === "once") {
        z.iso.datetime({ offset: true }).parse(input.scheduleValue);
      }
      if (input.scheduleKind === "cron" && !timezone) {
        throw new Error("Ask the user for their time zone before creating a calendar schedule.");
      }
      const user = db.select().from(users).where(eq(users.id, context.userId)).get();
      if (!user) throw new Error("User not found.");
      const task = createAgentTask(user, context.agentId, {
        ...input,
        timezone,
        modelRefId: context.modelRefId,
        thinkingLevel: context.thinkingLevel,
      });
      const result = {
        task,
        nextRunAt: new Date(task.nextRunAt!).toISOString(),
        delivery:
          "The result will appear in this agent's Tasks run history. No push or email notification is sent automatically.",
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

export function buildSchedulingInstructions(timezone?: string, at = Date.now()): string {
  return [
    "## Scheduled tasks and reminders",
    `Current time: ${new Date(at).toISOString()}.`,
    timezone
      ? `User's browser time zone: ${timezoneSchema.parse(timezone)}. Use it for local times unless the user specifies another zone.`
      : "User time zone is unknown. Ask for it when interpreting a local clock time; do not assume the server's zone.",
    "When the user asks 'remind me at ...', 'in ...', or for recurring work, use schedule_task. Do not merely promise to remember, save a memory, or wait/sleep in the current run. Resolve relative dates from the current time above. Ask a concise follow-up if the reminder content or intended time is ambiguous or missing.",
    "Write a self-contained prompt for the future run: it starts a fresh session without this chat. For reminders, tell it to output the reminder when run, not to schedule another reminder. Only confirm creation after schedule_task succeeds; include the returned next run time, time zone, and that results are available in the agent's Tasks history. Do not promise automatic push/email notifications. Existing tasks can be edited, paused, or deleted in Tasks.",
  ].join("\n");
}
