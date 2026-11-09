import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { homeEvents, users } from "../db/schema.ts";
import { ensureHome } from "../services/agent-homes.ts";
import { createSession } from "../test-support.ts";
import { createHomeRoutes } from "./agent-homes.ts";

initialize();

function createTestApp(userId: string) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createHomeRoutes());
  return app;
}

function insertHomeEvent(
  sessionId: string,
  event: {
    id: string;
    status: "failed" | "done";
    createdAt: number;
    finishedAt?: number;
    error?: string;
  },
) {
  db.insert(homeEvents)
    .values({
      id: event.id,
      sessionId,
      sourceKey: `${sessionId}:${event.id}`,
      kind: "input",
      origin: "web",
      prompt: { text: "test" },
      status: event.status,
      error: event.error,
      createdAt: event.createdAt,
      finishedAt: event.finishedAt ?? event.createdAt,
    })
    .run();
}

test("a later successful reply clears an older Home failure", async () => {
  const fixture = createSession();
  const home = ensureHome(fixture.userId, fixture.agentId);
  const app = createTestApp(fixture.userId);
  insertHomeEvent(home.sessionId, {
    id: "home_event_failure",
    status: "failed",
    createdAt: 1,
    error: "The model provider failed to answer.",
  });

  const failed = (await (await app.request(`/agents/${fixture.agentId}/home`)).json()) as {
    events: Array<{ id: string; error?: string }>;
  };
  assert.equal(failed.events[0]?.error, "The model provider failed to answer.");

  insertHomeEvent(home.sessionId, { id: "home_event_success", status: "done", createdAt: 2 });
  const recovered = (await (await app.request(`/agents/${fixture.agentId}/home`)).json()) as {
    events: Array<{ id: string; error?: string }>;
  };
  assert.equal(recovered.events[0]?.id, "home_event_failure");
  assert.equal(recovered.events[0]?.error, undefined);
});

test("an older reply that fails last is still the current failure", async () => {
  const fixture = createSession();
  const home = ensureHome(fixture.userId, fixture.agentId);
  const app = createTestApp(fixture.userId);
  insertHomeEvent(home.sessionId, {
    id: "home_event_slow_failure",
    status: "failed",
    createdAt: 1,
    finishedAt: 10,
    error: "The slow reply failed.",
  });
  insertHomeEvent(home.sessionId, {
    id: "home_event_fast_success",
    status: "done",
    createdAt: 2,
    finishedAt: 3,
  });

  const status = (await (await app.request(`/agents/${fixture.agentId}/home`)).json()) as {
    events: Array<{ id: string; error?: string }>;
  };
  assert.equal(
    status.events.find((event) => event.id === "home_event_slow_failure")?.error,
    "The slow reply failed.",
  );
});

test("dismissing a Home failure keeps it hidden", async () => {
  const fixture = createSession();
  const home = ensureHome(fixture.userId, fixture.agentId);
  const app = createTestApp(fixture.userId);
  insertHomeEvent(home.sessionId, {
    id: "home_event_dismissed",
    status: "failed",
    createdAt: 1,
    error: "The model provider failed to answer.",
  });

  const dismissed = await app.request(
    `/agents/${fixture.agentId}/home/events/home_event_dismissed/dismiss`,
    { method: "POST" },
  );
  assert.equal(dismissed.status, 200);

  const status = (await (await app.request(`/agents/${fixture.agentId}/home`)).json()) as {
    events: Array<{ id: string; error?: string }>;
  };
  assert.equal(status.events[0]?.error, undefined);
  assert.ok(
    db.select().from(homeEvents).where(eq(homeEvents.id, "home_event_dismissed")).get()
      ?.errorDismissedAt,
  );
});
