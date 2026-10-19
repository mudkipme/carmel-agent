import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agentSecrets, agents, sessions, userRequests } from "../db/schema.ts";
import { createSession, createUser } from "../test-support.ts";
import { questionInputSchema, secretRequestInputSchema } from "@carmel-agent/shared";
import {
  answerQuestion,
  answerSecretRequest,
  blockingUserRequest,
  cancelUserRequest,
  createUserRequest,
  markUserReplySubmitted,
  pendingUserReply,
  legacyUserRequestReceipt,
  readUserRequests,
} from "./user-requests.ts";
import {
  demoteAgentSecret,
  promoteSessionSecret,
  readAgentSecretEnv,
  readAgentSecrets,
  readSessionSecrets,
  revokeSessionSecret,
  storeSessionSecret,
  writeAgentSecret,
} from "./agent-secrets.ts";
import { revealSecret } from "../security.ts";

initialize();
const key = "user-request-test-encryption-key";
function withKey<T>(fn: () => T): T {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = key;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previous;
  }
}
function secretRequest(sessionId: string, callId = "secret") {
  return createUserRequest(
    { sessionId, conversationId: "1", callId },
    "secret",
    secretRequestInputSchema.parse({ name: "GITHUB_TOKEN", reason: "Create a pull request" }),
  );
}
function sibling(sessionId: string) {
  const original = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
  const id = crypto.randomUUID();
  db.insert(sessions)
    .values({ ...original, id })
    .run();
  return id;
}

test("questions persist validated choices and exactly one continuation receipt", () => {
  const { sessionId, userId } = createSession();
  const context = { sessionId, conversationId: "1", callId: "question" };
  const input = questionInputSchema.parse({
    question: "Which branch?",
    options: [{ id: "main", label: "Main" }],
    allowFreeText: false,
  });
  const request = createUserRequest(context, "question", input);
  assert.equal(createUserRequest(context, "question", input).id, request.id);
  assert.equal(readUserRequests(sessionId).length, 1);
  assert.equal(blockingUserRequest(sessionId)?.id, request.id);
  assert.throws(
    () => answerQuestion(userId, sessionId, request.id, { selected: ["unknown"] }),
    /Choose/,
  );
  assert.throws(
    () => answerQuestion(userId, sessionId, request.id, { text: "arbitrary" }),
    /Choose/,
  );
  assert.throws(
    () => answerQuestion(createUser(), sessionId, request.id, { selected: ["main"] }),
    /Session not found/,
  );
  const answered = answerQuestion(userId, sessionId, request.id, { selected: ["main"] });
  assert.equal(answered.status, "answered");
  assert.deepEqual(
    answerQuestion(userId, sessionId, request.id, { selected: ["unknown"] }),
    answered,
  );
  assert.ok(pendingUserReply(sessionId)?.text.includes("Main"));
  assert.equal(pendingUserReply(sessionId)?.requestId, `user-request:${request.id}`);
  markUserReplySubmitted(request.id);
  assert.equal(pendingUserReply(sessionId), undefined);
  assert.equal(blockingUserRequest(sessionId), undefined);
});

test("declined and expired requests have safe resumable receipts", () => {
  const { sessionId, userId } = createSession();
  const request = secretRequest(sessionId);
  cancelUserRequest(userId, sessionId, request.id);
  assert.match(pendingUserReply(sessionId)!.text, /declined/);
  assert.throws(
    () => answerSecretRequest(userId, sessionId, request.id, "ignored"),
    /no longer pending/,
  );
  markUserReplySubmitted(request.id);
  const next = secretRequest(sessionId, "next");
  db.update(userRequests).set({ expiresAt: 1 }).where(eq(userRequests.id, next.id)).run();
  assert.equal(readUserRequests(sessionId).at(-1)?.status, "expired");
  assert.match(pendingUserReply(sessionId)!.text, /expired/);
});

test("credentials are encrypted, write-only, session scoped, and idempotent", () =>
  withKey(() => {
    const { sessionId, userId, agentId } = createSession();
    const nextSession = sibling(sessionId);
    const request = secretRequest(sessionId);
    const value = "ghp_private_value_that_must_not_be_in_history";
    const result = answerSecretRequest(userId, sessionId, request.id, value);
    assert.equal(result.credential?.scope, "session");
    assert.ok(!JSON.stringify(result).includes(value));
    assert.ok(!JSON.stringify(db.select().from(userRequests).all()).includes(value));
    const encrypted = db
      .select()
      .from(agentSecrets)
      .where(eq(agentSecrets.id, result.credential!.id))
      .get()!.value;
    assert.notEqual(encrypted, value);
    assert.equal(revealSecret(encrypted), value);
    assert.ok(!pendingUserReply(sessionId)!.text.includes(value));
    assert.match(pendingUserReply(sessionId)!.text, /GITHUB_TOKEN.*available/);
    const reply = pendingUserReply(sessionId)!;
    assert.deepEqual(reply.receipt, {
      requestId: request.id,
      kind: "secret",
      status: "answered",
      name: "GITHUB_TOKEN",
      scope: "session",
    });
    assert.ok(!JSON.stringify(reply.receipt).includes(value));
    assert.deepEqual(legacyUserRequestReceipt(sessionId, reply.text), reply.receipt);
    assert.equal(legacyUserRequestReceipt(nextSession, reply.text), undefined);
    assert.deepEqual(readAgentSecretEnv(agentId), []);
    assert.deepEqual(readAgentSecretEnv(agentId, nextSession), []);
    assert.deepEqual(readAgentSecretEnv(agentId, sessionId), [{ name: "GITHUB_TOKEN", value }]);
    assert.deepEqual(readAgentSecrets(userId, agentId), []);
    assert.deepEqual(
      answerSecretRequest(userId, sessionId, request.id, "different retry value"),
      result,
    );
    assert.throws(
      () => promoteSessionSecret(userId, nextSession, result.credential!.id),
      /not found/,
    );
    assert.throws(
      () => revokeSessionSecret(userId, nextSession, result.credential!.id),
      /not found/,
    );
  }));

