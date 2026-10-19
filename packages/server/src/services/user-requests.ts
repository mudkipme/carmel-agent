import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  questionAnswerSchema,
  questionInputSchema,
  secretRequestInputSchema,
  type QuestionInput,
  type SecretRequestInput,
  type UserRequest,
} from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { agentSecrets, userRequests } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import {
  AgentSecretError,
  assertSessionOwner,
  findAvailableSecret,
  serializeCredential,
  storeSessionSecret,
} from "./agent-secrets.ts";

type RequestRecord = typeof userRequests.$inferSelect;
const requestLifetime = 7 * 24 * 60 * 60 * 1000;

export function findCallUserRequest(context: {
  sessionId: string;
  conversationId: string;
  callId: string;
}) {
  const row = db
    .select()
    .from(userRequests)
    .where(
      and(
        eq(userRequests.sessionId, context.sessionId),
        eq(userRequests.conversationId, context.conversationId),
        eq(userRequests.callId, context.callId),
      ),
    )
    .get();
  return row ? serializeUserRequest(row) : undefined;
}

/** Stable across replay; callId is the native tool task ID, not a provider's potentially reused call ID. */
export function createUserRequest(
  context: { sessionId: string; conversationId: string; callId: string },
  kind: "question" | "secret",
  input: QuestionInput | SecretRequestInput,
): UserRequest {
  const parsed =
    kind === "question" ? questionInputSchema.parse(input) : secretRequestInputSchema.parse(input);
  const id = createHash("sha256")
    .update(JSON.stringify([context.sessionId, context.conversationId, context.callId]))
    .digest("hex");
  const existing = db.select().from(userRequests).where(eq(userRequests.id, id)).get();
  if (existing) return serializeUserRequest(existing);
  const blocked = blockingUserRequest(context.sessionId);
  if (blocked)
    throw new AgentSecretError("Answer the existing request before creating another.", 409);
  const timestamp = now();
  const row = {
    ...context,
    id,
    kind,
    input: parsed,
    status: "pending" as const,
    createdAt: timestamp,
    expiresAt: timestamp + requestLifetime,
  };
  db.insert(userRequests).values(row).run();
  return serializeUserRequest({ ...row, answer: null, secretId: null, delivery: null });
}

function expireRequests(sessionId: string) {
  for (const row of db
    .select()
    .from(userRequests)
    .where(and(eq(userRequests.sessionId, sessionId), eq(userRequests.status, "pending")))
    .all()) {
    if (row.expiresAt <= now())
      db.update(userRequests)
        .set({ status: "expired", delivery: "pending" })
        .where(eq(userRequests.id, row.id))
        .run();
  }
}

export function readUserRequests(sessionId: string, conversationId?: string): UserRequest[] {
  expireRequests(sessionId);
  return db
    .select()
    .from(userRequests)
    .where(
      and(
        eq(userRequests.sessionId, sessionId),
        conversationId ? eq(userRequests.conversationId, conversationId) : undefined,
      ),
    )
    .orderBy(asc(userRequests.createdAt))
    .all()
    .map(serializeUserRequest);
}

/** A pending receipt also gates new prompts until its idempotent submission is admitted. */
export function blockingUserRequest(sessionId: string) {
  expireRequests(sessionId);
  return db
    .select()
    .from(userRequests)
    .where(eq(userRequests.sessionId, sessionId))
    .orderBy(asc(userRequests.createdAt))
    .all()
    .find((row) => row.status === "pending" || row.delivery === "pending");
}

function ownedRequest(userId: string, sessionId: string, requestId: string) {
  assertSessionOwner(userId, sessionId);
  expireRequests(sessionId);
  const row = db
    .select()
    .from(userRequests)
    .where(and(eq(userRequests.id, requestId), eq(userRequests.sessionId, sessionId)))
    .get();
  if (!row) throw new AgentSecretError("Request not found.", 404);
  return row;
}

export function answerQuestion(
  userId: string,
  sessionId: string,
  requestId: string,
  body: unknown,
): UserRequest {
  const row = ownedRequest(userId, sessionId, requestId);
  if (row.kind !== "question")
    throw new AgentSecretError("Use the credential form for this request.", 400);
  // Lost-response retries never change an answer or create a second delivery.
  if (row.status === "answered") return serializeUserRequest(row);
  if (row.status !== "pending")
    throw new AgentSecretError("This request is no longer pending.", 409);
  const parsed = questionAnswerSchema.safeParse(body);
  if (!parsed.success) throw new AgentSecretError("Invalid question answer.", 400);
  const answer = parsed.data;
  const input = row.input as QuestionInput;
  if (
    new Set(answer.selected).size !== answer.selected.length ||
    answer.selected.some((id) => !input.options.some((option) => option.id === id)) ||
    (!input.multiple && answer.selected.length > 1) ||
    (!input.allowFreeText && answer.text) ||
    (!answer.selected.length && !answer.text)
  ) {
    throw new AgentSecretError("Choose an available option or enter an allowed answer.", 400);
  }
  db.update(userRequests)
    .set({ status: "answered", answer, delivery: "pending" })
    .where(eq(userRequests.id, row.id))
    .run();
  return serializeUserRequest({ ...row, status: "answered", answer, delivery: "pending" });
}

