import test from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { eq } from "drizzle-orm";
import { db, initialize, sqlite } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { createSession, userMessage } from "../test-support.ts";
import { prepareAgentRunPrompt, runHarnessPrompt } from "../runtime/agent-runtime.ts";
import {
  closePiSession,
  deletePiSession,
  movePiSessionToEntry,
  openPiSession,
  readPiSessionMessageEntry,
  replacePiSessionMessages,
  rewritePiSessionMessage,
} from "./pi-session-storage.ts";
import { attachTestHarness, fauxHarnessModels, TEST_CONTEXT } from "../effectors/testing/pi-harness.ts";
import { loadSession, readSessionMessages } from "./session-store.ts";
import { loadBuiltinSkills } from "../runtime/builtin-skills.ts";

initialize();

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
  await replacePiSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  assert.deepEqual(await contents(sessionId), ["a", "b", "c"]);
  const loaded = await loadSession(sessionId);
  assert.equal(loaded?.messageEntryIds.length, 3);
  assert.equal(new Set(loaded?.messageEntryIds).size, 3);
});

test("replacing a transcript moves the native leaf but retains the abandoned branch", async () => {
  const { sessionId } = createSession();
  await replacePiSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  await replacePiSessionMessages(sessionId, [userMessage("a")]);

  assert.deepEqual(await contents(sessionId), ["a"]);
  const session = await openPiSession(sessionId);
  try {
    // Counts every message entry in the session, abandoned branches included.
    assert.equal((await session.findEntries({ type: "message" }, TEST_CONTEXT)).length, 4);
  } finally {
    await closePiSession(session);
  }
});

test("Pi native SQLite storage persists entries and lane configuration", async () => {
  const { sessionId } = createSession();
  const pi = await attachTestHarness(await openPiSession(sessionId), fauxHarnessModels());
  try {
    await pi.log.appendMessage(userMessage("a"));
    await pi.lane.setThinkingLevel("high", pi.context);
    await pi.log.appendMessage(userMessage("b"));

    const messages = (await pi.branch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    assert.deepEqual(
      messages.map((message) => (message as { content: string }).content),
      ["a", "b"],
    );
    assert.equal(await pi.lane.getThinkingLevel(pi.context), "high");
    assert.equal(pi.session.metadata.id, sessionId);
  } finally {
    await pi.close();
  }
});

test("AgentHarness persists a complete turn directly into Pi SQLite", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-sqlite-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("persisted reply")]);
  const pi = await attachTestHarness(await openPiSession(sessionId), {
    models,
    model: faux.getModel(),
    systemPrompt: "Test assistant",
  });

  try {
    await pi.lane.prompt("hello", undefined, pi.context);
  } finally {
    await pi.close();
  }

  const messages = await readSessionMessages(sessionId);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal((messages[1] as { content: Array<{ type: string; text: string }> }).content[0]?.text, "persisted reply");
});

test("retrying a stored user entry does not persist an empty message", async () => {
  const { sessionId } = createSession();
  await replacePiSessionMessages(sessionId, [
    userMessage("first question"),
    fauxAssistantMessage("first reply"),
    userMessage("retry this question"),
  ]);
  const piSession = await openPiSession(sessionId);
  const faux = fauxProvider({ provider: `faux-retry-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("retried reply")]);
  const pi = await attachTestHarness(piSession, { models, model: faux.getModel(), systemPrompt: "Test assistant" });
  try {
    const prepared = await prepareAgentRunPrompt(pi.log);
    await runHarnessPrompt(pi, prepared.promptInput.text, prepared.promptInput.images);
  } finally {
    await pi.close();
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
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("third")]);
  const builtins = await loadBuiltinSkills({ permissions: { read: false, write: false, edit: false, bash: true, network: true } });
  const pi = await attachTestHarness(await openPiSession(sessionId), {
    models,
    model: faux.getModel(),
    resources: {
      promptTemplates: [{ name: "review", content: "Review $1" }],
      skills: [{ name: "inspect", description: "Inspect carefully", content: "Inspect the target carefully.", filePath: "/skills/inspect/SKILL.md" }, ...builtins],
    },
  });
  try {
    await runHarnessPrompt(pi, '/review "some file"');
    await runHarnessPrompt(pi, "/skill:inspect focus on safety");
    await runHarnessPrompt(pi, "/skill:agent-browser help me sign in");
  } finally {
    await pi.close();
  }

  const userMessages = (await readSessionMessages(sessionId)).filter((message) => message.role === "user");
  assert.equal(userMessageText(userMessages[0]), "Review some file");
  assert.match(userMessageText(userMessages[1]), /<skill name="inspect"/);
  assert.match(userMessageText(userMessages[1]), /focus on safety/);
  assert.ok(userMessageText(userMessages[2]).includes(builtins[0]!.content));
  assert.match(userMessageText(userMessages[2]), /help me sign in/);
});

test("entry-ID leaf navigation retains the abandoned branch", async () => {
  const { sessionId } = createSession();
  await replacePiSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  const loaded = await loadSession(sessionId);
  assert.ok(loaded);
  await movePiSessionToEntry(sessionId, loaded.messageEntryIds[0]!);

  const pi = await attachTestHarness(await openPiSession(sessionId), fauxHarnessModels());
  try {
    await pi.log.appendMessage(userMessage("d"));
    assert.equal((await pi.session.findEntries({ type: "message" }, TEST_CONTEXT)).length, 4);
  } finally {
    await pi.close();
  }
  assert.deepEqual(await contents(sessionId), ["a", "d"]);
});

test("non-truncating entry edit preserves the message suffix and lane configuration", async () => {
  const { sessionId } = createSession();
  const pi = await attachTestHarness(await openPiSession(sessionId), fauxHarnessModels());
  let firstId: string;
  try {
    firstId = await pi.log.appendMessage(userMessage("a"));
    await pi.lane.setThinkingLevel("high", pi.context);
    await pi.log.appendMessage(userMessage("b"));
  } finally {
    await pi.close();
  }

  await rewritePiSessionMessage(sessionId, firstId!, userMessage("edited"), false);

  const edited = await attachTestHarness(await openPiSession(sessionId), fauxHarnessModels());
  try {
    assert.equal(await edited.lane.getThinkingLevel(edited.context), "high");
    const messages = (await edited.branch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    assert.deepEqual(messages.map((message) => userMessageText(message as { content?: unknown })), ["edited", "b"]);
  } finally {
    await edited.close();
  }
});

test("loadSession and entry reads expose the active native branch", async () => {
  const { sessionId, userId } = createSession();
  await replacePiSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  const session = await loadSession(sessionId);
  assert.ok(session);
  assert.equal(session.userId, userId);
  assert.equal(session.messages.length, 3);
  const secondEntryId = session.messageEntryIds[1]!;
  assert.equal((await readPiSessionMessageEntry(sessionId, secondEntryId) as { content: string }).content, "b");
  assert.equal(await readPiSessionMessageEntry(sessionId, "missing-entry"), undefined);
  assert.equal(await loadSession("missing"), undefined);
});

test("deleting a session removes native storage", async () => {
  const { sessionId } = createSession();
  await replacePiSessionMessages(sessionId, [userMessage("a"), userMessage("b")]);
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

test("Pi storage provisions an empty session on first open", async () => {
  const { sessionId } = createSession();
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  assert.ok(record);

  // Deleting storage that was never created is tolerated, not an error.
  await deletePiSession(record);

  // Opening provisions it on first use rather than failing.
  const session = await openPiSession(sessionId);
  try {
    assert.equal(session.metadata.id, sessionId);
  } finally {
    await closePiSession(session);
  }
});
