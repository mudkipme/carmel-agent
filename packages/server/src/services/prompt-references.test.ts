import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  getMessageReferences,
  type MessageReference,
  type ReferenceMessage,
  updateUserMessageContent,
} from "@carmel-agent/shared";
import { db, initialize } from "../db/index.ts";
import { agents, sessions } from "../db/schema.ts";
import { createSession, userMessage } from "../test-support.ts";
import { attachTestHarness, fauxHarnessModels } from "../effectors/testing/pi-harness.ts";
import { prepareAgentRunPrompt } from "../runtime/agent-runtime.ts";
import {
  closePiSession,
  forkPiSession,
  openPiSession,
  readPiSessionBranch,
  replacePiSessionMessages,
  rewritePiSessionMessage,
  withPiSession,
} from "./pi-session-storage.ts";
import { readSessionMessages } from "./session-store.ts";
import { resolvePromptReferences } from "./prompt-references.ts";

initialize();

function readAgent(id: string) {
  return db.select().from(agents).where(eq(agents.id, id)).get()!;
}

test("conversation references use owned Durable history, canonical labels, and bounded text", async () => {
  const current = createSession();
  const other = createSession({ userId: current.userId });
  db.update(sessions)
    .set({ title: "Earlier decision" })
    .where(eq(sessions.id, other.sessionId))
    .run();
  await replacePiSessionMessages(other.sessionId, [
    userMessage("An old decision"),
    fauxAssistantMessage("Use SQLite."),
    fauxAssistantMessage([
      { type: "thinking", thinking: "PRIVATE_REASONING" },
      { type: "text", text: "Recent answer " + "x".repeat(40_000) },
    ]),
  ]);
  const reference: MessageReference = {
    kind: "session",
    sessionId: other.sessionId,
    agentId: "untrusted",
    label: "untrusted",
  };
  const result = await resolvePromptReferences(
    current.userId,
    readAgent(current.agentId),
    current.sessionId,
    [reference, reference],
  );
  assert.deepEqual(result.references, [
    { ...reference, agentId: other.agentId, label: "Earlier decision" },
  ]);
  assert.match(result.context, /Use SQLite/);
  assert.match(result.context, /Recent answer/);
  assert.doesNotMatch(result.context, /PRIVATE_REASONING/);
  assert.ok(result.context.length < 7000);
  const foreign = createSession();
  await assert.rejects(
    resolvePromptReferences(current.userId, readAgent(current.agentId), current.sessionId, [
      { ...reference, sessionId: foreign.sessionId },
    ]),
    /unavailable/,
  );
  await assert.rejects(
    resolvePromptReferences(current.userId, readAgent(current.agentId), current.sessionId, [
      { ...reference, sessionId: current.sessionId },
    ]),
    /different conversation/,
  );
});

test("file references enforce read access, workspace paths, symlink boundaries, and entry type", async () => {
  const current = createSession();
  const directory = await mkdtemp(join(tmpdir(), "carmel-references-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "a file.md"), "FILE_CONTENT_IS_NOT_INLINED");
  await writeFile(join(directory, "private.txt"), "private");
  await symlink(join(directory, "private.txt"), join(workspace, "escape"));
  db.update(agents).set({ workingDir: workspace }).where(eq(agents.id, current.agentId)).run();
  const agent = readAgent(current.agentId);
  try {
    const result = await resolvePromptReferences(current.userId, agent, current.sessionId, [
      { kind: "file", path: "a file.md" },
      { kind: "folder", path: "." },
    ]);
    assert.deepEqual(result.references, [
      { kind: "file", path: "a file.md" },
      { kind: "folder", path: "." },
    ]);
    assert.doesNotMatch(result.context, /FILE_CONTENT_IS_NOT_INLINED/);
    assert.doesNotMatch(result.context, new RegExp(directory));
    for (const path of ["../private.txt", "escape", "/etc/passwd", "missing.txt"])
      await assert.rejects(
        resolvePromptReferences(current.userId, agent, current.sessionId, [{ kind: "file", path }]),
      );
    await assert.rejects(
      resolvePromptReferences(current.userId, agent, current.sessionId, [
        { kind: "folder", path: "a file.md" },
      ]),
      /no longer available/,
    );
    await assert.rejects(
      resolvePromptReferences(
        current.userId,
        { ...agent, permissions: { ...agent.permissions, read: false } },
        current.sessionId,
        [{ kind: "file", path: "a file.md" }],
      ),
      /Read permission/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native referenced inputs keep display metadata separate from model context across reopen, edits, retry, and forks", async () => {
  const current = createSession();
  const references: MessageReference[] = [{ kind: "folder", path: "docs" }];
  const context = "REFERENCE_SNAPSHOT_ONLY_FOR_MODEL";
  const models = fauxHarnessModels();
  models.faux.setResponses([
    (request) => {
      const input = request.messages.findLast((message) => message.role === "user");
      assert.match(JSON.stringify(input), /REFERENCE_SNAPSHOT_ONLY_FOR_MODEL/);
      return fauxAssistantMessage("Done");
    },
  ]);
  const pi = await attachTestHarness(await openPiSession(current.sessionId), models);
  try {
    await pi.harness.prompt("Review this", undefined, pi.context, { references, context });
  } finally {
    await pi.close();
  }
  const messages = await readSessionMessages(current.sessionId);
  assert.deepEqual(getMessageReferences(messages[0]!), references);
  assert.equal((messages[0] as ReferenceMessage).referenceContext, context);
  assert.doesNotMatch(
    JSON.stringify((messages[0] as { content: unknown }).content),
    /REFERENCE_SNAPSHOT/,
  );
  const entryId = await withPiSession(
    current.sessionId,
    async (session) => (await readPiSessionBranch(session))[0]!.id,
  );
  await rewritePiSessionMessage(
    current.sessionId,
    entryId,
    updateUserMessageContent(messages[0]!, "Edited request"),
    false,
  );
  const edited = await readSessionMessages(current.sessionId);
  assert.deepEqual(getMessageReferences(edited[0]!), references);
  const target = createSession({ userId: current.userId });
  const editedId = await withPiSession(
    current.sessionId,
    async (session) => (await readPiSessionBranch(session))[0]!.id,
  );
  await forkPiSession(current.sessionId, target.sessionId, editedId);
  assert.deepEqual(
    getMessageReferences((await readSessionMessages(target.sessionId))[0]!),
    references,
  );
  const reopened = await openPiSession(current.sessionId);
  try {
    const native = await reopened.conversation.entries(
      { order: "ascending" },
      100,
      undefined,
      pi.context,
    );
    assert.match(JSON.stringify(native.items[0]?.model), /REFERENCE_SNAPSHOT_ONLY_FOR_MODEL/);
  } finally {
    await closePiSession(reopened);
  }

  const referenceOnly = createSession();
  await replacePiSessionMessages(referenceOnly.sessionId, [
    { role: "user", content: "", references, referenceContext: context } as ReferenceMessage,
  ]);
  const retry = await attachTestHarness(
    await openPiSession(referenceOnly.sessionId),
    fauxHarnessModels(),
  );
  try {
    const prepared = await prepareAgentRunPrompt(retry.log);
    assert.deepEqual(prepared.promptInput.references, references);
    assert.equal(prepared.promptInput.text, "");
  } finally {
    await retry.close();
  }
});