/** The value's only destination is the encrypted store, never this row or a Pi submission. */
export function answerSecretRequest(
  userId: string,
  sessionId: string,
  requestId: string,
  value: string,
): UserRequest {
  return db.transaction(() => {
    const row = ownedRequest(userId, sessionId, requestId);
    if (row.kind !== "secret") throw new AgentSecretError("This is not a credential request.", 400);
    if (row.status === "answered") return serializeUserRequest(row);
    if (row.status !== "pending")
      throw new AgentSecretError("This request is no longer pending.", 409);
    const input = row.input as SecretRequestInput;
    const credential = storeSessionSecret(userId, sessionId, input.name, value);
    db.update(userRequests)
      .set({ status: "answered", secretId: credential.id, delivery: "pending" })
      .where(eq(userRequests.id, row.id))
      .run();
    return serializeUserRequest({
      ...row,
      status: "answered",
      secretId: credential.id,
      delivery: "pending",
    });
  });
}

export function useAvailableSecret(
  userId: string,
  sessionId: string,
  requestId: string,
): UserRequest {
  const row = ownedRequest(userId, sessionId, requestId);
  if (row.kind !== "secret") throw new AgentSecretError("This is not a credential request.", 400);
  if (row.status === "answered") return serializeUserRequest(row);
  if (row.status !== "pending")
    throw new AgentSecretError("This request is no longer pending.", 409);
  const credential = findAvailableSecret(sessionId, (row.input as SecretRequestInput).name);
  if (!credential) throw new AgentSecretError("Credential not available.", 404);
  db.update(userRequests)
    .set({ status: "answered", secretId: credential.id, delivery: "pending" })
    .where(eq(userRequests.id, row.id))
    .run();
  return serializeUserRequest({
    ...row,
    status: "answered",
    secretId: credential.id,
    delivery: "pending",
  });
}

export function cancelUserRequest(userId: string, sessionId: string, requestId: string) {
  const row = ownedRequest(userId, sessionId, requestId);
  if (row.status === "cancelled" || row.status === "expired") return serializeUserRequest(row);
  if (row.status !== "pending")
    throw new AgentSecretError("This request has already been answered.", 409);
  db.update(userRequests)
    .set({ status: "cancelled", delivery: "pending" })
    .where(eq(userRequests.id, row.id))
    .run();
  return serializeUserRequest({ ...row, status: "cancelled", delivery: "pending" });
}

export function pendingUserReply(sessionId: string) {
  const row = blockingUserRequest(sessionId);
  if (!row || row.status === "pending") return undefined;
  let text: string;
  if (row.status !== "answered")
    text = `The user ${row.status === "expired" ? "did not answer before this request expired" : "declined this request"}. Do not repeat it unless the user asks.`;
  else if (row.kind === "secret") {
    const name = (row.input as SecretRequestInput).name;
    const available = findAvailableSecret(sessionId, name);
    text = available
      ? `Credential ${name} is available as an environment variable for this ${available.scope}. Use $${name} in bash; never print, encode, or save its value. Secret reference: ${available.id}.`
      : `Credential ${name} was revoked before continuation. Do not assume it is available.`;
  } else {
    const input = row.input as QuestionInput;
    text = JSON.stringify({
      requestId: row.id,
      question: input.question,
      selected: row.answer!.selected.map((id) => input.options.find((option) => option.id === id)!),
      text: row.answer!.text,
    });
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    requestId: `user-request:${row.id}`,
    text: `Response to request ${row.id}:\n${text}`,
  };
}

export function markUserReplySubmitted(requestId: string) {
  db.update(userRequests)
    .set({ delivery: "submitted" })
    .where(eq(userRequests.id, requestId))
    .run();
}

function serializeUserRequest(row: RequestRecord): UserRequest {
  const credential = row.secretId
    ? db.select().from(agentSecrets).where(eq(agentSecrets.id, row.secretId)).get()
    : undefined;
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    ...(row.kind === "question"
      ? { question: row.input as QuestionInput }
      : { secret: row.input as SecretRequestInput }),
    status: row.status,
    ...(row.answer ? { answer: row.answer } : {}),
    ...(credential && (!credential.sessionId || credential.sessionId === row.sessionId)
      ? { credential: serializeCredential(credential) }
      : {}),
    delivery: row.delivery,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
