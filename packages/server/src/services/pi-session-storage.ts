import {
  BACKGROUND_CONTEXT,
  branchTip,
  insertEntry,
  setValue,
  type AgentLane,
  type AgentMessage,
  type Branch,
  type Context,
  type Entry,
  type NewEntry,
  type Session,
  type Write,
} from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SQLITE_STORAGE_VERSION,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { dataDir } from "../paths.ts";

type SessionRecord = typeof sessions.$inferSelect;

/**
 * Derived rather than imported: 0.85 moved this type into `sqlite/session/`
 * without re-exporting it, and the package publishes only its root entrypoint,
 * so the repo's own signature is the only place it is reachable from.
 */
type SqliteSessionMetadata = Parameters<SqliteSessionRepo["open"]>[0];

/**
 * The branch every Carmel conversation lives on.
 *
 * Pi 0.85 has no default: `harness.lane(name)` creates the branch tip on first
 * acquisition under whatever name it is given, and this module has to read and
 * move the same one. Both sides read this constant so they cannot drift.
 */
export const PI_MAIN_BRANCH = "main";

/**
 * Pi 0.85 threads a `Context` (abort signal + telemetry parent) through every
 * storage call. Nothing in this module is cancellable -- these are short local
 * SQLite operations, and abandoning one half-way buys nothing -- so they all run
 * on the background context. The run path builds its own cancellable context.
 */
const ctx: Context = BACKGROUND_CONTEXT;

const piDatabasePath = resolvePiDatabasePath();
const piSessionRepo = new SqliteSessionRepo({
  directory: dataDir,
  databasePath: piDatabasePath,
  databaseFactory: createNodeSqliteFactory(),
});
const creationPromises = new Map<string, Promise<void>>();

type PiSession = Awaited<ReturnType<SqliteSessionRepo["open"]>>;
/** The lane surface a live run registers so reads can follow it. */
export type PiSessionLane = Pick<AgentLane, "watch" | "findEntries">;

/**
 * Entry id given to the assistant message a lane is still streaming.
 *
 * It is not a real entry: 0.85 keeps an in-flight reply as operation state and
 * only commits it when the turn settles. Prefixed so nothing downstream mistakes
 * it for something it can edit, fork or navigate to.
 */
export const PENDING_ENTRY_ID_PREFIX = "pending:";

type SessionLease = { session: PiSession; holders: number; lane?: PiSessionLane };

/**
 * Open sessions, by id, with a holder count.
 *
 * 0.85 made a session exclusive: `SqliteSessionRepo` refuses to open one that is
 * already open ("Session is already open: <id>"), where 0.83 handed out
 * independent handles. Carmel legitimately reaches the same session twice --
 * an HTTP read of the transcript while a run holds it, most obviously -- so the
 * second caller shares the first one's handle and the session closes when the
 * last holder lets go.
 *
 * Two maps rather than one: `opening` lets a concurrent opener wait for the
 * handle instead of racing the exclusivity check, while `leases` is resolved
 * and synchronous so releasing never has to await an open. That matters,
 * because provisioning a new session opens and closes a handle of its own from
 * inside the very open the second caller would be waiting on -- awaiting there
 * deadlocks the first use of every new session.
 */
const opening = new Map<string, Promise<PiSession>>();
const leases = new Map<string, SessionLease>();

/** Open an existing Pi-native session, provisioning new Carmel sessions on first use. */
export async function openPiSession(sessionId: string): Promise<PiSession> {
  const held = leases.get(sessionId);
  if (held) {
    held.holders += 1;
    return held.session;
  }

  const inFlight = opening.get(sessionId);
  if (inFlight) {
    await inFlight;
    return openPiSession(sessionId);
  }

  const attempt = openNativeSession(sessionId);
  opening.set(sessionId, attempt);
  try {
    const session = await attempt;
    leases.set(sessionId, { session, holders: 1 });
    return session;
  } finally {
    opening.delete(sessionId);
  }
}

