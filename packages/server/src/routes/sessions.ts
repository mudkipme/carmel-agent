import type { Session, SessionImportResult } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { modelRefs, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { importOpenWebuiSessions } from "../import/open-webui.ts";
import { serializeSession } from "../serializers.ts";
import { canUseModel, readVisibleAgent, resolveSupportedThinkingLevel } from "../services/agent-access.ts";
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
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    return c.json(serializeSession(session));
  });

  route.get("/sessions/:id/images/:messageIndex/:imageIndex", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Image not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    const imageIndex = parseIndex(c.req.param("imageIndex"));
    if (messageIndex === undefined || imageIndex === undefined) return c.json({ error: "Image not found" }, 404);

    const image = readMessageImage(session.messages[messageIndex], imageIndex);
    if (!image) return c.json({ error: "Image not found" }, 404);
    return imageResponse(image);
  });

  route.get("/sessions/:id/tool-result-images/:messageIndex/:partIndex", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Image not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    const partIndex = parseIndex(c.req.param("partIndex"));
    if (messageIndex === undefined || partIndex === undefined) return c.json({ error: "Image not found" }, 404);

    const image = readToolResultImage(session.messages[messageIndex], partIndex);
    if (!image) return c.json({ error: "Image not found" }, 404);
    return imageResponse(image);
  });

  route.get("/sessions/:id/attachments/:messageIndex/:attachmentId", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
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
    db.insert(sessions).values(session).run();
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

    db.transaction((tx) => {
      for (const session of imported.sessions) tx.insert(sessions).values(session).run();
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
    const updated: Session = {
      ...current,
      title: patch.title ?? current.title,
      modelRefId: patch.modelRefId ?? current.modelRefId,
      thinkingLevel: patch.thinkingLevel ?? current.thinkingLevel,
      messages: current.messages,
      forkedFrom: current.forkedFrom ?? undefined,
      pinnedAt: patch.pinnedAt === null ? undefined : (patch.pinnedAt ?? current.pinnedAt ?? undefined),
      id: sessionId,
      updatedAt: now(),
    };
    db.update(sessions)
      .set({
        title: updated.title,
        userId: updated.userId,
        agentId: updated.agentId,
        modelRefId: updated.modelRefId,
        thinkingLevel: updated.thinkingLevel,
        messages: updated.messages,
        forkedFrom: updated.forkedFrom,
        pinnedAt: patch.pinnedAt === null ? null : updated.pinnedAt,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(updated));
  });

  route.post("/sessions/:id/fork", jsonValidator(forkSessionRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const body = c.req.valid("json");
    const source = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
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
    db.insert(sessions).values(fork).run();
    return c.json(serializeSession(fork), 201);
  });

  route.post("/sessions/:id/messages/truncate", jsonValidator(sessionTruncateRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const body = c.req.valid("json");
    const current = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!current || current.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    if (body.messageIndex >= current.messages.length) return c.json({ error: "Message not found" }, 404);

    const updated: Session = {
      ...current,
      thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
      messages: current.messages.slice(0, body.messageIndex + 1),
      forkedFrom: current.forkedFrom ?? undefined,
      pinnedAt: current.pinnedAt ?? undefined,
      updatedAt: now(),
    };
    db.update(sessions)
      .set({
        thinkingLevel: updated.thinkingLevel,
        messages: updated.messages,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(updated));
  });

  route.patch("/sessions/:id/messages/:messageIndex", jsonValidator(sessionMessageEditRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const messageIndex = Number(c.req.param("messageIndex"));
    const body = c.req.valid("json");
    const current = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!current || current.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= current.messages.length) {
      return c.json({ error: "Message not found" }, 404);
    }

    const target = current.messages[messageIndex];
    if (!isEditableUserMessage(target)) return c.json({ error: "Message is not editable" }, 400);
    const editedMessage = updateUserMessageContent(target, body.content);
    const messages = body.truncate
      ? [...current.messages.slice(0, messageIndex), editedMessage]
      : current.messages.map((message, index) => (index === messageIndex ? editedMessage : message));

    const updated: Session = {
      ...current,
      thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
      messages,
      forkedFrom: current.forkedFrom ?? undefined,
      pinnedAt: current.pinnedAt ?? undefined,
      updatedAt: now(),
    };
    db.update(sessions)
      .set({
        thinkingLevel: updated.thinkingLevel,
        messages: updated.messages,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(updated));
  });

  route.delete("/sessions/:id", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return c.json({ ok: true });
  });

  return route;
}

function isEditableUserMessage(message: AgentMessage) {
  const role = (message as { role?: string }).role;
  return role === "user" || role === "user-with-attachments";
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
