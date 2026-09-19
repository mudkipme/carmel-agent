import type { Session, SessionImportResult, SessionPatch } from "@carmel-agent/shared";
import { isRecord, toSessionRow } from "@carmel-agent/shared";
import {
  isEditableAssistantMessage,
  isUserMessage,
  updateAssistantMessageContent,
  updateUserMessageContent,
} from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { modelRefs, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { importOpenWebuiSessions } from "../import/open-webui.ts";
import { serializeSession, serializeSessionMetadata } from "../serializers.ts";
import { canUseModel, readVisibleAgent, resolveSupportedThinkingLevel } from "../services/agent-access.ts";
import { readActiveRunLeaseForSession } from "../services/active-run-lease.ts";
import { deleteIssueForSession } from "../services/issues.ts";
import { deletePiSession, forkPiSession } from "../services/pi-session-storage.ts";
import {
  editSessionMessageEntry,
  loadOwnedSession,
  loadSession,
  readSessionMessageByEntryId,
  replaceSessionMessages,
  truncateSessionAtEntry,
  type SessionWithMessages,
} from "../services/session-store.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";
import { checkCutPoint, describeCutPointRejection, type BranchMessage } from "../effectors/branch-integrity.ts";
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

  // Archived sessions are left out of bootstrap, so agent settings reads them here.
  route.get("/agents/:agentId/archived-sessions", (c) => {
    const currentUserId = c.get("user").id;
    const agent = readVisibleAgent(currentUserId, c.req.param("agentId"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    const archived = db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, currentUserId), eq(sessions.agentId, agent.id), isNotNull(sessions.archivedAt)))
      .orderBy(desc(sessions.archivedAt))
      .all();
    return c.json(archived.map(serializeSessionMetadata));
  });

  // Addressed by entry id, which is immutable, so the responses can be cached for good.
  route.get("/sessions/:id/images/:entryId/:imageIndex", (c) =>
    serveEntryImage(c, "Image not found", (message) => {
      const imageIndex = parseIndex(c.req.param("imageIndex"));
      return imageIndex === undefined ? undefined : readMessageImage(message, imageIndex);
    }),
  );

  route.get("/sessions/:id/tool-result-images/:entryId/:partIndex", (c) =>
    serveEntryImage(c, "Image not found", (message) => {
      const partIndex = parseIndex(c.req.param("partIndex"));
      return partIndex === undefined ? undefined : readToolResultImage(message, partIndex);
    }),
  );

  route.get("/sessions/:id/attachments/:entryId/:attachmentId", (c) =>
    serveEntryImage(c, "Attachment not found", (message) => readImageAttachment(message, c.req.param("attachmentId"))),
  );

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
      messageEntryIds: [],
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
      for (const session of imported.sessions) tx.insert(sessions).values(toSessionRow(session)).run();
    });
    try {
      for (const session of imported.sessions) {
        if (session.messages.length > 0) await replaceSessionMessages(session.id, session.messages);
      }
    } catch (error) {
      for (const session of imported.sessions) {
        await deletePiSession(toSessionRow(session)).catch(() => undefined);
        db.delete(sessions).where(eq(sessions.id, session.id)).run();
      }
      throw error;
    }

    const persisted = await Promise.all(imported.sessions.map((session) => loadSession(session.id)));
    const result: SessionImportResult = {
      sessions: persisted.filter((session): session is NonNullable<typeof session> => Boolean(session)).map(serializeSession),
      skipped: imported.skipped,
    };
    return c.json(result, 201);
  });

  route.patch("/sessions/:id", jsonValidator(sessionPatchRequestSchema), async (c) => {
    const patch = c.req.valid("json");
    // Row-only ownership check: nothing here needs the transcript before the commit.
    const current = ownedSessionRecord(c);
    if (!current) return c.json({ error: "Session not found" }, 404);

    // Pin, archive, and leaving the task list only move the session around the
    // sidebar. A run never writes them, so they go through while one is active,
    // and without a revision bump -- that would make the run's own commit stale.
    if (isPlacementOnlyPatch(patch)) {
      db.update(sessions)
        .set({
          ...(patch.pinnedAt !== undefined ? { pinnedAt: patch.pinnedAt } : {}),
          ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
          ...(patch.taskId === null ? { taskId: null } : {}),
        })
        .where(eq(sessions.id, current.id))
        .run();
      return c.json(serializeSession((await loadSession(current.id))!));
    }

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
    // Switching model, thinking level, pin, or archive state are preferences and must not
    // affect the session's update time or its sort order. Only a rename counts as
    // a meaningful edit here; conversation activity touches updatedAt elsewhere.
    const titleChanged = patch.title !== undefined && patch.title !== current.title;
    return c.json(await commitSessionChange(current.id, {
      title: patch.title ?? current.title,
      modelRefId: patch.modelRefId ?? current.modelRefId,
      thinkingLevel,
      forkedFrom: current.forkedFrom,
      pinnedAt: patch.pinnedAt === null ? null : (patch.pinnedAt ?? current.pinnedAt ?? null),
      archivedAt: patch.archivedAt === null ? null : (patch.archivedAt ?? current.archivedAt ?? null),
      taskId: patch.taskId === null ? null : current.taskId,
      updatedAt: titleChanged ? now() : current.updatedAt,
    }));
  });

  route.post("/sessions/:id/fork", jsonValidator(forkSessionRequestSchema), async (c) => {
    const sessionId = c.req.param("id");
    const body = c.req.valid("json");
    const { session: source, conflict } = await guardSessionMutation(c);
    if (!source) return conflict;
    const messageIndex = source.messageEntryIds.indexOf(body.entryId);
    if (messageIndex < 0) return c.json({ error: "Message not found" }, 404);
    // A fork ends its new branch at `entryId`, so it is the same cut as a
    // truncate and carries the same way of producing an unpromptable session.
    const cut = checkCutPoint(branchOf(source), body.entryId);
    if (!cut.ok) {
      return c.json({ error: describeCutPointRejection(cut), safeEntryId: cut.safeEntryId }, 409);
    }
    const timestamp = now();
    const fork: Session = {
      ...source,
      id: id("session"),
      title: `${source.title} fork`,
      messages: source.messages.slice(0, messageIndex + 1),
      messageEntryIds: source.messageEntryIds.slice(0, messageIndex + 1),
      forkedFrom: { sessionId, entryId: body.entryId },
      pinnedAt: undefined,
      archivedAt: undefined,
      // A fork is something you chose to continue, so it joins the session
      // list even when it comes from a task run.
      taskId: undefined,
      issueId: undefined,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.insert(sessions).values(toSessionRow(fork)).run();
    try {
      await forkPiSession(source.id, fork.id, body.entryId);
    } catch (error) {
      await deletePiSession(toSessionRow(fork)).catch(() => undefined);
      db.delete(sessions).where(eq(sessions.id, fork.id)).run();
      throw error;
    }
    return c.json(serializeSession((await loadSession(fork.id))!), 201);
  });

  route.post("/sessions/:id/messages/truncate", jsonValidator(sessionTruncateRequestSchema), async (c) => {
    const body = c.req.valid("json");
    const { session: current, conflict } = await guardSessionMutation(c);
    if (!current) return conflict;
    if (!current.messageEntryIds.includes(body.entryId)) return c.json({ error: "Message not found" }, 404);
    const cut = checkCutPoint(branchOf(current), body.entryId);
    if (!cut.ok) {
      return c.json({ error: describeCutPointRejection(cut), safeEntryId: cut.safeEntryId }, 409);
    }

    await truncateSessionAtEntry(current.id, body.entryId);
    return c.json(await commitSessionChange(current.id, {
      thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
      updatedAt: now(),
    }));
  });

  route.patch("/sessions/:id/messages/:entryId", jsonValidator(sessionMessageEditRequestSchema), async (c) => {
    const entryId = c.req.param("entryId");
    const body = c.req.valid("json");
    const { session: current, conflict } = await guardSessionMutation(c);
    if (!current) return conflict;
    const messageIndex = current.messageEntryIds.indexOf(entryId);
    if (messageIndex < 0) return c.json({ error: "Message not found" }, 404);

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
    // Pi entries are immutable: create a sibling branch at this entry ID and
    // preserve the native suffix unless this is an explicit edit-and-rerun.
    await editSessionMessageEntry(current.id, entryId, editedMessage, editableUser && Boolean(body.truncate));
    return c.json(await commitSessionChange(current.id, {
      thinkingLevel: body.thinkingLevel ?? current.thinkingLevel,
      updatedAt: now(),
    }));
  });

  route.delete("/sessions/:id", async (c) => {
    const session = ownedSessionRecord(c);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const leaseConflict = rejectActiveRunMutation(c, session.id);
    if (leaseConflict) return leaseConflict;
    await deletePiSession(session);
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    deleteIssueForSession(session);
    return c.json({ ok: true });
  });

  return route;
}