test("legacy credential receipts preserve their original scope after promotion or revocation", () =>
  withKey(() => {
    const { sessionId, userId } = createSession();
    const request = secretRequest(sessionId);
    const answer = answerSecretRequest(userId, sessionId, request.id, "temporary-test-token");
    const reply = pendingUserReply(sessionId)!;
    promoteSessionSecret(userId, sessionId, answer.credential!.id);
    assert.deepEqual(legacyUserRequestReceipt(sessionId, reply.text), reply.receipt);
    demoteAgentSecret(userId, sessionId, answer.credential!.id);
    revokeSessionSecret(userId, sessionId, answer.credential!.id);
    assert.deepEqual(legacyUserRequestReceipt(sessionId, reply.text), reply.receipt);
  }));

test("promotion preserves its reference, reaches future sessions and survives source deletion", (t) =>
  withKey(() => {
    let timestamp = Date.now();
    t.mock.method(Date, "now", () => timestamp++);
    const { sessionId, userId, agentId } = createSession();
    const nextSession = sibling(sessionId);
    const request = secretRequest(sessionId);
    const result = answerSecretRequest(userId, sessionId, request.id, "private-token");
    const promoted = promoteSessionSecret(userId, sessionId, result.credential!.id);
    assert.equal(promoted.id, result.credential!.id);
    assert.equal(promoted.scope, "agent");
    assert.deepEqual(promoteSessionSecret(userId, sessionId, promoted.id), promoted);
    assert.deepEqual(readAgentSecretEnv(agentId, nextSession), [
      { name: "GITHUB_TOKEN", value: "private-token" },
    ]);
    assert.equal(readUserRequests(sessionId)[0]?.credential?.scope, "agent");
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    assert.equal(readAgentSecrets(userId, agentId).length, 1);
    assert.equal(readUserRequests(sessionId).length, 0);
    const demoted = demoteAgentSecret(userId, nextSession, promoted.id);
    assert.deepEqual(readAgentSecretEnv(agentId), []);
    assert.equal(readSessionSecrets(userId, nextSession)[0]?.scope, "session");
    assert.deepEqual(readSessionSecrets(userId, nextSession)[0], demoted);
    db.delete(sessions).where(eq(sessions.id, nextSession)).run();
    assert.deepEqual(readAgentSecretEnv(agentId), []);
  }));

test("session overrides win and promotion collisions never overwrite the agent default", () =>
  withKey(() => {
    const { sessionId, userId, agentId } = createSession();
    writeAgentSecret(userId, agentId, "GITHUB_TOKEN", "default-token");
    const local = storeSessionSecret(userId, sessionId, "GITHUB_TOKEN", "temporary-account");
    assert.deepEqual(readAgentSecretEnv(agentId, sessionId), [
      { name: "GITHUB_TOKEN", value: "temporary-account" },
    ]);
    assert.throws(() => promoteSessionSecret(userId, sessionId, local.id), /not overwritten/);
    assert.deepEqual(readAgentSecretEnv(agentId), [
      { name: "GITHUB_TOKEN", value: "default-token" },
    ]);
    revokeSessionSecret(userId, sessionId, local.id);
    assert.deepEqual(readAgentSecretEnv(agentId, sessionId), [
      { name: "GITHUB_TOKEN", value: "default-token" },
    ]);
  }));

test("shared agent runners can keep private session credentials but cannot promote", () =>
  withKey(() => {
    const { sessionId, userId, agentId } = createSession();
    const otherUserId = createUser();
    db.update(agents).set({ shared: true }).where(eq(agents.id, agentId)).run();
    const otherSession = sibling(sessionId);
    db.update(sessions).set({ userId: otherUserId }).where(eq(sessions.id, otherSession)).run();
    const local = storeSessionSecret(
      otherUserId,
      otherSession,
      "GITHUB_TOKEN",
      "other-private-token",
    );
    assert.throws(() => promoteSessionSecret(otherUserId, otherSession, local.id), /owner-only/);
    assert.deepEqual(readSessionSecrets(userId, sessionId), []);
    assert.deepEqual(readAgentSecretEnv(agentId, sessionId), []);
    assert.throws(
      () => readAgentSecretEnv(createSession().agentId, otherSession),
      /Session not found/,
    );
  }));

test("new credentials fail closed without encryption and never trust an encryption-looking prefix", () => {
  const { sessionId, userId } = createSession();
  const request = secretRequest(sessionId);
  const previous = process.env.CARMEL_SECRET_KEY;
  delete process.env.CARMEL_SECRET_KEY;
  try {
    assert.throws(
      () => answerSecretRequest(userId, sessionId, request.id, "enc:v1:plaintext"),
      /CARMEL_SECRET_KEY/,
    );
    assert.equal(readUserRequests(sessionId)[0]?.status, "pending");
  } finally {
    if (previous !== undefined) process.env.CARMEL_SECRET_KEY = previous;
  }
  withKey(() => {
    const answered = answerSecretRequest(userId, sessionId, request.id, "enc:v1:plaintext");
    const row = db
      .select()
      .from(agentSecrets)
      .where(eq(agentSecrets.id, answered.credential!.id))
      .get()!;
    assert.equal(revealSecret(row.value), "enc:v1:plaintext");
  });
});
