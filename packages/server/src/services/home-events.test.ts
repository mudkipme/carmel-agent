import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  openTestHarness,
  fauxHarnessModels,
  TEST_CONTEXT,
} from "../effectors/testing/pi-harness.ts";
import { recoverHomeEvents } from "./home-events.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agentHomes, homeEvents, sessions } from "../db/schema.ts";
import { imBindings, imIntegrations } from "../db/im-schema.ts";
import { createSession } from "../test-support.ts";
import { ensureHome, resetHome } from "./agent-homes.ts";
import { admitHomeInput, queuedHomeInputs, stopHome } from "./home-events.ts";
import { receiveImMessage } from "../runtime/im-manager.ts";
import { publishHomeEvent, dispatchHome } from "./home-events.ts";
import { readSessionSnapshot } from "./session-snapshot.ts";

initialize();

test("stopped Home retains one passive notice per report and notifications do not wake the model", async () => {
  const fixture = createSession();
  const home = ensureHome(fixture.userId, fixture.agentId);
  await stopHome(fixture.userId, fixture.agentId);
  const report = {
    sourceKey: "issue:attempt-one",
    kind: "issue" as const,
    text: "[Review result](/result)",
    issue: {
      id: "reported-issue",
      agentId: fixture.agentId,
      title: "Review result",
      status: "needs_input" as const,
    },
  };
  publishHomeEvent(fixture.userId, fixture.agentId, report);
  publishHomeEvent(fixture.userId, fixture.agentId, report);
  await dispatchHome(home.sessionId);
  const first = db
    .select()
    .from(agentHomes)
    .where(eq(agentHomes.sessionId, home.sessionId))
    .get()!.updatedAt;
  await dispatchHome(home.sessionId);
  assert.equal(
    db.select().from(agentHomes).where(eq(agentHomes.sessionId, home.sessionId)).get()!.updatedAt,
    first,
  );
  const snapshot = (await readSessionSnapshot(fixture.userId, home.sessionId))!;
  const notices = snapshot.messages.filter((message) => message.role === "homeNotice");
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0]?.issue, report.issue);
  assert.equal(
    db.select().from(homeEvents).where(eq(homeEvents.sessionId, home.sessionId)).get()!.status,
    "queued",
  );
  const other = createSession();
  const note = publishHomeEvent(other.userId, other.agentId, {
    sourceKey: "alert",
    kind: "notification",
    text: "Your conditional alert",
  })!;
  await dispatchHome(note.sessionId);
  assert.equal(
    db.select().from(homeEvents).where(eq(homeEvents.id, note.id)).get()!.status,
    "done",
  );
  assert.deepEqual(
    (await readSessionSnapshot(other.userId, note.sessionId))!.messages.map(
      (message) => message.role,
    ),
    ["homeNotice"],
  );
});

test("web and paired channels admit into one ordered Home and deduplicate source events", async () => {
  const fixture = createSession();
  const web = admitHomeInput(fixture.userId, fixture.agentId, {
    sourceKey: "web-1",
    origin: "web",
    prompt: { text: "first" },
  });
  for (const platform of ["telegram", "feishu"] as const) {
    const integrationId = crypto.randomUUID();
    db.insert(imIntegrations)
      .values({
        id: integrationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        platform,
        botId: integrationId,
        botName: platform,
        status: "connected",
        updatedAt: Date.now(),
      })
      .run();
    db.insert(imBindings).values({ integrationId, senderId: "person", chatId: "private" }).run();
    const input = {
      eventId: "same-provider-event",
      senderId: "person",
      chatId: "private",
      text: platform,
      imageKeys: [],
    };
    await receiveImMessage(integrationId, input);
    await receiveImMessage(integrationId, input);
  }
  const events = db.select().from(homeEvents).where(eq(homeEvents.sessionId, web.sessionId)).all();
  assert.equal(events.length, 3);
  assert.equal(events.filter((event) => event.integrationId).length, 2);
  assert.equal(queuedHomeInputs(web.sessionId), 3);
  await assert.rejects(resetHome(fixture.userId, fixture.agentId), /Finish or stop/);
  await stopHome(fixture.userId, fixture.agentId);
  assert.equal(queuedHomeInputs(web.sessionId), 0);
  assert.equal(
    db.select().from(agentHomes).where(eq(agentHomes.sessionId, web.sessionId)).get()!.paused,
    true,
  );
  admitHomeInput(fixture.userId, fixture.agentId, {
    sourceKey: "web-2",
    origin: "web",
    prompt: { text: "resume" },
  });
  assert.equal(
    db.select().from(agentHomes).where(eq(agentHomes.sessionId, web.sessionId)).get()!.paused,
    false,
  );
});

