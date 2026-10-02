/** Isolated browser-test fixture. Never starts the production bootstrap or schedulers. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = await mkdtemp(join(tmpdir(), "carmel-browser-tests-"));
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_AGENT_DATA_DIR = stateDir;
process.env.CARMEL_PODMAN_SOCKET = join(stateDir, "no-container-socket");
process.env.CLIENT_DIST_DIR = new URL(
  "../../client/dist/",
  import.meta.url,
).pathname;

const { serve } = await import("@hono/node-server");
const { eq } = await import("drizzle-orm");
const { createApp } = await import("../src/app.ts");
const { db, migrate } = await import("../src/db/index.ts");
const {
  agents,
  agentTasks,
  agentTaskRuns,
  issues,
  issueAttempts,
  sessions,
  users,
} = await import("../src/db/schema.ts");
const { createAgent, createSession } = await import("../src/test-support.ts");
const { hashPassword } = await import("../src/auth.ts");
const { attachBrowserSocket } = await import("../src/browser-socket.ts");
const { browserControl } = await import("../src/runtime/browser-control.ts");
const { createIssue, stopIssueQueue } = await import(
  "../src/services/issues.ts"
);
stopIssueQueue();
migrate();
const fixture = createSession();
const secondAgentId = createAgent({
  ownerUserId: fixture.userId,
  defaultModelRefId: fixture.modelRefId,
});
db.update(users)
  .set({
    username: "browser-test",
    passwordHash: await hashPassword("browser-test-password"),
    email: "browser@example.test",
    role: "admin",
  })
  .where(eq(users.id, fixture.userId))
  .run();
db.update(agents)
  .set({ name: "Browser test agent", workingDir: stateDir, permissions: { read: true, write: true, edit: true, bash: true, network: false } })
  .where(eq(agents.id, fixture.agentId))
  .run();
db.update(agents)
  .set({ name: "Second agent", workingDir: stateDir })
  .where(eq(agents.id, secondAgentId))
  .run();
const timestamp = Date.now();
const previousSessionId = "browser-previous-session";
db.insert(sessions)
  .values({
    id: previousSessionId,
    title: "Previous issue conversation",
    userId: fixture.userId,
    agentId: fixture.agentId,
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .run();
const reviewIssue = createIssue(fixture.userId, fixture.agentId, {
  title: "Review the deployment guide",
  description: "Check the setup instructions.",
  criteria: [],
  priority: "normal",
});
const backlogIssue = createIssue(fixture.userId, fixture.agentId, {
  title: "Explain backups",
  description: "For later.",
  criteria: [],
  priority: "normal",
});
db.update(issues)
  .set({ sessionId: fixture.sessionId, status: "in_review" })
  .where(eq(issues.id, reviewIssue.id))
  .run();
db.update(sessions)
  .set({ issueId: reviewIssue.id })
  .where(eq(sessions.id, fixture.sessionId))
  .run();
db.update(sessions)
  .set({ issueId: reviewIssue.id })
  .where(eq(sessions.id, previousSessionId))
  .run();
for (const [id, sessionId, createdAt] of [
  ["browser-current-attempt", fixture.sessionId, timestamp],
  ["browser-previous-attempt", previousSessionId, timestamp - 10_000],
] as const) {
  db.insert(issueAttempts)
    .values({
      id,
      issueId: reviewIssue.id,
      sessionId,
      instructions: "",
      brief: "Check the guide.",
      outcome: "succeeded",
      summary: "Ready for review.",
      createdAt,
      finishedAt: createdAt + 1_000,
    })
    .run();
}
const taskName =
  "Review the deployment guide and keep this deliberately long task title and all its controls usable on a narrow mobile screen";
db.insert(agentTasks)
  .values({
    id: "browser-task",
    agentId: fixture.agentId,
    userId: fixture.userId,
    name: taskName,
    prompt: "Review the guide.",
    scheduleKind: "interval",
    scheduleValue: "86400000",
    status: "paused",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .run();
const taskSessionId = "browser-task-session";
db.insert(sessions)
  .values({
    id: taskSessionId,
    title: taskName,
    userId: fixture.userId,
    agentId: fixture.agentId,
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    taskId: "browser-task",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .run();
db.insert(agentTaskRuns)
  .values({
    id: "browser-task-run",
    taskId: "browser-task",
    scheduledFor: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp + 1_000,
    outcome: "succeeded",
    sessionId: taskSessionId,
  })
  .run();
const server = serve(
  { fetch: createApp().fetch, port: 0, hostname: "127.0.0.1" },
  (address) => {
    console.log(
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        agentId: fixture.agentId,
        secondAgentId,
        reviewIssueId: reviewIssue.id,
        backlogIssueId: backlogIssue.id,
        previousSessionId,
        taskSessionId,
        taskName,
      }),
    );
  },
);
// A deterministic stream fixture exercises the real gateway and handoff state without a container.
const browserSockets = attachBrowserSocket(server as unknown as import("node:http").Server, async (_agent, onMessage) => {
  const frame = (seq: number) => onMessage({ type: "frame", seq, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
  let acknowledged = 0;
  queueMicrotask(() => {
    onMessage({ type: "ready" });
    onMessage({ type: "url", url: "https://example.test/login" });
    frame(1);
  });
  return { send: (message) => {
    const command = message as { type: string; id: number; args: string[]; seq: number };
    if (command.type === "ack" && command.seq > acknowledged) {
      acknowledged = command.seq;
      if (acknowledged === 1) frame(2); // Identical pixels still require a new acknowledgement.
      if (acknowledged === 2) onMessage({ type: "url", url: "https://example.test/login?stream=live" });
    }
    if (command.type === "command") {
      if (command.args[0] === "open") onMessage({ type: "url", url: command.args[1]! });
      onMessage({ type: "command_done", id: command.id });
    }
  }, close: () => {} };
});
void browserControl(fixture.agentId).requestHelp("Please sign in to the billing portal.");
const stop = () =>
  { for (const client of browserSockets.clients) client.terminate(); browserSockets.close(); server.close(
    () =>
      void rm(stateDir, { recursive: true, force: true }).finally(() =>
        process.exit(0),
      ),
  ); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
