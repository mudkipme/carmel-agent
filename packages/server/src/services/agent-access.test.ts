import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, migrate } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { createAgent, createModelRef, createProviderConfig, createSession, createUser } from "../test-support.ts";
import {
  canUseModel,
  reassignModelReferences,
  readVisibleAgent,
  readVisibleAgents,
  readVisibleModelRefs,
} from "./agent-access.ts";

migrate();

test("readVisibleAgents returns own and shared agents but not other users' private ones", () => {
  const alice = createUser();
  const bob = createUser();
  const model = createModelRef({ ownerUserId: alice });
  const aliceAgent = createAgent({ ownerUserId: alice, defaultModelRefId: model });
  const bobPrivate = createAgent({ ownerUserId: bob, defaultModelRefId: model });
  const bobShared = createAgent({ ownerUserId: bob, shared: true, defaultModelRefId: model });

  const visible = new Set(readVisibleAgents(alice).map((agent) => agent.id));
  assert.ok(visible.has(aliceAgent));
  assert.ok(visible.has(bobShared));
  assert.ok(!visible.has(bobPrivate));
});

test("readVisibleAgent hides another user's private agent but allows shared/own", () => {
  const alice = createUser();
  const bob = createUser();
  const model = createModelRef({ ownerUserId: alice });
  const bobPrivate = createAgent({ ownerUserId: bob, defaultModelRefId: model });
  const bobShared = createAgent({ ownerUserId: bob, shared: true, defaultModelRefId: model });

  assert.equal(readVisibleAgent(alice, bobPrivate), undefined);
  assert.ok(readVisibleAgent(alice, bobShared));
  assert.ok(readVisibleAgent(bob, bobPrivate));
});

test("readVisibleModelRefs includes own, shared, and config-less models (providers are global)", () => {
  const alice = createUser();
  const bob = createUser();
  const aliceConfig = createProviderConfig(alice);
  const bobConfig = createProviderConfig(bob);

  const ownModel = createModelRef({ ownerUserId: alice, providerConfigId: aliceConfig });
  const sharedModel = createModelRef({ ownerUserId: bob, shared: true });
  const configlessModel = createModelRef({ ownerUserId: bob }); // no provider config -> globally visible
  const bobPrivateModel = createModelRef({ ownerUserId: bob, providerConfigId: bobConfig });

  const visible = new Set(readVisibleModelRefs(alice).map((model) => model.id));
  assert.ok(visible.has(ownModel));
  assert.ok(visible.has(sharedModel));
  assert.ok(visible.has(configlessModel));
  // A config-bound model owned by someone else is private regardless of which config it uses.
  assert.ok(!visible.has(bobPrivateModel));
});

test("canUseModel enforces ownership/sharing", () => {
  const alice = createUser();
  const bob = createUser();
  const bobConfig = createProviderConfig(bob);
  const bobPrivateModel = createModelRef({ ownerUserId: bob, providerConfigId: bobConfig });
  const sharedModel = createModelRef({ ownerUserId: bob, shared: true });

  assert.equal(canUseModel(alice, bobPrivateModel), false);
  assert.equal(canUseModel(alice, sharedModel), true);
  assert.equal(canUseModel(bob, bobPrivateModel), true);
});

test("reassignModelReferences swaps a session's model without touching its update time", () => {
  const { sessionId, userId, modelRefId } = createSession();
  createModelRef({ ownerUserId: userId }); // guarantees a fallback exists
  // Backdate the session so a bumped updatedAt would be unmistakable.
  const updatedAt = 1_000;
  db.update(sessions).set({ updatedAt }).where(eq(sessions.id, sessionId)).run();

  reassignModelReferences(new Set([modelRefId]));

  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  assert.notEqual(session?.modelRefId, modelRefId);
  // The sidebar sorts by updatedAt, so deleting a model must not float every
  // session that used it to the top of the list.
  assert.equal(session?.updatedAt, updatedAt);
});