test("migration adopts the default integration session without merging other transcripts", () => {
  const fixture = createSession();
  const alternateId = crypto.randomUUID();
  const original = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get()!;
  db.insert(sessions)
    .values({ ...original, id: alternateId, updatedAt: original.updatedAt + 1000 })
    .run();
  for (const [platform, sessionId, preferred] of [
    ["telegram", fixture.sessionId, true],
    ["lark", alternateId, false],
  ] as const) {
    const integrationId = crypto.randomUUID();
    db.insert(imIntegrations)
      .values({
        id: integrationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        platform,
        botId: integrationId,
        botName: platform,
        notificationDefault: preferred,
        status: "connected",
        updatedAt: Date.now(),
      })
      .run();
    db.insert(imBindings)
      .values({ integrationId, senderId: "person", chatId: "private", sessionId })
      .run();
  }
  assert.equal(ensureHome(fixture.userId, fixture.agentId).sessionId, fixture.sessionId);
  assert.ok(db.select().from(sessions).where(eq(sessions.id, alternateId)).get());
});

test("the pending-input bound is shared across Home channels", () => {
  const fixture = createSession();
  for (let index = 0; index < 20; index++)
    admitHomeInput(fixture.userId, fixture.agentId, {
      sourceKey: `${index}`,
      origin: index % 2 ? "web" : "im",
      preparing: index === 0,
      prompt: { text: `${index}` },
    });
  assert.throws(
    () =>
      admitHomeInput(fixture.userId, fixture.agentId, {
        sourceKey: "overflow",
        origin: "web",
        prompt: { text: "extra" },
      }),
    /queue is full/,
  );
  const original = admitHomeInput(fixture.userId, fixture.agentId, {
    sourceKey: "0",
    origin: "im",
    prompt: { text: "retry" },
  });
  assert.equal(original.prompt.text, "0");
});

test("native request IDs reconcile a completed reply after a missed host settlement", async () => {
  const fixture = createSession();
  const event = admitHomeInput(fixture.userId, fixture.agentId, {
    sourceKey: "native-recovery",
    origin: "web",
    prompt: { text: "hello" },
  });
  const models = fauxHarnessModels();
  models.faux.setResponses([fauxAssistantMessage("saved answer")]);
  const pi = await openTestHarness(event.sessionId, models);
  try {
    await pi.harness.prompt("hello", undefined, TEST_CONTEXT, undefined, {
      requestId: `home:${event.id}`,
      source: { homeEventId: event.id, origin: "web" },
    });
    db.update(homeEvents).set({ status: "running" }).where(eq(homeEvents.id, event.id)).run();
    await recoverHomeEvents();
    const saved = db.select().from(homeEvents).where(eq(homeEvents.id, event.id)).get()!;
    assert.equal(saved.status, "done");
    assert.equal(saved.reply, "saved answer");
    await pi.harness.prompt("hello", undefined, TEST_CONTEXT, undefined, {
      requestId: `home:${event.id}`,
      source: { homeEventId: event.id, origin: "web" },
    });
    assert.equal(
      (await pi.branch()).filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length,
      1,
    );
  } finally {
    await pi.close();
  }
});
