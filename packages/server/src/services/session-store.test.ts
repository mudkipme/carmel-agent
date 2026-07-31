import test from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { eq } from "drizzle-orm";
import { db, migrate, migrateFlatTranscriptsToPiSessionEntries } from "../db/index.ts";
import { piSessionEntries, sessionMessages, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createSession, userMessage } from "../test-support.ts";
import { runHarnessPrompt } from "../runtime/agent-runtime.ts";
import { openPiSession, SqliteSessionStorage } from "./pi-session-storage.ts";
import {
  loadSession,
  readSessionMessageAt,
  readSessionMessageCountsForUser,
  readSessionMessages,
  replaceSessionMessages,
} from "./session-store.ts";

migrate();

const contents = (sessionId: string) =>
  readSessionMessages(sessionId).map((message) => (message as { content: string }).content);

test("replace then read preserves message order", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  assert.deepEqual(contents(sessionId), ["a", "b", "c"]);
});

test("replacing a transcript moves the active leaf but retains the previous Pi branch", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  replaceSessionMessages(sessionId, [userMessage("a")]);

  assert.deepEqual(contents(sessionId), ["a"]);
  const stored = db.select().from(piSessionEntries).where(eq(piSessionEntries.sessionId, sessionId)).all();
  assert.equal(stored.filter((row) => row.entryType === "message").length, 4);
});

test("SQLite SessionStorage persists native Pi entries and context", async () => {
  const { sessionId } = createSession();
  const session = openPiSession(sessionId);
  await session.appendMessage(userMessage("a"));
  await session.appendThinkingLevelChange("high");
  await session.appendMessage(userMessage("b"));

  const context = await session.buildContext();
  assert.deepEqual(
    context.messages.map((message) => (message as { content: string }).content),
    ["a", "b"],
  );
  assert.equal(context.thinkingLevel, "high");
  assert.equal((await session.getStorage().getMetadata()).id, sessionId);
});

test("AgentHarness persists a complete turn directly into SQLite", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-sqlite-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("persisted reply")]);
  const harness = new AgentHarness({
    session: openPiSession(sessionId),
    models,
    model: faux.getModel(),
    systemPrompt: "Test assistant",
  });

  await harness.prompt("hello");

  const messages = readSessionMessages(sessionId);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal((messages[1] as { content: Array<{ type: string; text: string }> }).content[0]?.text, "persisted reply");
});

test("native harness commands expand file prompts and skills", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-commands-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
  const harness = new AgentHarness({
    session: openPiSession(sessionId),
    models,
    model: faux.getModel(),
    resources: {
      promptTemplates: [{ name: "review", content: "Review $1" }],
      skills: [
        {
          name: "inspect",
          description: "Inspect carefully",
          content: "Inspect the target carefully.",
          filePath: "/skills/inspect/SKILL.md",
        },
      ],
    },
  });

  await runHarnessPrompt(harness, '/review "some file"');
  await runHarnessPrompt(harness, "/skill:inspect focus on safety");

  const userMessages = readSessionMessages(sessionId).filter((message) => message.role === "user");
  assert.equal(userMessageText(userMessages[0]), "Review some file");
  assert.match(userMessageText(userMessages[1]), /<skill name="inspect"/);
  assert.match(userMessageText(userMessages[1]), /focus on safety/);
});

test("setLeafId navigates without deleting the abandoned branch", async () => {
  const { sessionId } = createSession();
  const storage = new SqliteSessionStorage(sessionId);
  const session = openPiSession(sessionId);
  const firstId = await session.appendMessage(userMessage("a"));
  await session.appendMessage(userMessage("b"));
  await storage.setLeafId(firstId);
  await session.appendMessage(userMessage("c"));

  assert.deepEqual(contents(sessionId), ["a", "c"]);
  assert.equal((await storage.findEntries("message")).length, 3);
});

test("legacy flat transcripts migrate losslessly and idempotently", () => {
  const { sessionId } = createSession();
  const timestamp = now();
  db.insert(sessionMessages)
    .values([
      { id: id("legacy_message"), sessionId, seq: 0, message: userMessage("a"), createdAt: timestamp },
      { id: id("legacy_message"), sessionId, seq: 2, message: userMessage("b"), createdAt: timestamp + 1 },
    ])
    .run();

  migrateFlatTranscriptsToPiSessionEntries();
  assert.deepEqual(contents(sessionId), ["a", "b"]);
  const firstCount = db.select().from(piSessionEntries).where(eq(piSessionEntries.sessionId, sessionId)).all().length;
  migrateFlatTranscriptsToPiSessionEntries();
  const secondCount = db.select().from(piSessionEntries).where(eq(piSessionEntries.sessionId, sessionId)).all().length;
  assert.equal(firstCount, 2);
  assert.equal(secondCount, firstCount);
});

test("loadSession returns the record with its active-branch messages", () => {
  const { sessionId, userId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("hi")]);
  const session = loadSession(sessionId);
  assert.ok(session);
  assert.equal(session.userId, userId);
  assert.equal(session.messages.length, 1);
  assert.equal(loadSession("missing"), undefined);
});

test("readSessionMessageAt addresses the active branch by display index", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  assert.equal((readSessionMessageAt(sessionId, 1) as { content: string }).content, "b");
  assert.equal(readSessionMessageAt(sessionId, 3), undefined);
  assert.equal(readSessionMessageAt(sessionId, -1), undefined);
});

test("message counts are reported from each session's active Pi branch", () => {
  const { sessionId, userId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b")]);
  const counts = readSessionMessageCountsForUser(userId);
  assert.equal(counts.get(sessionId), 2);
});

test("deleting a session cascades to native and legacy entries", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b")]);
  db.insert(sessionMessages)
    .values({ id: id("legacy_message"), sessionId, seq: 0, message: userMessage("old"), createdAt: now() })
    .run();
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();

  assert.equal(readSessionMessages(sessionId).length, 0);
  assert.equal(db.select().from(piSessionEntries).where(eq(piSessionEntries.sessionId, sessionId)).all().length, 0);
  assert.equal(db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).all().length, 0);
});

function userMessageText(message: { content?: unknown } | undefined) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part),
    )
    .map((part) => part.text)
    .join("\n");
}