/** Only fields a run never writes, so the patch cannot race one. */
function isPlacementOnlyPatch(patch: SessionPatch) {
  const keys = (Object.keys(patch) as (keyof SessionPatch)[]).filter((key) => patch[key] !== undefined);
  return keys.length > 0 && keys.every((key) => key === "pinnedAt" || key === "archivedAt" || key === "taskId");
}

/** The loaded session's branch in the shape the cut-point check reads. */
function branchOf(session: SessionWithMessages): BranchMessage[] {
  return session.messageEntryIds.map((entryId, index) => ({ entryId, message: session.messages[index]! }));
}

function rejectActiveRunMutation(c: Context<{ Variables: AuthVariables }>, sessionId: string) {
  const run = readActiveRunLeaseForSession(sessionId);
  return run ? activeRunConflictResponse(c, run) : undefined;
}

/**
 * The precondition every transcript mutation shares: the caller owns the session
 * and no agent run currently holds its lease. Returns either the loaded session
 * or the response to send instead.
 */
async function guardSessionMutation(
  c: Context<{ Variables: AuthVariables }>,
): Promise<{ session: SessionWithMessages; conflict?: undefined } | { session?: undefined; conflict: Response }> {
  const session = await ownedSession(c);
  if (!session) return { conflict: c.json({ error: "Session not found" }, 404) };
  const leaseConflict = rejectActiveRunMutation(c, session.id);
  if (leaseConflict) return { conflict: leaseConflict };
  return { session };
}