async function openNativeSession(sessionId: string): Promise<PiSession> {
  const record = readSessionRecord(sessionId);
  const metadata = nativeMetadata(record);
  try {
    return await piSessionRepo.open(metadata, ctx);
  } catch (error) {
    if (!isSessionMissing(error)) throw error;
  }

  await createNativeSession(record);
  return piSessionRepo.open(metadata, ctx);
}

/** Release one holder's claim. The session closes when the last one lets go. */
export async function closePiSession(session: Session) {
  const sessionId = session.metadata.id;
  const lease = leases.get(sessionId);
  if (lease?.session !== session) {
    // A handle this module never leased out -- a fork's, or the short-lived one
    // provisioning opens -- so it is this caller's to close outright.
    await session.close(ctx);
    return;
  }
  lease.holders -= 1;
  if (lease.holders > 0) return;
  leases.delete(sessionId);
  await lease.session.close(ctx);
}

export async function withPiSession<T>(
  sessionId: string,
  operation: (session: Session<SqliteSessionMetadata>) => Promise<T>,
) {
  const session = await openPiSession(sessionId);
  try {
    return await operation(session);
  } finally {
    await closePiSession(session);
  }
}

/**
 * Fork a session so the copy's conversation ends at `entryId`.
 *
 * Copies the whole tree and then re-points the branch, rather than asking for
 * 0.85's `scope: "branch"` fork, which does exactly this in one step but refuses
 * any branch that is not a *configured lane*. Carmel creates branches without
 * lanes all the time -- an imported transcript, or any session written to before
 * it has ever run -- and those must stay forkable. A tree fork preserves entry
 * ids, so re-pointing the tip afterwards lands on the same entry the caller
 * named. The cost is that sibling branches come along; the visible transcript is
 * identical either way.
 *
 * `parentSessionId` is no longer a fork input: 0.85 sets it from the source.
 * Carmel's own `forked_from` column stays the record of who forked what.
 */
export async function forkPiSession(sourceSessionId: string, targetSessionId: string, entryId: string) {
  const source = readSessionRecord(sourceSessionId);
  await ensureNativeSession(source);
  const fork = await piSessionRepo.fork(nativeMetadata(source), { scope: "tree", id: targetSessionId }, ctx);
  try {
    const entry = await fork.getEntry(entryId, ctx);
    if (!entry) throw new SessionEntryNotFoundError(entryId);
    await fork.setValue(branchTip(PI_MAIN_BRANCH), entryId, ctx);
  } finally {
    await closePiSession(fork);
  }
}

export async function deletePiSession(session: SessionRecord) {
  try {
    await piSessionRepo.delete(nativeMetadata(session), ctx);
  } catch (error) {
    if (!isSessionMissing(error)) throw error;
  }
}

export async function deletePiSessions(records: SessionRecord[]) {
  for (const record of records) await deletePiSession(record);
}

export async function replacePiSessionMessages(sessionId: string, messages: AgentMessage[]) {
  await withPiSession(sessionId, async (session) => {
    const branch = await resetBranch(session);
    for (const message of messages) await branch.appendMessage(message, ctx);
  });
}

export async function movePiSessionToEntry(sessionId: string, entryId: string) {
  await withPiSession(sessionId, async (session) => {
    const entry = await session.getEntry(entryId, ctx);
    if (!entry || entry.type !== "message") throw new SessionEntryNotFoundError(entryId);
    await session.setValue(branchTip(PI_MAIN_BRANCH), entryId, ctx);
  });
}

/**
 * Replace one immutable message entry by creating a sibling branch. When the
 * edit is non-truncating, clone the remaining entries onto that branch,
 * remapping all entry-ID references instead of flattening them to messages.
 *
 * The whole rewrite is one commit. Pi 0.85 replaced direct storage appends with
 * a transactional mutation line, which turns what used to be a loop of
 * individually-visible appends into a single atomic branch swap: a crash midway
 * can no longer leave a half-cloned branch behind.
 */
