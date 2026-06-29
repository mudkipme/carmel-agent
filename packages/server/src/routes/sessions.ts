import type { Session, SessionImportResult } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { modelRefs, sessionMessages, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { importOpenWebuiSessions } from "../import/open-webui.ts";
import { serializeSession } from "../serializers.ts";
import { canUseModel, readVisibleAgent, resolveSupportedThinkingLevel } from "../services/agent-access.ts";
import { loadSession, replaceSessionMessages } from "../services/session-store.ts";
import {
  forkSessionRequestSchema,
  jsonValidator,
  openWebuiImportRequestSchema,
  sessionMessageEditRequestSchema,
  sessionDraftRequestSchema,
  sessionPatchRequestSchema,
  sessionTruncateRequestSchema,
} from "../validation.ts";

export function createSessionRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/sessions/:id", (c) => {
    const session = loadSession(c.req.param("id"));
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    return c.json(serializeSession(session));
  });

  route.get("/sessions/:id/images/:messageIndex/:imageIndex", (c) => {
    const session = loadSession(c.req.param("id"));
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Image not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    const imageIndex = parseIndex(c.req.param("imageIndex"));
    if (messageIndex === undefined || imageIndex === undefined) return c.json({ error: "Image not found" }, 404);

    const image = readMessageImage(session.messages[messageIndex], imageIndex);
    if (!image) return c.json({ error: "Image not found" }, 404);
    return imageResponse(image);
  });

  route.get("/sessions/:id/tool-result-images/:messageIndex/:partIndex", (c) => {
    const session = loadSession(c.req.param("id"));
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Image not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    const partIndex = parseIndex(c.req.param("partIndex"));
    if (messageIndex === undefined || partIndex === undefined) return c.json({ error: "Image not found" }, 404);

    const image = readToolResultImage(session.messages[messageIndex], partIndex);
    if (!image) return c.json({ error: "Image not found" }, 404);
    return imageResponse(image);
  });

  route.get("/sessions/:id/attachments/:messageIndex/:attachmentId", (c) => {
    const session = loadSession(c.req.param("id"));
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Attachment not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    if (messageIndex === undefined) return c.json({ error: "Attachment not found" }, 404);

    const image = readImageAttachment(session.messages[messageIndex], c.req.param("attachmentId"));
    if (!image) return c.json({ error: "Attachment not found" }, 404);
    return imageResponse(image);
  });

  route.post("/sessions", jsonValidator(sessionDraftRequestSchema), async (c) => {
    const currentUserId = c.get("user").id;
    const draft = c.req.valid("json");
    const agent = readVisibleAgent(currentUserId, draft.agentId);
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, draft.modelRefId)).get();
    if (!modelRef || !canUseModel(currentUserId, modelRef)) return c.json({ error: "Model not found." }, 404);
    const timestamp = now();
    const session: Session = {
      id: id("session"),
      title: draft.title ?? "Untitled session",
      userId: currentUserId,
      agentId: draft.agentId,
      modelRefId: draft.modelRefId,
      thinkingLevel: resolveSupportedThinkingLevel(modelRef, draft.thinkingLevel ?? agent.defaultThinkingLevel ?? "off"),
      messages: [],
      pinnedAt: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.insert(sessions).values(toSessionRow(session)).run();
    return c.json(serializeSession(session), 201);
  });

  route.post("/sessions/import/open-webui", jsonValidator(openWebuiImportRequestSchema), async (c) => {
    const currentUserId = c.get("user").id;
    const body = c.req.valid("json");
    const agent = readVisibleAgent(currentUserId, body.agentId);
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, body.modelRefId)).get();
    if (!modelRef || !canUseModel(currentUserId, modelRef)) return c.json({ error: "Model not found." }, 404);

    const thinkingLevel = resolveSupportedThinkingLevel(
      modelRef,
      body.thinkingLevel ?? agent.defaultThinkingLevel ?? "off",
    );
    const imported = importOpenWebuiSessions(body.source, {
      userId: currentUserId,
      agentId: agent.id,
      modelRefId: modelRef.id,
      thinkingLevel,
      modelRef: { provider: modelRef.provider, modelId: modelRef.modelId, api: modelRef.api ?? undefined },
      now: now(),
    });
    if (imported.sessions.length === 0) {
      return c.json({ error: "No importable Open WebUI conversations found." }, 400);
    }

    const timestamp = now();
    db.transaction((tx) => {
      for (const session of imported.sessions) {
        tx.insert(sessions).values(toSessionRow(session)).run();
        if (session.messages.length === 0) continue;
        tx.insert(sessionMessages)
          .values(
            session.messages.map((message, seq) => ({
              id: id("session_message"),
              sessionId: session.id,
              seq,
              message,
              createdAt: timestamp,
            })),
          )
          .run();
      }
    });

    const result: SessionImportResult = {
      sessions: imported.sessions.map(serializeSession),
      skipped: imported.skipped,
    };
    return c.json(result, 201);
  });

  route.patch("/sessions/:id", jsonValidator(sessionPatchRequestSchema), async (c) => {
    const patch = c.req.valid("json") as Partial<Session> & { pinnedAt?: number | null };
    const sessionId = c.req.param("id");
    const current = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!current || current.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    if (patch.modelRefId && !canUseModel(c.get("user").id, patch.modelRefId)) {
      return c.json({ error: "Model not found." }, 404);
    }
    // Switching model, thinking level, or pin state are preferences and must not
    // affect the session's update time or its sort order. Only a rename counts as
    // a meaningful edit here; conversation activity touches updatedAt elsewhere.
    const titleChanged = patch.title !== undefined && patch.title !== current.title;
    db.update(sessions)
      .set({
        title: patch.title ?? current.title,
        modelRefId: patch.modelRefId ?? current.modelRefId,
        thinkingLevel: patch.thinkingLevel ?? current.thinkingLevel,
        forkedFrom: current.forkedFrom,
        pinnedAt: patch.pinnedAt === null ? null : (patch.pinnedAt ?? current.pinnedAt ?? null),
        updatedAt: titleChanged ? now() : current.updatedAt,
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(loadSession(sessionId)!));
  });

  route.post("/sessions/:id/fork", jsonValidator(forkSessionRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const body = c.req.valid("json");
    const source = loadSession(sessionId);
    if (!source || source.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    const timestamp = now();
    const fork: Session = {
      ...source,
      id: id("session"),
      title: `${source.title} fork`,
      messages: source.messages.slice(0, body.messageIndex + 1),
      forkedFrom: { sessionId, messageIndex: body.messageIndex },
      pinnedAt: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.insert(sessions).values(toSessionRow(fork)).run();
    replaceSessionMessages(fork.id, fork.messages);
    return c.json(serializeSession(fork), 201);
  });

  route.post("/sessions/:id/messages/truncate", jsonValidator(sessionTruncateRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const body = c.req.valid("json");
    const current = loadSession(sessionId);
    if (!current || current.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    if (body.messageIndex >= current.messages.length) return c.json({ error: "Message not found" }, 404);

    replaceSessionMessages(sessionId, current.messages.slice(0, body.messageIndex + 1));
    db.update(sessions)
      .set({
        thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
        updatedAt: now(),
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(loadSession(sessionId)!));
  });

  route.patch("/sessions/:id/messages/:messageIndex", jsonValidator(sessionMessageEditRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const messageIndex = Number(c.req.param("messageIndex"));
    const body = c.req.valid("json");
    const current = loadSession(sessionId);
    if (!current || current.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= current.messages.length) {
      return c.json({ error: "Message not found" }, 404);
    }

    const target = current.messages[messageIndex];
    const editableUser = isEditableUserMessage(target);
    const editableAssistant = isEditableAssistantMessage(target);
    if (!editableUser && !editableAssistant) return c.json({ error: "Message is not editable" }, 400);

    const editedMessage = editableUser
      ? updateUserMessageContent(target, body.content)
      : updateAssistantMessageContent(target, body.content);
    // Only user-message edits may truncate and rerun the conversation. Editing an
    // assistant message rewrites it in place and never drops later messages.
    const messages =
      editableUser && body.truncate
        ? [...current.messages.slice(0, messageIndex), editedMessage]
        : current.messages.map((message, index) => (index === messageIndex ? editedMessage : message));

    replaceSessionMessages(sessionId, messages);
    db.update(sessions)
      .set({
        thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
        updatedAt: now(),
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(loadSession(sessionId)!));
  });

  route.delete("/sessions/:id", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return c.json({ ok: true });
  });

  return route;
}

function toSessionRow(session: Session) {
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    agentId: session.agentId,
    modelRefId: session.modelRefId,
    thinkingLevel: session.thinkingLevel,
    forkedFrom: session.forkedFrom ?? null,
    pinnedAt: session.pinnedAt ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function isEditableUserMessage(message: AgentMessage) {
  const role = (message as { role?: string }).role;
  return role === "user" || role === "user-with-attachments";
}

function isEditableAssistantMessage(message: AgentMessage) {
  const current = message as { role?: string; content?: unknown };
  if (current.role !== "assistant" || !Array.isArray(current.content)) return false;
  let hasText = false;
  for (const part of current.content) {
    if (!isRecord(part)) continue;
    if (part.type === "toolCall") return false;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) hasText = true;
  }
  return hasText;
}

function updateAssistantMessageContent(message: AgentMessage, content: string): AgentMessage {
  const current = message as AgentMessage & { content?: unknown };
  if (!Array.isArray(current.content)) return message;

  let textSeen = false;
  const nextContent: unknown[] = [];
  for (const part of current.content) {
    if (isRecord(part) && part.type === "text") {
      // Collapse the new text into the first text part; drop later text parts.
      if (textSeen) continue;
      textSeen = true;
      nextContent.push({ ...part, text: content });
    } else {
      nextContent.push(part);
    }
  }
  if (!textSeen) nextContent.push({ type: "text", text: content });
  return { ...message, content: nextContent } as AgentMessage;
}

function updateUserMessageContent(message: AgentMessage, content: string): AgentMessage {
  if (!isEditableUserMessage(message)) return message;
  const current = message as AgentMessage & { content?: unknown };
  if (typeof current.content === "string") return { ...message, content } as AgentMessage;
  if (!Array.isArray(current.content)) return message;

  let replacedText = false;
  const nextContent = current.content.map((part) => {
    if (!part || typeof part !== "object" || !("type" in part)) return part;
    if (part.type !== "text" || replacedText) return part;
    replacedText = true;
    return { ...part, text: content };
  });

  if (!replacedText) nextContent.unshift({ type: "text", text: content });
  return { ...message, content: nextContent } as AgentMessage;
}

function parseIndex(value: string) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function readMessageImage(message: AgentMessage | undefined, imageIndex: number) {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;

  let currentImageIndex = 0;
  for (const part of content) {
    if (!isRecord(part) || part.type !== "image") continue;
    if (currentImageIndex === imageIndex) return readImageContent(part);
    currentImageIndex++;
  }
  return undefined;
}

function readToolResultImage(message: AgentMessage | undefined, partIndex: number) {
  if ((message as { role?: string } | undefined)?.role !== "toolResult") return undefined;
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const part = content[partIndex];
  if (!isRecord(part) || part.type !== "image") return undefined;
  return readImageContent(part);
}

function readImageAttachment(message: AgentMessage | undefined, attachmentId: string) {
  if ((message as { role?: string } | undefined)?.role !== "user-with-attachments") return undefined;
  const attachments = (message as { attachments?: unknown } | undefined)?.attachments;
  if (!Array.isArray(attachments)) return undefined;
  const attachment = attachments.find((item) => isRecord(item) && item.id === attachmentId);
  if (!isRecord(attachment) || attachment.type !== "image") return undefined;

  const data = typeof attachment.content === "string" ? attachment.content : undefined;
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : "image/png";
  return data ? { data, mimeType } : undefined;
}

function readImageContent(part: Record<string, unknown>) {
  const data = typeof part.data === "string" ? part.data : undefined;
  const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
  return data ? { data, mimeType } : undefined;
}

function imageResponse(image: { data: string; mimeType: string }) {
  const data = image.data.includes(",") ? image.data.split(",", 2)[1] : image.data;
  const body = Buffer.from(data, "base64");
  return new Response(body, {
    headers: {
      "cache-control": "private, max-age=31536000, immutable",
      "content-length": String(body.byteLength),
      "content-type": safeImageMimeType(image.mimeType),
    },
  });
}

function safeImageMimeType(mimeType: string) {
  return mimeType.startsWith("image/") ? mimeType : "image/png";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
