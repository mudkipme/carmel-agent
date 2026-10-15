import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { Domain, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import type { ImPlatform, PromptInput } from "@carmel-agent/shared";

export type ImCredential = { token?: string; appId?: string; appSecret?: string };
export type ImIncoming = {
  eventId: string;
  senderId: string;
  chatId: string;
  text: string;
  imageKeys: string[];
  messageId?: string;
};
export type BotIdentity = { id: string; name: string };
export type ImTransport = {
  start(): Promise<void>;
  stop(): void;
  send(chatId: string, text: string, dedupKey: string, editId?: string): Promise<string>;
  image(key: string, messageId?: string): Promise<NonNullable<PromptInput["images"]>[number]>;
};
export class ImProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
const maxImageBytes = 10 * 1024 * 1024;
export const apiBase = (platform: ImPlatform) =>
  platform === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";

/** Never include request URLs, bodies, or arbitrary provider error text: they can contain secrets. */
async function requestJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
  mutation = false,
  headers?: Record<string, string>,
  method: "POST" | "PUT" | "PATCH" = "POST",
) {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: "error",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(40_000)])
        : AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImProviderError(
      "Cannot reach the messaging service.",
      mutation ? undefined : 5000,
      mutation,
    );
  }
  if (response.status === 429)
    throw new ImProviderError(
      "Messaging service rate limit reached.",
      Math.max(1000, Number(response.headers.get("retry-after") ?? 5) * 1000),
    );
  if (!response.ok)
    throw new ImProviderError(
      `Messaging service returned HTTP ${response.status}.`,
      response.status >= 500 && !mutation ? 5000 : undefined,
      mutation && response.status >= 500,
    );
  try {
    return JSON.parse(await limitedText(response, 1024 * 1024)) as Record<string, any>;
  } catch {
    throw new ImProviderError(
      "Messaging service returned an invalid response.",
      undefined,
      mutation,
    );
  }
}
async function limitedText(response: Response, limit: number) {
  return Buffer.from(await limitedBytes(response, limit)).toString("utf8");
}
async function limitedBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response.");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw new Error("Messaging response exceeds the size limit.");
      parts.push(part.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function imageResponse(response: Response) {
  if (!response.ok) throw new Error("Cannot download the attached image.");
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType))
    throw new Error("The attachment must be a JPEG, PNG, WebP, or GIF image.");
  const bytes = await limitedBytes(response, maxImageBytes);
  return { type: "image" as const, data: bytes.toString("base64"), mimeType };
}
export function telegramIncoming(update: Record<string, any>): ImIncoming | undefined {
  const message = update.message;
  if (
    !Number.isSafeInteger(update.update_id) ||
    !message ||
    message.chat?.type !== "private" ||
    !message.from?.id ||
    message.from.is_bot ||
    !message.chat?.id
  )
    return;
  const image = Array.isArray(message.photo) ? message.photo.at(-1)?.file_id : undefined;
  return {
    eventId: String(update.update_id),
    senderId: String(message.from.id),
    chatId: String(message.chat.id),
    text:
      message.text ??
      message.caption ??
      (image ? "" : "[Unsupported attachment. Please send text or an image.]"),
    imageKeys: image ? [image] : [],
    messageId: String(message.message_id),
  };
}
export function larkIncoming(data: Record<string, any>): ImIncoming | undefined {
  const message = data.message;
  if (
    data.sender?.sender_type !== "user" ||
    message?.chat_type !== "p2p" ||
    !data.sender.sender_id?.open_id ||
    !message.message_id ||
    !message.chat_id
  )
    return;
  let content: Record<string, any>;
  try {
    content = JSON.parse(message.content);
  } catch {
    return;
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) return;
  return {
    eventId: message.message_id,
    senderId: data.sender.sender_id.open_id,
    chatId: message.chat_id,
    text:
      message.message_type === "text"
        ? (content.text ?? "")
        : message.message_type === "image"
          ? ""
          : "[Unsupported attachment. Please send text or an image.]",
    imageKeys:
      message.message_type === "image" && typeof content.image_key === "string"
        ? [content.image_key]
        : [],
    messageId: message.message_id,
  };
}
function telegramApi(credential: ImCredential, signal?: AbortSignal) {
  return async (method: string, body: unknown, mutation = false) => {
    const result = await requestJson(
      `https://api.telegram.org/bot${credential.token}/${method}`,
      body,
      signal,
      mutation,
    );
    if (!result.ok) {
      if (
        method === "editMessageText" &&
        String(result.description).includes("message is not modified")
      )
        return { message_id: (body as { message_id: number }).message_id };
      throw new ImProviderError(
        `Telegram rejected ${method}${result.error_code === 409 ? ": another poller or webhook is using this bot" : ""}.`,
        result.error_code === 429 ? Number(result.parameters?.retry_after ?? 5) * 1000 : undefined,
      );
    }
    return result.result;
  };
}
function larkApi(platform: ImPlatform, credential: ImCredential) {
  let token = "";
  let expiresAt = 0;
  const accessToken = async () => {
    if (Date.now() < expiresAt) return token;
    const result = await requestJson(
      `${apiBase(platform)}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        app_id: credential.appId,
        app_secret: credential.appSecret,
      },
    );
    if (result.code !== 0 || !result.tenant_access_token)
      throw new ImProviderError("Feishu/Lark app credentials are invalid or unavailable.");
    token = result.tenant_access_token;
    expiresAt = Date.now() + Math.max(30, Number(result.expire ?? 7200) - 120) * 1000;
    return token;
  };
  return {
    accessToken,
    async call(
      path: string,
      body?: unknown,
      method: "GET" | "POST" | "PUT" | "PATCH" = "POST",
      mutation = false,
    ) {
      const authorization = `Bearer ${await accessToken()}`;
      let result: Record<string, any>;
      if (method === "GET") {
        try {
          const response = await fetch(`${apiBase(platform)}${path}`, {
            headers: { authorization },
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error();
          result = JSON.parse(await limitedText(response, 1024 * 1024));
        } catch {
          throw new ImProviderError("Cannot read Feishu/Lark bot information.", 5000);
        }
      } else
        result = await requestJson(
          `${apiBase(platform)}${path}`,
          body,
          undefined,
          mutation,
          {
            authorization,
          },
          method,
        );
      if (result.code !== 0) {
        if ([99991663, 99991668].includes(result.code)) {
          expiresAt = 0;
          throw new ImProviderError("Feishu/Lark access token expired.", 1000);
        }
        throw new ImProviderError(
          `Feishu/Lark rejected the request (code ${Number(result.code)}).`,
          result.code === 99991400 ? 5000 : undefined,
        );
      }
      return result;
    },
  };
}
export async function validateImCredential(
  platform: ImPlatform,
  credential: ImCredential,
): Promise<BotIdentity> {
  if (platform === "telegram") {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(credential.token ?? ""))
      throw new Error("Invalid Telegram bot token format.");
    const api = telegramApi(credential);
    const me = await api("getMe", {});
    const webhook = await api("getWebhookInfo", {});
    if (webhook.url)
      throw new Error(
        "This bot has a webhook configured. Remove it from its previous integration before connecting.",
      );
    return { id: String(me.id), name: me.username };
  }
  const result = await larkApi(platform, credential).call(
    "/open-apis/bot/v3/info",
    undefined,
    "GET",
  );
  if (!result.bot?.open_id) throw new Error("Enable the bot capability for this Feishu/Lark app.");
  return { id: credential.appId!, name: result.bot.bot_name ?? credential.appId! };
}
export function createImTransport(options: {
  platform: ImPlatform;
  credential: ImCredential;
  offset: number;
  receive: (event: ImIncoming) => Promise<void>;
  checkpoint: (offset: number) => void;
  health: (error?: string) => void;
}): ImTransport {
  const controller = new AbortController();
  if (options.platform === "telegram") {
    const api = telegramApi(options.credential, controller.signal);
    return {
      async start() {
        let offset = options.offset;
        let failures = 0;
        while (!controller.signal.aborted) {
          try {
            const updates = await api("getUpdates", {
              offset,
              timeout: 25,
              allowed_updates: ["message"],
            });
            failures = 0;
            options.health();
            for (const update of updates) {
              if (controller.signal.aborted) break;
              const event = telegramIncoming(update);
              if (event) await options.receive(event);
              offset = update.update_id + 1;
              options.checkpoint(offset);
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            options.health(
              error instanceof ImProviderError
                ? error.message
                : "Cannot receive Telegram messages.",
            );
            await delay(Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5)), undefined, {
              signal: controller.signal,
            }).catch(() => {});
          }
        }
      },
      stop() {
        controller.abort();
      },
      async send(chatId, text, _key, editId) {
        const result = await api(
          editId ? "editMessageText" : "sendMessage",
          {
            chat_id: chatId,
            text,
            ...(editId ? { message_id: Number(editId) } : {}),
            link_preview_options: { is_disabled: true },
          },
          true,
        );
        return String(result.message_id);
      },
      async image(key) {
        const file = await api("getFile", { file_id: key });
        if (
          file.file_size > maxImageBytes ||
          typeof file.file_path !== "string" ||
          !/^[\w./-]+$/.test(file.file_path)
        )
          throw new Error("The image exceeds the 10 MB limit or has an invalid path.");
        try {
          return await imageResponse(
            await fetch(
              `https://api.telegram.org/file/bot${options.credential.token}/${file.file_path}`,
              { redirect: "error", signal: AbortSignal.timeout(15_000) },
            ),
          );
        } catch {
          throw new Error("Cannot download the Telegram image (maximum 10 MB).");
        }
      },
    };
  }
  const api = larkApi(options.platform, options.credential);
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const dispatcher = new EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      if (controller.signal.aborted) return;
      const event = larkIncoming(data);
      if (event) await options.receive(event);
    },
  });
  const connected = () => {
    clearTimeout(reconnectTimer);
    failures = 0;
    options.health();
  };
  const retry = () => {
    if (controller.signal.aborted) return;
    options.health(
      "Cannot connect to Feishu/Lark. Check app publishing, permissions, and long-connection event subscriptions.",
    );
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(
      () => {
        if (!controller.signal.aborted) void ws.start({ eventDispatcher: dispatcher }).catch(retry);
      },
      Math.min(60_000, 5000 * 2 ** Math.min(failures++, 4)),
    );
    reconnectTimer.unref();
  };
  const ws = new WSClient({
    appId: options.credential.appId!,
    appSecret: options.credential.appSecret!,
    domain: options.platform === "lark" ? Domain.Lark : Domain.Feishu,
    handshakeTimeoutMs: 15_000,
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
    onReady: connected,
    onReconnected: connected,
    onReconnecting: () => options.health("Reconnecting to Feishu/Lark."),
    onError: retry,
  });
  return {
    async start() {
      await ws.start({ eventDispatcher: dispatcher }).catch(retry);
    },
    stop() {
      controller.abort();
      clearTimeout(reconnectTimer);
      ws.close({ force: true });
    },
    async send(chatId, text, key, editId) {
      const uuid = createHash("sha256").update(key).digest("hex").slice(0, 32);
      const plain = async () => {
        const result = await api.call(
          "/open-apis/im/v1/messages?receive_id_type=chat_id",
          {
            receive_id: chatId,
            msg_type: "text",
            uuid,
            content: JSON.stringify({ text }),
          },
          "POST",
          true,
        );
        return `text:${result.data.message_id}`;
      };
      try {
        if (editId) {
          const isPlain = editId.startsWith("text:");
          const messageId = isPlain ? editId.slice(5) : editId;
          await api.call(
            `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
            isPlain
              ? { msg_type: "text", content: JSON.stringify({ text }) }
              : {
                  content: JSON.stringify({
                    config: { wide_screen_mode: true },
                    elements: [{ tag: "markdown", content: text }],
                  }),
                },
            isPlain ? "PUT" : "PATCH",
            true,
          );
          return editId;
        }
        const result = await api.call(
          "/open-apis/im/v1/messages?receive_id_type=chat_id",
          {
            receive_id: chatId,
            msg_type: "interactive",
            uuid,
            content: JSON.stringify({
              config: { wide_screen_mode: true },
              elements: [{ tag: "markdown", content: text }],
            }),
          },
          "POST",
          true,
        );
        return result.data.message_id;
      } catch (error) {
        // Fall back only after an explicit rejection; an ambiguous send may already exist.
        if (
          !(error instanceof ImProviderError) ||
          error.uncertain ||
          error.retryAfterMs !== undefined
        )
          throw error;
        return plain();
      }
    },
    async image(key, messageId) {
      if (!messageId) throw new Error("Image message ID is missing.");
      try {
        return await imageResponse(
          await fetch(
            `${apiBase(options.platform)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=image`,
            {
              headers: { authorization: `Bearer ${await api.accessToken()}` },
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            },
          ),
        );
      } catch {
        throw new Error(
          "Cannot download the Feishu/Lark image (maximum 10 MB). Check message resource permissions.",
        );
      }
    },
  };
}

/** Unicode-safe chunks below Telegram's and card content limits. */
export function splitImText(text: string, size = 3500): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const point of text) {
    if (chunk.length + point.length > size) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += point;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : ["(No text response.)"];
}
