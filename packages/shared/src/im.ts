import { z } from "zod";

export const imPlatformSchema = z.enum(["telegram", "feishu", "lark"]);
export type ImPlatform = z.infer<typeof imPlatformSchema>;
export const imConnectSchema = z
  .object({
    platform: imPlatformSchema,
    token: z.string().trim().min(1).max(512).optional(),
    appId: z.string().trim().min(1).max(256).optional(),
    appSecret: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.platform === "telegram" ? !value.token : !value.appId || !value.appSecret)
      ctx.addIssue({ code: "custom", message: "Bot token or App ID and App Secret are required." });
  });
export const imSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    proactive: z.boolean().optional(),
    notificationDefault: z.boolean().optional(),
  })
  .strict();
export const imQrBeginSchema = z.object({ platform: z.enum(["feishu", "lark"]) }).strict();

export type ImIntegration = {
  id: string;
  agentId: string;
  platform: ImPlatform;
  botId: string;
  botName: string;
  enabled: boolean;
  proactive: boolean;
  notificationDefault: boolean;
  status: "connecting" | "connected" | "disabled" | "error";
  error?: string;
  senderId: string;
  sessionId?: string;
  updatedAt: number;
};
export type ImSetup = {
  id: string;
  platform: ImPlatform;
  status: "authorizing" | "pairing" | "completed" | "expired" | "denied" | "error" | "cancelled";
  expiresAt: number;
  verificationUrl?: string;
  qrDataUrl?: string;
  pairCommand?: string;
  botUrl?: string;
  botName?: string;
  error?: string;
};
export type ImDelivery = {
  id: string;
  platform: ImPlatform;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled" | "uncertain";
  error?: string;
  createdAt: number;
};