export async function rewritePiSessionMessage(
  sessionId: string,
  entryId: string,
  message: AgentMessage,
  truncate: boolean,
) {
  return withPiSession(sessionId, async (session) => {
    const branch = await requireBranch(session);
    const entries = await branch.findEntries({ order: "oldestFirst" }, ctx);
    const targetIndex = entries.findIndex((entry) => entry.id === entryId);
    const target = entries[targetIndex];
    if (!target || target.type !== "message") throw new SessionEntryNotFoundError(entryId);

    const replacementId = session.idGenerator.next();
    const writes: Write[] = [
      insertEntry({ id: replacementId, parentId: target.parentId, type: "message", message }),
    ];

    let tipId = replacementId;
    if (!truncate) {
      const remappedIds = new Map([[target.id, replacementId]]);
      for (const entry of entries.slice(targetIndex + 1)) {
        const clone = cloneEntry(entry, session.idGenerator.next(), tipId, remappedIds);
        writes.push(insertEntry(clone));
        remappedIds.set(entry.id, clone.id);
        tipId = clone.id;
      }
    }

    writes.push(setValue(branchTip(PI_MAIN_BRANCH), tipId));
    await session.mutate((mutator) => mutator.commit(writes, ctx), ctx);
    return replacementId;
  });
}

/**
 * Copy one entry onto a new parent.
 *
 * Only `branch_summary.fromId` still needs remapping. Pi 0.85 dropped the
 * `leaf` and `label` entry types -- branch tips are stored values now, and
 * labels are `session.setLabel` -- and `compaction` no longer carries
 * `firstKeptEntryId`, so those three remaps went away with them.
 */
function cloneEntry(entry: Entry, id: string, parentId: string, remappedIds: Map<string, string>): NewEntry {
  const { seq: _seq, timestamp: _timestamp, ...rest } = entry;
  const clone = structuredClone(rest) as NewEntry;
  clone.id = id;
  clone.parentId = parentId;
  if (clone.type === "branch_summary") {
    clone.fromId = clone.fromId === null ? null : (remappedIds.get(clone.fromId) ?? clone.fromId);
  }
  return clone;
}

/**
 * Register the lane a run is driving, so reads of this session follow it.
 *
 * Necessary because 0.85 does not write the stored branch tip per message: a
 * lane advances a tip it holds in memory and only publishes it at operation
 * boundaries. Anything reading the branch from the stored value -- an HTTP
 * transcript fetch during a run, most of all -- would see the session as it was
 * when the turn started. Returns the deregistration handle.
 */
export function registerPiSessionLane(session: Session, lane: PiSessionLane): () => void {
  const lease = leases.get(session.metadata.id);
  if (lease?.session !== session) return () => {};
  lease.lane = lane;
  return () => {
    if (lease.lane === lane) lease.lane = undefined;
  };
}

/**
 * Read the conversation branch in transcript order.
 *
 * `session.getBranch()` is gone in 0.85: traversal moved onto a named `Branch`
 * whose scans default to `newestFirst`. Callers all want oldest-first, and a
 * session with no branch yet reads as empty rather than throwing.
 *
 * Prefers a registered lane, which is the only view that is current mid-run.
 */
export async function readPiSessionBranch(session: Session): Promise<Entry[]> {
  const lane = leases.get(session.metadata.id)?.lane;
  if (lane) return readLaneTranscript(lane);
  const branch = await session.branch(PI_MAIN_BRANCH, ctx);
  if (!branch) return [];
  return branch.findEntries({ order: "oldestFirst" }, ctx);
}

/**
 * The live view of a lane: its committed transcript plus the reply in progress.
 *
 * A lane snapshot is the only complete answer while a turn is running. The
 * branch alone is not: 0.85 keeps the streaming assistant message in operation
 * state and commits it when the turn settles, so a client reconnecting mid-turn
 * would otherwise be handed a transcript that stops at its own prompt and stays
 * there until the reply finishes.
 */
async function readLaneTranscript(lane: PiSessionLane): Promise<Entry[]> {
  // The committed branch comes from the lane's own scan, not from the snapshot:
  // `LaneSnapshot.transcript` is the model-facing window, which compaction can
  // cut, and callers here want the whole conversation.
  const committed = await lane.findEntries({ order: "oldestFirst" }, ctx);
  const handle = await lane.watch(ctx);
  let streaming;
  let operationId;
  try {
    streaming = handle.snapshot.operation?.streamingMessage;
    operationId = handle.snapshot.operation?.id;
  } finally {
    handle.unsubscribe();
  }
  if (!streaming) return committed;
  const tip = committed.at(-1);
  return [
    ...committed,
    {
      id: `${PENDING_ENTRY_ID_PREFIX}${operationId ?? "run"}`,
      parentId: tip?.id ?? null,
      seq: (tip?.seq ?? 0) + 1,
      timestamp: Date.now(),
      type: "message",
      message: streaming,
    },
  ];
}

