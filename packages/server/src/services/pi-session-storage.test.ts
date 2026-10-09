import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { initialize } from "../db/index.ts";
import { createSession, userMessage } from "../test-support.ts";
import {
  EntryIndex,
  closePiSession,
  displayId,
  messageDraft,
  openPiSession,
  readPiSessionBranch,
  readPiSessionMessageEntry,
  readPiSessionTitleMessages,
  rewritePiSessionMessage,
} from "./pi-session-storage.ts";

initialize();
const ctx = BACKGROUND_CONTEXT;

test("stable public message IDs remain readable after reopen and edits give copied entries fresh IDs", async () => {
  const { sessionId } = createSession();
  const original = userMessage("Saved message");
  let session = await openPiSession(sessionId);
  try {
    await session.conversation.commit(async (tx) => {
      const first = await tx.appendEntry(session.conversation.id, {
        ...messageDraft(original),
        data: { carmelEntryId: "saved-link" },
      });
      const second = await tx.appendEntry(session.conversation.id, {
        ...messageDraft(userMessage("Suffix")),
        data: { carmelEntryId: "saved-suffix" },
      });
      const index = await tx.doc(EntryIndex);
      index[displayId(first)] = first.id;
      index[displayId(second)] = second.id;
    }, ctx);
    await closePiSession(session);
    session = await openPiSession(sessionId);
    assert.deepEqual(await readPiSessionMessageEntry(sessionId, "saved-link"), original);
    assert.deepEqual(
      (await readPiSessionBranch(session)).map((entry) => entry.id),
      ["saved-link", "saved-suffix"],
    );
    await rewritePiSessionMessage(sessionId, "saved-link", userMessage("Edited message"), false);
    assert.ok(
      (await readPiSessionBranch(session)).every((entry) => entry.id.startsWith("durable:")),
    );
    assert.deepEqual(
      await readPiSessionMessageEntry(sessionId, "saved-link"),
      original,
      "saved links retain the original entry",
    );
  } finally {
    await closePiSession(session);
  }
});

test("title sampling stops on the first page instead of reading the whole transcript", async (t) => {
  const { sessionId } = createSession();
  const session = await openPiSession(sessionId);
  const messages = Array.from({ length: 300 }, (_, index) =>
    index % 2 ? fauxAssistantMessage(`Answer ${index}`) : userMessage(`Question ${index}`),
  );
  try {
    await session.conversation.commit(async (tx) => {
      for (const message of messages)
        await tx.appendEntry(session.conversation.id, messageDraft(message));
    }, ctx);
    const entries = t.mock.method(session.conversation, "entries");
    assert.deepEqual(await readPiSessionTitleMessages(session), messages.slice(0, 4));
    assert.equal(entries.mock.callCount(), 1);
    assert.equal(entries.mock.calls[0]!.arguments[1], 100);
  } finally {
    await closePiSession(session);
  }
});

test("title sampling can find a later successful answer without retaining intervening errors", async (t) => {
  const { sessionId } = createSession();
  const session = await openPiSession(sessionId);
  const messages = [
    userMessage("Question"),
    ...Array.from({ length: 210 }, () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Unavailable" }),
    ),
    fauxAssistantMessage("Finally answered."),
  ];
  try {
    await session.conversation.commit(async (tx) => {
      for (const message of messages)
        await tx.appendEntry(session.conversation.id, messageDraft(message));
    }, ctx);
    const entries = t.mock.method(session.conversation, "entries");
    assert.deepEqual(await readPiSessionTitleMessages(session), [
      ...messages.slice(0, 4),
      messages.at(-1),
    ]);
    assert.equal(entries.mock.callCount(), 3);
  } finally {
    await closePiSession(session);
  }
});
