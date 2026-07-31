import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, migrate } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { createSession } from "../test-support.ts";
import { commitSessionRunState, commitSessionRunTitle } from "./agent-runtime.ts";

migrate();

test("run finalization compare-and-swap cannot overwrite a newer session revision", () => {
  const fixture = createSession();
  db.update(sessions)
    .set({ title: "newer mutation", revision: 1 })
    .where(eq(sessions.id, fixture.sessionId))
    .run();

  const committed = commitSessionRunState(fixture.sessionId, 0, {
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    updatedAt: 123,
  });

  assert.equal(committed, undefined);
  const stored = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get();
  assert.equal(stored?.title, "newer mutation");
  assert.equal(stored?.revision, 1);
  assert.notEqual(stored?.updatedAt, 123);
});

test("run state and generated title commits advance the leased revision", () => {
  const fixture = createSession();

  const runRevision = commitSessionRunState(fixture.sessionId, 0, {
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    updatedAt: 123,
  });
  assert.equal(runRevision, 1);
  assert.equal(commitSessionRunTitle(fixture.sessionId, 0, "stale title"), undefined);
  assert.equal(commitSessionRunTitle(fixture.sessionId, runRevision!, "generated title"), 2);

  const stored = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get();
  assert.equal(stored?.title, "generated title");
  assert.equal(stored?.revision, 2);
});