/**
 * Apply a session-row change, advance its optimistic revision, and return the
 * refreshed display projection every mutation route responds with.
 */
async function commitSessionChange(sessionId: string, patch: Partial<typeof sessions.$inferInsert>) {
  db.update(sessions)
    .set({ ...patch, revision: sql`${sessions.revision} + 1` })
    .where(eq(sessions.id, sessionId))
    .run();
  return serializeSession((await loadSession(sessionId))!);
}

// Load the `:id` session and confirm the caller owns it; returns undefined
// otherwise so handlers can answer 404 with their own resource-specific message.
async function ownedSession(c: Context<{ Variables: AuthVariables }>) {
  const sessionId = c.req.param("id");
  return sessionId ? loadOwnedSession(c.get("user").id, sessionId) : undefined;
}

// Ownership check that loads only the session row, not its messages. Use wherever
// the handler does not need the transcript — per-message endpoints that read one
// message by index, and row-only mutations — since `loadSession` would otherwise
// deserialize the whole transcript on every request.
function ownedSessionRecord(c: Context<{ Variables: AuthVariables }>) {
  const sessionId = c.req.param("id");
  const record = sessionId ? db.select().from(sessions).where(eq(sessions.id, sessionId)).get() : undefined;
  return record && record.userId === c.get("user").id ? record : undefined;
}

/** Answer with one image out of the `:entryId` message of a session the caller owns. */
async function serveEntryImage(
  c: Context<{ Variables: AuthVariables }>,
  notFound: string,
  pick: (message: AgentMessage | undefined) => { data: string; mimeType: string } | undefined,
) {
  const session = ownedSessionRecord(c);
  const entryId = c.req.param("entryId");
  const image = session && entryId ? pick(await readSessionMessageByEntryId(session.id, entryId)) : undefined;
  return image ? imageResponse(image) : c.json({ error: notFound }, 404);
}

function parseIndex(value: string | undefined) {
  if (value === undefined) return undefined;
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
