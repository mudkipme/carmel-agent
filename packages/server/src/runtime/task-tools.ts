import { z } from "zod";
import { eq } from "drizzle-orm";
import { timezoneSchema, type AgentThinkingLevel } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import type { ToolRegistration } from "../effectors/pi-durable/index.ts";
import {
  createAgentTask,
  deleteAgentTask,
  readAgentTask,
  readAgentTasks,
  updateAgentTask,
} from "../services/agent-tasks.ts";
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

const scheduledTaskIdSchema = z.object({ taskId: z.string().min(1) }).strict();
const scheduledTaskPatchSchema = scheduleTaskSchema.partial().extend({
  notifyPlatform: imPlatformSchema.nullable().optional(),
  status: z.enum(["active", "paused"]).optional(),
});
const updateScheduledTaskSchema = scheduledTaskIdSchema.extend({
  patch: scheduledTaskPatchSchema.refine((patch) => Object.keys(patch).length > 0, {
    message: "Provide at least one field to update.",
  }),
});

export function createSchedulingTools(context: SchedulingContext): ToolRegistration[] {
  const user = { id: context.userId, role: "user" as const };
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    execute: (input: z.output<T>) => unknown,
    read = false,
  ): ToolRegistration => ({
    name,
    description,
    parameters: z.toJSONSchema(schema),
    executionMode: "sequential",
    replay: read ? "safe" : "unsafe",
    async execute(args, _api, executionContext) {
      executionContext.abortSignal?.throwIfAborted();
      const result = await execute(schema.parse(args));
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  return [
    createScheduleTaskTool(context),
    tool(
      "list_scheduled_tasks",
      "List this user's schedules and reminders for this agent, including IDs, instructions, timing, and active/paused status. Use to identify a schedule before changing or deleting it.",
      z.object({}).strict(),
      () => readAgentTasks(user, context.agentId),
      true,
    ),
    tool(
      "update_scheduled_task",
      "Edit a selected schedule or reminder. Set patch.status to paused to stop future runs, or active to resume. Only provided fields change. Pausing preserves history and does not interrupt a run already in progress. Confirm changes only after success.",
      updateScheduledTaskSchema,
      ({ taskId, patch }) => {
        const current = readAgentTask(user, context.agentId, taskId);
        if (
          patch.scheduleKind !== undefined ||
          patch.scheduleValue !== undefined ||
          patch.timezone !== undefined
        ) {
          const schedule = { ...current, ...patch };
          patch.timezone = schedule.timezone ?? context.timezone;
          if (schedule.scheduleKind === "once") {
            z.iso.datetime({ offset: true }).parse(schedule.scheduleValue);
          }
          if (schedule.scheduleKind === "cron" && !patch.timezone) {
            throw new Error(
              "Ask the user for their time zone before changing a calendar schedule.",
            );
          }
        }
        return updateAgentTask(user, context.agentId, taskId, patch);
      },
    ),
    tool(
      "delete_scheduled_task",
      "Permanently delete a selected schedule or reminder and its run history. Prefer pausing when the user only asks to stop future runs. Deletion fails while a run is in progress. Confirm deletion only after success.",
      scheduledTaskIdSchema,
      async ({ taskId }) => {
        await deleteAgentTask(user, context.agentId, taskId);
        return { taskId, deleted: true };
      },
    ),
  ];
}

/** Identity and model settings come from the run, never from model arguments. */
export function createScheduleTaskTool(context: SchedulingContext): ToolRegistration {
  return {
    name: "schedule_task",
    description:
      "Create an active reminder or scheduled task when the user asks to be reminded or to run something later/repeatedly. Use once for a single reminder, cron for calendar recurrence, interval for elapsed-time recurrence. Ask about missing or ambiguous timing before calling. Runs use this agent and the current model; results appear in Tasks history. Set notifyPlatform to save an available IM destination and describe alert conditions in the prompt. Only confirm scheduling after this tool succeeds.",
    parameters: z.toJSONSchema(scheduleTaskSchema),
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
    "## Schedules and reminders",
    timezone
      ? `User's browser time zone: ${timezoneSchema.parse(timezone)}; use for local times unless overridden.`
      : "User time zone unknown: ask before interpreting local clock times; do not assume the server's zone.",
    "For reminders at a time, after a delay, or recurring work, use schedule_task; do not substitute promises, memory saves, or waiting/sleeping. For relative dates, check the current time with bash if available; otherwise ask the user. Clarify missing or ambiguous reminder content or times.",
    "Future runs start fresh without this chat: give a self-contained prompt. A reminder must deliver when run, not reschedule itself. Confirm only after schedule_task succeeds, using its returned time, time zone, and destination.",
    "Manage schedules in chat with list_scheduled_tasks, update_scheduled_task, and delete_scheduled_task. List schedules to find the correct taskId; ask when the target is ambiguous. To stop future reminders, set patch.status to paused; use active to resume. Edit timing, instructions, or notification destination with update_scheduled_task. Delete only when requested; deletion also removes run history and fails during an active run. Pausing does not interrupt a run already in progress. Confirm changes only after the tool succeeds.",
    platforms.length
      ? `IM destinations: ${platforms.join(", ")}. For requested reminders/alerts, save notifyPlatform and put notification conditions in the prompt. Use the chosen platform, or ask when several are available. Future runs use send_user_message; delivery may fail independently of execution.`
      : "No proactive IM integration: results are saved in Schedules history; do not promise push/email notifications.",
  ].join("\n");
}
