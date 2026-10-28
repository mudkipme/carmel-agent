import { publishHomeEvent } from "../services/home-events.ts";
import { sessionHome } from "../services/agent-homes.ts";
import { z } from "zod";
import { imPlatformSchema, type ImPlatform } from "@carmel-agent/shared";
import type { ToolRegistration } from "../effectors/pi-durable/index.ts";
import {
  enqueueImMessage,
  listImIntegrations,
  resolveNotificationIntegration,
} from "../services/im-integrations.ts";

export function notificationPlatforms(userId: string, agentId: string): ImPlatform[] {
  try {
    return listImIntegrations(userId, agentId)
      .filter((item) => item.enabled && item.proactive && item.senderId)
      .map((item) => item.platform);
  } catch {
    return [];
  }
}
const sendSchema = z
  .object({
    text: z.string().trim().min(1).max(100_000).describe("The message to send to this user."),
    platform: imPlatformSchema
      .optional()
      .describe(
        "Choose a connected platform. Omit only when there is one eligible integration or a notification default.",
      ),
  })
  .strict();
/** The recipient and agent are trusted run context, never model-controlled arguments. */
export function createSendUserMessageTool(context: {
  userId: string;
  agentId: string;
  sessionId: string;
}): ToolRegistration {
  return {
    name: "send_user_message",
    description:
      "Send a proactive private IM message to the current user through their paired integration for this agent. Works in scheduled tasks without an active IM conversation. Use for requested notifications and relevant task results, including conditional alerts. A queued result is not confirmed delivery; do not claim it was received. Never include secrets or internal thinking.",
    parameters: z.toJSONSchema(sendSchema) as never,
    executionMode: "sequential",
    replay: "safe",
    async execute(args, api, executionContext) {
      executionContext.abortSignal?.throwIfAborted();
      const input = sendSchema.parse(args);
      const integration = resolveNotificationIntegration(
        context.userId,
        context.agentId,
        input.platform,
      );
      const event = !sessionHome(context.sessionId)
        ? publishHomeEvent(context.userId, context.agentId, {
            sourceKey: `tool:${context.sessionId}:${api.taskId}`,
            kind: "notification",
            text: `${input.text}\n\n[View run](/agents/${context.agentId}/sessions/${context.sessionId})`,
          })
        : undefined;
      const delivery = enqueueImMessage(
        integration.id,
        input.text,
        `tool:${context.sessionId}:${api.taskId}`,
        true,
        context.sessionId,
        event?.id,
      );
      return { output: [{ type: "text", text: JSON.stringify(delivery) }], details: delivery };
    },
  };
}
export function messagingInstructions(platforms: ImPlatform[], requested?: ImPlatform) {
  return [
    `Private IM platforms for this user and agent: ${platforms.join(", ") || "none available"}.`,
    "Use send_user_message for requested reminders, task results, or conditional alerts to this user only. Do not invent chat IDs or use other users' integrations. Pending means queued, not delivered; report unavailable delivery in the task result instead of claiming it was sent.",
    requested
      ? `This schedule's saved notification destination is ${requested}. When its conditions require notification, call send_user_message with platform '${requested}', not just a final answer. Runs start fresh; no active IM conversation is required.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
