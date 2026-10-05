import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { initialize } from "../db/index.ts";
import { createSession, userMessage } from "../test-support.ts";
import { EntryIndex, closePiSession, displayId, messageDraft, openPiSession, readPiSessionBranch, readPiSessionMessageEntry, rewritePiSessionMessage } from "./pi-session-storage.ts";

initialize();
const ctx = BACKGROUND_CONTEXT;

test("stable public message IDs remain readable after reopen and edits give copied entries fresh IDs", async () => {
  const { sessionId } = createSession();
  const original = userMessage("Saved message");
  let session = await openPiSession(sessionId);
  try {
    await session.conversation.commit(async tx => {
      const first = await tx.appendEntry(session.conversation.id, { ...messageDraft(original), data: { carmelEntryId: "saved-link" } });
      const second = await tx.appendEntry(session.conversation.id, { ...messageDraft(userMessage("Suffix")), data: { carmelEntryId: "saved-suffix" } });
      const index = await tx.doc(EntryIndex);
      index[displayId(first)] = first.id;
      index[displayId(second)] = second.id;
    }, ctx);
    await closePiSession(session);
    session = await openPiSession(sessionId);
    assert.deepEqual(await readPiSessionMessageEntry(sessionId, "saved-link"), original);
    assert.deepEqual((await readPiSessionBranch(session)).map(entry => entry.id), ["saved-link", "saved-suffix"]);
    await rewritePiSessionMessage(sessionId, "saved-link", userMessage("Edited message"), false);
    assert.ok((await readPiSessionBranch(session)).every(entry => entry.id.startsWith("durable:")));
    assert.deepEqual(await readPiSessionMessageEntry(sessionId, "saved-link"), original, "saved links retain the original entry");
  } finally { await closePiSession(session); }
});
