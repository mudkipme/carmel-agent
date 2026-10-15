import { z } from "zod";
import { eq } from "drizzle-orm";
import { timezoneSchema, type AgentThinkingLevel } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import type { ToolRegistration } from "../effectors/pi-durable/index.ts";
import { createAgentTask } from "../services/agent-tasks.ts";
import { imPlatformSchema } from "@carmel-agent/shared";

const scheduleTaskSchema = z
  .object({
    notifyPlatform: imPlatformSchema
      .optional()
      .describe(
        "Save a private IM notification destination for the future run. Use when the user asks for an IM reminder/alert. Include notification conditions in the prompt.",
      ),
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
export function createScheduleTaskTool(context: SchedulingContext): ToolRegistration {
  return {
    name: "schedule_task",
    description:
      "Create an active reminder or scheduled task when the user asks to be reminded or to run something later/repeatedly. Use once for a single reminder, cron for calendar recurrence, interval for elapsed-time recurrence. Ask about missing or ambiguous timing before calling. Runs use this agent and the current model; results appear in Tasks history. Set notifyPlatform to save an available IM destination and describe alert conditions in the prompt. Only confirm scheduling after this tool succeeds.",
    parameters: z.toJSONSchema(scheduleTaskSchema) as never,
    executionMode: "sequential",
    // A crash after the database write must not replay the creation.
    replay: "unsafe",
    async execute(args, _api, executionContext) {
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
        delivery: task.notifyPlatform
          ? `The result will appear in Tasks run history. The future run is instructed to notify you via ${task.notifyPlatform} when the prompt's conditions apply.`
          : "The result will appear in this agent's Tasks run history. No push or email notification is sent automatically.",
      };
      return { output: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

export function buildSchedulingInstructions(timezone?: string, platforms: string[] = []): string {
  return [
    "## Scheduled tasks and reminders",
    timezone
      ? `User's browser time zone: ${timezoneSchema.parse(timezone)}. Use it for local times unless the user specifies another zone.`
      : "User time zone is unknown. Ask for it when interpreting a local clock time; do not assume the server's zone.",
    "When the user asks 'remind me at ...', 'in ...', or for recurring work, use schedule_task. Do not merely promise to remember, save a memory, or wait/sleep in the current run. For relative dates, check the current time with bash if available; otherwise ask the user for it. Ask a concise follow-up if the reminder content or intended time is ambiguous or missing.",
    "Write a self-contained prompt for the future run: it starts a fresh session without this chat. For reminders, tell it to deliver the reminder when run, not schedule another reminder. Only confirm creation after schedule_task succeeds; include the returned time, time zone, and delivery destination. Existing tasks can be edited, paused, or deleted in Tasks.",
    platforms.length
      ? `Available IM destinations: ${platforms.join(", ")}. For requested reminders or alerts, save notifyPlatform and include any notification conditions in the prompt. If multiple destinations are available, use the user's chosen platform or ask which one. The future run uses send_user_message; notification delivery can fail independently of task execution.`
      : "No proactive IM integration is available. Explain that results are saved in Tasks history and do not promise push/email notifications.",
  ].join("\n");
}