/** The conversation branch, which must already exist for there to be anything to rewrite. */
async function requireBranch(session: Session): Promise<Branch> {
  const branch = await session.branch(PI_MAIN_BRANCH, ctx);
  if (!branch) throw new SessionEntryNotFoundError(`branch ${PI_MAIN_BRANCH}`);
  return branch;
}

/** Point the conversation branch back at the root, creating it if this session has none yet. */
async function resetBranch(session: Session): Promise<Branch> {
  const branch = await session.branch(PI_MAIN_BRANCH, ctx);
  if (!branch) return session.createBranch(PI_MAIN_BRANCH, null, ctx);
  await session.setValue(branchTip(PI_MAIN_BRANCH), null, ctx);
  return branch;
}

export class SessionEntryNotFoundError extends Error {
  constructor(what: string) {
    super(`Message entry ${what} not found`);
    this.name = "SessionEntryNotFoundError";
  }
}

async function createNativeSession(record: SessionRecord) {
  const existing = creationPromises.get(record.id);
  if (existing) return existing;
  const creation = createNativeSessionOnce(record).finally(() => creationPromises.delete(record.id));
  creationPromises.set(record.id, creation);
  return creation;
}

async function createNativeSessionOnce(record: SessionRecord) {
  const created = await piSessionRepo.create(
    { id: record.id, ...(record.forkedFrom ? { parentSessionId: record.forkedFrom.sessionId } : {}) },
    ctx,
  );
  await closePiSession(created);
}

async function ensureNativeSession(record: SessionRecord) {
  try {
    const existing = await piSessionRepo.open(nativeMetadata(record), ctx);
    await closePiSession(existing);
  } catch (error) {
    if (!isSessionMissing(error)) throw error;
    await createNativeSession(record);
  }
}

function readSessionRecord(sessionId: string) {
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!record) throw new SessionEntryNotFoundError(`session ${sessionId}`);
  return record;
}

/**
 * Metadata is now an address, not a payload.
 *
 * 0.85 dropped `cwd` and the application-metadata bag from session metadata;
 * `open`/`delete` re-read the authoritative row from SQLite anyway, so only
 * `id` and `path` decide which session is reached. Carmel's `sessions` table
 * remains the only home for `userId`/`agentId`.
 */
function nativeMetadata(record: SessionRecord): SqliteSessionMetadata {
  return {
    id: record.id,
    createdAt: record.createdAt,
    storageVersion: SQLITE_STORAGE_VERSION,
    ...(record.forkedFrom ? { parentSessionId: record.forkedFrom.sessionId } : {}),
    path: piDatabasePath,
  };
}

/**
 * Whether an error means "this session was never provisioned".
 *
 * 0.85 removed `SessionError` and its `not_found` code without replacing them:
 * the SQLite backend throws a bare `Error` for an absent row, so the message is
 * the only signal left. Matching it is brittle by construction -- if a Pi
 * upgrade reworks this text, sessions silently get re-provisioned instead of
 * failing loudly -- so keep it in one place and revisit when Pi reintroduces
 * coded session errors.
 */
function isSessionMissing(error: unknown) {
  if (!(error instanceof Error)) return false;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
  return /Unknown SQLite session/i.test(error.message);
}

function resolvePiDatabasePath() {
  const configured = process.env.CARMEL_PI_SESSION_DATABASE_URL;
  if (configured && configured !== ":memory:") return resolve(configured.replace(/^file:/, ""));
  if (process.env.DATABASE_URL === ":memory:" || configured === ":memory:") {
    return join(mkdtempSync(join(tmpdir(), "carmel-pi-sessions-")), "sessions.sqlite");
  }
  return join(dataDir, "pi-sessions.sqlite");
}
