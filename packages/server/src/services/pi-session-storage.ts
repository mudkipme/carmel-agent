import {
  SessionError,
  type AgentMessage,
  type Session,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
  type SqliteSessionMetadata,
} from "@earendil-works/pi-storage-sqlite-node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { dataDir } from "../paths.ts";

type SessionRecord = typeof sessions.$inferSelect;
type ClosableStorage = { cleanup?: () => Promise<void> };

const piDatabasePath = resolvePiDatabasePath();
const piSessionRepo = new SqliteSessionRepo({
  env: new NodeExecutionEnv({ cwd: dataDir }),
  sqlite: createNodeSqliteFactory(),
  databasePath: piDatabasePath,
});
const creationPromises = new Map<string, Promise<void>>();

/** Open an existing Pi-native session, provisioning new Carmel sessions on first use. */
export async function openPiSession(sessionId: string) {
  const record = readSessionRecord(sessionId);
  const metadata = nativeMetadata(record);
  try {
    return await piSessionRepo.open(metadata);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await createNativeSession(record);
  return piSessionRepo.open(metadata);
}

export async function closePiSession(session: Session) {
  await (session.getStorage() as ClosableStorage).cleanup?.();
}

export async function withPiSession<T>(sessionId: string, operation: (session: Session<SqliteSessionMetadata>) => Promise<T>) {
  const session = await openPiSession(sessionId);
  try {
    return await operation(session);
  } finally {
    await closePiSession(session);
  }
}

export async function forkPiSession(sourceSessionId: string, targetSessionId: string, entryId: string) {
  const source = readSessionRecord(sourceSessionId);
  const target = readSessionRecord(targetSessionId);
  await ensureNativeSession(source);
  const fork = await piSessionRepo.fork(nativeMetadata(source), {
    id: targetSessionId,
    cwd: dataDir,
    parentSessionId: sourceSessionId,
    metadata: nativeApplicationMetadata(target),
    entryId,
    position: "at",
  });
  await closePiSession(fork);
}

export async function deletePiSession(session: SessionRecord) {
  try {
    await piSessionRepo.delete(nativeMetadata(session));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function deletePiSessions(records: SessionRecord[]) {
  for (const record of records) await deletePiSession(record);
}

export async function replacePiSessionMessages(sessionId: string, messages: AgentMessage[]) {
  await withPiSession(sessionId, async (session) => {
    await session.moveTo(null);
    for (const message of messages) await session.appendMessage(message);
  });
}

export async function movePiSessionToEntry(sessionId: string, entryId: string) {
  await withPiSession(sessionId, async (session) => {
    const entry = await session.getEntry(entryId);
    if (!entry || entry.type !== "message") {
      throw new SessionError("not_found", `Message entry ${entryId} not found`);
    }
    await session.moveTo(entryId);
  });
}

/**
 * Replace one immutable message entry by creating a sibling branch. When the
 * edit is non-truncating, clone the remaining native entries onto that branch,
 * remapping all entry-ID references instead of flattening them to messages.
 */
export async function rewritePiSessionMessage(
  sessionId: string,
  entryId: string,
  message: AgentMessage,
  truncate: boolean,
) {
  return withPiSession(sessionId, async (session) => {
    const branch = await session.getBranch();
    const targetIndex = branch.findIndex((entry) => entry.id === entryId);
    const target = branch[targetIndex];
    if (!target || target.type !== "message") {
      throw new SessionError("not_found", `Message entry ${entryId} not found`);
    }

    await session.moveTo(target.parentId);
    const replacementId = await session.appendMessage(message);
    if (truncate) return replacementId;

    const remappedIds = new Map([[target.id, replacementId]]);
    let parentId = replacementId;
    for (const entry of branch.slice(targetIndex + 1)) {
      if (entry.type === "leaf") continue;
      const clone = cloneEntry(entry, await session.getStorage().createEntryId(), parentId, remappedIds);
      await session.getStorage().appendEntry(clone);
      remappedIds.set(entry.id, clone.id);
      parentId = clone.id;
    }
    return replacementId;
  });
}

function cloneEntry(
  entry: SessionTreeEntry,
  id: string,
  parentId: string,
  remappedIds: Map<string, string>,
): SessionTreeEntry {
  const clone = structuredClone(entry) as SessionTreeEntry;
  clone.id = id;
  clone.parentId = parentId;
  const remap = (targetId: string | null | undefined) =>
    targetId === null || targetId === undefined ? targetId : (remappedIds.get(targetId) ?? targetId);

  if (clone.type === "compaction") clone.firstKeptEntryId = remap(clone.firstKeptEntryId) ?? undefined;
  if (clone.type === "branch_summary") clone.fromId = remap(clone.fromId) ?? "root";
  if (clone.type === "label") clone.targetId = remap(clone.targetId) ?? clone.targetId;
  if (clone.type === "leaf") clone.targetId = remap(clone.targetId) ?? null;
  return clone;
}

async function createNativeSession(record: SessionRecord) {
  const existing = creationPromises.get(record.id);
  if (existing) return existing;
  const creation = createNativeSessionOnce(record).finally(() => creationPromises.delete(record.id));
  creationPromises.set(record.id, creation);
  return creation;
}

async function createNativeSessionOnce(record: SessionRecord) {
  const created = await piSessionRepo.create({
    id: record.id,
    cwd: dataDir,
    parentSessionId: record.forkedFrom?.sessionId,
    metadata: nativeApplicationMetadata(record),
  });
  await closePiSession(created);
}

async function ensureNativeSession(record: SessionRecord) {
  try {
    const existing = await piSessionRepo.open(nativeMetadata(record));
    await closePiSession(existing);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await createNativeSession(record);
  }
}

function readSessionRecord(sessionId: string) {
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!record) throw new SessionError("not_found", `Session ${sessionId} not found`);
  return record;
}

function nativeMetadata(record: SessionRecord): SqliteSessionMetadata {
  return {
    id: record.id,
    createdAt: new Date(record.createdAt).toISOString(),
    cwd: dataDir,
    path: piDatabasePath,
    parentSessionId: record.forkedFrom?.sessionId,
    metadata: nativeApplicationMetadata(record),
  };
}

function nativeApplicationMetadata(record: SessionRecord) {
  return { userId: record.userId, agentId: record.agentId };
}

function isNotFound(error: unknown) {
  return error instanceof SessionError && error.code === "not_found";
}

function resolvePiDatabasePath() {
  const configured = process.env.CARMEL_PI_SESSION_DATABASE_URL;
  if (configured && configured !== ":memory:") return resolve(configured.replace(/^file:/, ""));
  if (process.env.DATABASE_URL === ":memory:" || configured === ":memory:") {
    return join(mkdtempSync(join(tmpdir(), "carmel-pi-sessions-")), "sessions.sqlite");
  }
  return join(dataDir, "pi-sessions.sqlite");
}
