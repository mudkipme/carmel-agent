import type { Session, SessionImportResult } from "@carmel-agent/shared";
import {
  isEditableAssistantMessage,
  isUserMessage,
  updateAssistantMessageContent,
  updateUserMessageContent,
} from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { modelRefs, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { importOpenWebuiSessions } from "../import/open-webui.ts";
import { serializeSession } from "../serializers.ts";
import { canUseModel, readVisibleAgent, resolveSupportedThinkingLevel } from "../services/agent-access.ts";
import { readActiveRunLeaseForSession } from "../services/active-run-lease.ts";
import { loadSession, readSessionMessageAt, replaceSessionMessages } from "../services/session-store.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";
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
    const session = ownedSession(c);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(serializeSession(session));
  });

  route.get("/sessions/:id/images/:messageIndex/:imageIndex", (c) => {
    const session = ownedSessionRecord(c);
    if (!session) return c.json({ error: "Image not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    const imageIndex = parseIndex(c.req.param("imageIndex"));
    if (messageIndex === undefined || imageIndex === undefined) return c.json({ error: "Image not found" }, 404);

    const image = readMessageImage(readSessionMessageAt(session.id, messageIndex), imageIndex);
    if (!image) return c.json({ error: "Image not found" }, 404);
    return imageResponse(image);
  });

  route.get("/sessions/:id/tool-result-images/:messageIndex/:partIndex", (c) => {
    const session = ownedSessionRecord(c);
    if (!session) return c.json({ error: "Image not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    const partIndex = parseIndex(c.req.param("partIndex"));
    if (messageIndex === undefined || partIndex === undefined) return c.json({ error: "Image not found" }, 404);

    const image = readToolResultImage(readSessionMessageAt(session.id, messageIndex), partIndex);
    if (!image) return c.json({ error: "Image not found" }, 404);
    return imageResponse(image);
  });

  route.get("/sessions/:id/attachments/:messageIndex/:attachmentId", (c) => {
    const session = ownedSessionRecord(c);
    if (!session) return c.json({ error: "Attachment not found" }, 404);

    const messageIndex = parseIndex(c.req.param("messageIndex"));
    if (messageIndex === undefined) return c.json({ error: "Attachment not found" }, 404);

    const image = readImageAttachment(readSessionMessageAt(session.id, messageIndex), c.req.param("attachmentId"));
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
      revision: 0,
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

    db.transaction((tx) => {
      for (const session of imported.sessions) {
        tx.insert(sessions).values(toSessionRow(session)).run();
        if (session.messages.length > 0) replaceSessionMessages(session.id, session.messages);
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
    const leaseConflict = rejectActiveRunMutation(c, current.id);
    if (leaseConflict) return leaseConflict;
    if (patch.modelRefId && !canUseModel(c.get("user").id, patch.modelRefId)) {
      return c.json({ error: "Model not found." }, 404);
    }
    // Clamp the thinking level to what the (possibly newly selected) model supports,
    // matching the create/import write paths so PATCH can't persist an unsupported level.
    let thinkingLevel = patch.thinkingLevel ?? current.thinkingLevel;
    if (patch.thinkingLevel !== undefined || patch.modelRefId !== undefined) {
      const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, patch.modelRefId ?? current.modelRefId)).get();
      if (modelRef) thinkingLevel = resolveSupportedThinkingLevel(modelRef, thinkingLevel);
    }
    // Switching model, thinking level, or pin state are preferences and must not
    // affect the session's update time or its sort order. Only a rename counts as
    // a meaningful edit here; conversation activity touches updatedAt elsewhere.
    const titleChanged = patch.title !== undefined && patch.title !== current.title;
    db.update(sessions)
      .set({
        title: patch.title ?? current.title,
        modelRefId: patch.modelRefId ?? current.modelRefId,
        thinkingLevel,
        forkedFrom: current.forkedFrom,
        pinnedAt: patch.pinnedAt === null ? null : (patch.pinnedAt ?? current.pinnedAt ?? null),
        revision: sql`${sessions.revision} + 1`,
        updatedAt: titleChanged ? now() : current.updatedAt,
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(loadSession(sessionId)!));
  });

  route.post("/sessions/:id/fork", jsonValidator(forkSessionRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const body = c.req.valid("json");
    const source = ownedSession(c);
    if (!source) return c.json({ error: "Session not found" }, 404);
    const leaseConflict = rejectActiveRunMutation(c, source.id);
    if (leaseConflict) return leaseConflict;
    if (body.messageIndex >= source.messages.length) return c.json({ error: "Message not found" }, 404);
    const timestamp = now();
    const fork: Session = {
      ...source,
      id: id("session"),
      title: `${source.title} fork`,
      messages: source.messages.slice(0, body.messageIndex + 1),
      forkedFrom: { sessionId, messageIndex: body.messageIndex },
      pinnedAt: undefined,
      revision: 0,
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
    const current = ownedSession(c);
    if (!current) return c.json({ error: "Session not found" }, 404);
    const leaseConflict = rejectActiveRunMutation(c, current.id);
    if (leaseConflict) return leaseConflict;
    if (body.messageIndex >= current.messages.length) return c.json({ error: "Message not found" }, 404);

    replaceSessionMessages(sessionId, current.messages.slice(0, body.messageIndex + 1));
    db.update(sessions)
      .set({
        thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
        revision: sql`${sessions.revision} + 1`,
        updatedAt: now(),
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(loadSession(sessionId)!));
  });

  route.patch("/sessions/:id/messages/:messageIndex", jsonValidator(sessionMessageEditRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const messageIndex = parseIndex(c.req.param("messageIndex"));
    const body = c.req.valid("json");
    const current = ownedSession(c);
    if (!current) return c.json({ error: "Session not found" }, 404);
    const leaseConflict = rejectActiveRunMutation(c, current.id);
    if (leaseConflict) return leaseConflict;
    if (messageIndex === undefined || messageIndex >= current.messages.length) {
      return c.json({ error: "Message not found" }, 404);
    }

    const target = current.messages[messageIndex];
    const editableUser = isUserMessage(target);
    const editableAssistant = isEditableAssistantMessage(target);
    if (!editableUser && !editableAssistant) return c.json({ error: "Message is not editable" }, 400);

    const editedMessage = editableUser
      ? updateUserMessageContent(target, body.content, {
          removedImageIndexes: body.removedImageIndexes,
          removedAttachmentIds: body.removedAttachmentIds,
        })
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
        revision: sql`${sessions.revision} + 1`,
        updatedAt: now(),
      })
      .where(eq(sessions.id, sessionId))
      .run();
    return c.json(serializeSession(loadSession(sessionId)!));
  });

  route.delete("/sessions/:id", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    const leaseConflict = rejectActiveRunMutation(c, session.id);
    if (leaseConflict) return leaseConflict;
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return c.json({ ok: true });
  });

  return route;
}

function rejectActiveRunMutation(c: Context<{ Variables: AuthVariables }>, sessionId: string) {
  const run = readActiveRunLeaseForSession(sessionId);
  return run ? activeRunConflictResponse(c, run) : undefined;
}

function toSessionRow(session: Session) {
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    agentId: session.agentId,
    modelRefId: session.modelRefId,
    thinkingLevel: session.thinkingLevel,
    revision: session.revision,
    forkedFrom: session.forkedFrom ?? null,
    pinnedAt: session.pinnedAt ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

// Load the `:id` session and confirm the caller owns it; returns undefined
// otherwise so handlers can answer 404 with their own resource-specific message.
function ownedSession(c: Context<{ Variables: AuthVariables }>) {
  const sessionId = c.req.param("id");
  const session = sessionId ? loadSession(sessionId) : undefined;
  return session && session.userId === c.get("user").id ? session : undefined;
}

// Ownership check that loads only the session row, not its messages. Use for
// per-message endpoints (images/attachments) that read one message by index and
// would otherwise deserialize the whole transcript on every request.
function ownedSessionRecord(c: Context<{ Variables: AuthVariables }>) {
  const sessionId = c.req.param("id");
  const record = sessionId ? db.select().from(sessions).where(eq(sessions.id, sessionId)).get() : undefined;
  return record && record.userId === c.get("user").id ? record : undefined;
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
