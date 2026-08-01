import test from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { eq } from "drizzle-orm";
import { db, migrate, sqlite } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { createSession, userMessage } from "../test-support.ts";
import { prepareAgentRunPrompt, runHarnessPrompt } from "../runtime/agent-runtime.ts";
import { closePiSession, deletePiSession, openPiSession } from "./pi-session-storage.ts";
import {
  editSessionMessageEntry,
  loadSession,
  readSessionMessageAt,
  readSessionMessages,
  replaceSessionMessages,
  truncateSessionAtEntry,
} from "./session-store.ts";

migrate();

const contents = async (sessionId: string) =>
  (await readSessionMessages(sessionId)).map((message) => (message as { content: string }).content);

test("Carmel metadata database has no session-content tables", () => {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?) ORDER BY name")
    .all("table", "pi_session_entries", "session_messages");
  assert.deepEqual(tables, []);
});


test("replace then read preserves message order and exposes native entry IDs", async () => {
  const { sessionId } = createSession();
  await replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  assert.deepEqual(await contents(sessionId), ["a", "b", "c"]);
  const loaded = await loadSession(sessionId);
  assert.equal(loaded?.messageEntryIds.length, 3);
  assert.equal(new Set(loaded?.messageEntryIds).size, 3);
});

test("replacing a transcript moves the native leaf but retains the abandoned branch", async () => {
  const { sessionId } = createSession();
  await replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  await replaceSessionMessages(sessionId, [userMessage("a")]);

  assert.deepEqual(await contents(sessionId), ["a"]);
  const session = await openPiSession(sessionId);
  try {
    assert.equal((await session.getStorage().findEntries("message")).length, 4);
  } finally {
    await closePiSession(session);
  }
});

test("Pi native SQLite storage persists entries and materialized context", async () => {
  const { sessionId } = createSession();
  const session = await openPiSession(sessionId);
  try {
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
  } finally {
    await closePiSession(session);
  }
});

test("AgentHarness persists a complete turn directly into Pi SQLite", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-sqlite-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("persisted reply")]);
  const session = await openPiSession(sessionId);
  const harness = new AgentHarness({ session, models, model: faux.getModel(), systemPrompt: "Test assistant" });

  try {
    await harness.prompt("hello");
  } finally {
    await closePiSession(session);
  }

  const messages = await readSessionMessages(sessionId);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal((messages[1] as { content: Array<{ type: string; text: string }> }).content[0]?.text, "persisted reply");
});

test("retrying a stored user entry does not persist an empty message", async () => {
  const { sessionId } = createSession();
  await replaceSessionMessages(sessionId, [
    userMessage("first question"),
    fauxAssistantMessage("first reply"),
    userMessage("retry this question"),
  ]);
  const piSession = await openPiSession(sessionId);
  const faux = fauxProvider({ provider: `faux-retry-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("retried reply")]);
  try {
    const prepared = await prepareAgentRunPrompt(piSession);
    const harness = new AgentHarness({ session: piSession, models, model: faux.getModel(), systemPrompt: "Test assistant" });
    await runHarnessPrompt(harness, prepared.promptInput.text, prepared.promptInput.images);
  } finally {
    await closePiSession(piSession);
  }

  const messages = await readSessionMessages(sessionId);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(
    messages.filter((message) => message.role === "user").map((message) => userMessageText(message)),
    ["first question", "retry this question"],
  );
});

test("native harness commands expand file prompts and skills", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-commands-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
  const session = await openPiSession(sessionId);
  const harness = new AgentHarness({
    session,
    models,
    model: faux.getModel(),
    resources: {
      promptTemplates: [{ name: "review", content: "Review $1" }],
      skills: [{ name: "inspect", description: "Inspect carefully", content: "Inspect the target carefully.", filePath: "/skills/inspect/SKILL.md" }],
    },
  });
  try {
    await runHarnessPrompt(harness, '/review "some file"');
    await runHarnessPrompt(harness, "/skill:inspect focus on safety");
  } finally {
    await closePiSession(session);
  }

  const userMessages = (await readSessionMessages(sessionId)).filter((message) => message.role === "user");
  assert.equal(userMessageText(userMessages[0]), "Review some file");
  assert.match(userMessageText(userMessages[1]), /<skill name="inspect"/);
  assert.match(userMessageText(userMessages[1]), /focus on safety/);
});

test("entry-ID leaf navigation retains the abandoned branch", async () => {
  const { sessionId } = createSession();
  await replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  const loaded = await loadSession(sessionId);
  assert.ok(loaded);
  await truncateSessionAtEntry(sessionId, loaded.messageEntryIds[0]!);

  const session = await openPiSession(sessionId);
  try {
    await session.appendMessage(userMessage("d"));
    assert.equal((await session.getStorage().findEntries("message")).length, 4);
  } finally {
    await closePiSession(session);
  }
  assert.deepEqual(await contents(sessionId), ["a", "d"]);
});

test("non-truncating entry edit preserves native configuration entries in the suffix", async () => {
  const { sessionId } = createSession();
  const session = await openPiSession(sessionId);
  let firstId: string;
  try {
    firstId = await session.appendMessage(userMessage("a"));
    await session.appendThinkingLevelChange("high");
    await session.appendMessage(userMessage("b"));
  } finally {
    await closePiSession(session);
  }

  await editSessionMessageEntry(sessionId, firstId!, userMessage("edited"), false);
  const edited = await openPiSession(sessionId);
  try {
    const context = await edited.buildContext();
    assert.equal(context.thinkingLevel, "high");
    assert.deepEqual(context.messages.map((message) => userMessageText(message as { content?: unknown })), ["edited", "b"]);
  } finally {
    await closePiSession(edited);
  }
});


test("loadSession and display-index reads expose the active native branch", async () => {
  const { sessionId, userId } = createSession();
  await replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  const session = await loadSession(sessionId);
  assert.ok(session);
  assert.equal(session.userId, userId);
  assert.equal(session.messages.length, 3);
  assert.equal((await readSessionMessageAt(sessionId, 1) as { content: string }).content, "b");
  assert.equal(await readSessionMessageAt(sessionId, 3), undefined);
  assert.equal(await loadSession("missing"), undefined);
});

test("deleting a session removes native storage", async () => {
  const { sessionId } = createSession();
  await replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b")]);
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  assert.ok(record);
  await deletePiSession(record);
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();

  await assert.rejects(() => openPiSession(sessionId), /not found/i);
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
