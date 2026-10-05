import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { migrate } from "../db/index.ts";
import { createSession, userMessage } from "../test-support.ts";
import { ActiveConversation, closePiSession, movePiSessionToEntry, openPiSession, readPiSessionBranch, rewritePiSessionMessage } from "./pi-session-storage.ts";
import { migrateLegacyPiSession } from "./pi-session-migration.ts";

migrate();
const ctx = BACKGROUND_CONTEXT;

function legacyFixture(sessionId: string) {
  const directory = mkdtempSync(join(tmpdir(), "carmel-legacy-import-"));
  const path = join(directory, "legacy.sqlite");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE entries(session_id TEXT, id TEXT, parent_id TEXT, seq INTEGER, type TEXT, custom_type TEXT, timestamp INTEGER, payload TEXT);
    CREATE TABLE scalar_values(session_id TEXT, namespace TEXT, key TEXT, seq INTEGER, value TEXT);
  `);
  const append = (id: string, parent: string | null, seq: number, type: string, payload: unknown) => legacy.prepare("INSERT INTO entries VALUES(?,?,?,?,?,NULL,?,?)").run(sessionId, id, parent, seq, type, seq * 10, JSON.stringify(payload));
  const scalar = (namespace: string, value: unknown) => legacy.prepare("INSERT INTO scalar_values VALUES(?,?,'main',1,?)").run(sessionId, namespace, JSON.stringify(value));
  return { legacy, path, directory, append, scalar };
}

test("legacy SQLite migration preserves entry IDs, abandoned branches, compaction context, and configuration", async () => {
  const { sessionId } = createSession();
  const fixture = legacyFixture(sessionId);
  fixture.append("question", null, 1, "message", { message: userMessage("original question") });
  fixture.append("abandoned", "question", 2, "message", { message: fauxAssistantMessage("abandoned answer") });
  fixture.append("answer", "question", 3, "message", { message: fauxAssistantMessage("chosen answer") });
  fixture.append("summary", "answer", 4, "compaction", { summary: "Earlier work summarized", retainedTail: [userMessage("keep this recent context")], fromHook: false });
  fixture.append("current", "summary", 5, "message", { message: userMessage("current question") });
  fixture.scalar("pi.branch.tip", "current");
  fixture.scalar("pi.lane.config", { model: { provider: "azure-openai-responses", modelId: "deployment" }, thinkingLevel: "high", activeToolNames: ["read"] });
  fixture.legacy.close();
  const original = readFileSync(fixture.path);
  let session = await openPiSession(sessionId);
  try {
    await migrateLegacyPiSession(session, fixture.path);
    await closePiSession(session);
    session = await openPiSession(sessionId);
    assert.deepEqual((await readPiSessionBranch(session)).map(entry => entry.id), ["question", "answer", "summary", "current"]);
    const agent = await session.native.snapshot(AgentDoc, session.conversation.id, ctx);
    assert.deepEqual(agent?.model, { provider: "azure", modelId: "deployment" });
    assert.equal(agent?.thinkingLevel, "high");
    assert.deepEqual(agent?.tools, ["read"]);
    const context = await session.conversation.context(ctx);
    assert.match(JSON.stringify(context.messages), /Earlier work summarized/);
    assert.match(JSON.stringify(context.messages), /keep this recent context/);
    assert.doesNotMatch(JSON.stringify(context.messages), /original question/);
    const before = await session.findEntries({}, ctx);
    await migrateLegacyPiSession(session, fixture.path);
    assert.equal((await session.findEntries({}, ctx)).length, before.length, "import is idempotent");
    await movePiSessionToEntry(sessionId, "abandoned");
    assert.deepEqual((await readPiSessionBranch(session)).map(entry => entry.id), ["question", "abandoned"]);
    await movePiSessionToEntry(sessionId, "current");
    await rewritePiSessionMessage(sessionId, "question", userMessage("edited question"), false);
    const edited = await readPiSessionBranch(session);
    assert.equal(new Set(edited.map(entry => entry.id)).size, edited.length);
    assert.ok(edited.every(entry => !["question", "answer", "summary", "current"].includes(entry.id)), "cloned entries receive fresh identities");
    assert.deepEqual(readFileSync(fixture.path), original, "legacy database remains an untouched archive");
  } finally { await closePiSession(session); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("migration resumes a partially imported tree and honors a rewound legacy tip", async () => {
  const { sessionId } = createSession();
  const fixture = legacyFixture(sessionId);
  fixture.append("root", null, 1, "message", { message: userMessage("root") });
  fixture.append("bad-parent", "missing", 2, "message", { message: fauxAssistantMessage("later answer") });
  fixture.scalar("pi.branch.tip", "root");
  fixture.legacy.close();
  const session = await openPiSession(sessionId);
  try {
    await session.native.commit(async tx => { (await tx.doc(ActiveConversation)).migrated = false; }, ctx);
    await assert.rejects(migrateLegacyPiSession(session, fixture.path), /Missing legacy parent/);
    assert.equal((await session.findEntries({}, ctx)).length, 1);
    assert.equal((await session.native.snapshot(ActiveConversation, ctx))?.migrated, false);
    const repair = new Database(fixture.path);
    repair.exec("UPDATE entries SET parent_id='root' WHERE id='bad-parent'");
    repair.close();
    await migrateLegacyPiSession(session, fixture.path);
    const active = await session.native.snapshot(ActiveConversation, ctx);
    session.conversation = (await session.native.conversation(active!.id as typeof session.conversation.id, ctx))!;
    assert.equal((await session.findEntries({}, ctx)).length, 2);
    assert.deepEqual((await readPiSessionBranch(session)).map(entry => entry.id), ["root"], "later descendants stay outside a rewound tip");
  } finally { await closePiSession(session); rmSync(fixture.directory, { recursive: true, force: true }); }
});
