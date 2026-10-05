import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type Models, type Message } from "@earendil-works/pi-ai";
import { AgentDoc, defineDoc, Harness, LiveDoc, createRegistry, type Conversation, type ConversationId, type Cursor, type EntryDraft, type EntryId, type EntryRecord, type HarnessSettings, type Registry, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { dataDir } from "../paths.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { migrateLegacyPiSession } from "./pi-session-migration.ts";

const ctx = BACKGROUND_CONTEXT;
export const PI_MAIN_BRANCH = "main";
export const PENDING_ENTRY_ID_PREFIX = "pending:";
export const ActiveConversation = defineDoc({ kind: "carmel.active", version: 1, scope: "session", initial: () => ({ id: 0, legacyIds: {} as Record<string, number>, migrated: false as boolean }) });
export type DisplayEntry = { id: string; parentId: string | null; seq: number; timestamp: number } & ({ type: "message"; message: AgentMessage } | { type: "other"; native: EntryRecord });
export type PiSession = {
  metadata: { id: string };
  native: Harness;
  registry: Registry;
  settings: HarnessSettings;
  models: Models;
  env?: ExecutionEnv;
  conversation: Conversation;
  path: string;
  findEntries(query: { type?: string }, context: Context): Promise<DisplayEntry[]>;
};
const basePath = resolvePiDatabasePath();
const directory = `${basePath}.durable`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const leases = new Map<string, { session: PiSession; holders: number }>();
const opening = new Map<string, Promise<PiSession>>();
const closing = new Map<string, Promise<void>>();
export function durableSessionPath(id: string) { return join(directory, `${createHash("sha256").update(id).digest("hex")}.sqlite`); }

export async function openPiSession(sessionId: string): Promise<PiSession> {
  if (closing.has(sessionId)) await closing.get(sessionId);
  const held = leases.get(sessionId);
  if (held) { held.holders++; return held.session; }
  if (opening.has(sessionId)) { await opening.get(sessionId); return openPiSession(sessionId); }
  if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get()) throw new SessionEntryNotFoundError(`session ${sessionId}`);
  const attempt = openNative(sessionId);
  opening.set(sessionId, attempt);
  try { const session = await attempt; leases.set(sessionId, { session, holders: 1 }); return session; }
  finally { opening.delete(sessionId); }
}
async function openNative(id: string): Promise<PiSession> {
  const path = durableSessionPath(id);
  const registry = createRegistry();
  const state = { models: createModels() as Models, settings: {} as HarnessSettings, env: undefined as ExecutionEnv | undefined };
  // A run installs its credentials and registry before starting native scheduling.
  const models = new Proxy(state.models, { get(_target, key) { const value = Reflect.get(state.models, key, state.models); return typeof value === "function" ? value.bind(state.models) : value; } });
  const settings = new Proxy({} as HarnessSettings, { get(_target, key) { return Reflect.get(state.settings, key); } });
  const native = await Harness.open(await openNodeSqliteStorage(path), { models, registry, settings, env: () => state.env }, ctx);
  try {
    const root = await native.root(ctx);
    const session: PiSession = {
      metadata: { id }, native, registry, conversation: root, path,
      get models() { return state.models; }, set models(value) { state.models = value; },
      get settings() { return state.settings; }, set settings(value) { state.settings = value; },
      get env() { return state.env; }, set env(value) { state.env = value; },
      async findEntries(query) {
        const entries = new Map<number, EntryRecord>();
        await native.commit(async tx => {
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanConversations({}, 100, cursor);
            for (const conversation of page.items) for (const entry of await scanEntries(tx, conversation.id)) entries.set(entry.id, entry);
            cursor = page.next;
          } while (cursor);
        }, ctx);
        return displayEntries([...entries.values()].sort((a,b) => a.id-b.id)).filter(e => !query.type || e.type === query.type);
      },
    };
    const active = await native.snapshot(ActiveConversation, ctx);
    if (!active?.migrated) await migrateLegacyPiSession(session, basePath);
    const saved = await native.snapshot(ActiveConversation, ctx);
    session.conversation = saved?.id ? (await native.conversation(saved.id as ConversationId, ctx))! : root;
    return session;
  } catch (error) { await native.close(ctx); throw error; }
}
export async function closePiSession(session: PiSession) {
  const lease = leases.get(session.metadata.id);
  if (!lease || lease.session !== session) return;
  if (--lease.holders > 0) return;
  leases.delete(session.metadata.id);
  const closed = session.native.close(ctx);
  closing.set(session.metadata.id, closed);
  try { await closed; } finally { closing.delete(session.metadata.id); }
}
export async function withPiSession<T>(sessionId: string, operation: (session: PiSession) => Promise<T>) {
  const session = await openPiSession(sessionId);
  try { return await operation(session); } finally { await closePiSession(session); }
}
export async function scanEntries(tx: Tx, id: ConversationId): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
  do { const page = await tx.scanEntries({ conversationId: id }, 500, cursor); entries.push(...page.items); cursor = page.next; } while (cursor);
  return entries.reverse();
}
export function displayId(entry: EntryRecord): string {
  const data = entry.data as { carmelEntryId?: string } | undefined;
  return data?.carmelEntryId ?? `durable:${entry.id}`;
}
export function displayEntries(entries: readonly EntryRecord[]): DisplayEntry[] {
  return entries.map((entry, index) => {
    const data = entry.data as { carmelMessage?: AgentMessage; timestamp?: number; legacy?: { type: string } } | undefined;
    const message = data?.carmelMessage ?? ((!data?.legacy || data.legacy.type === "message") && entry.kind !== "pi.compaction" && entry.kind !== "pi.system" && entry.kind !== "pi.reset" ? entry.model?.[0] : undefined);
    const base = { id: displayId(entry), parentId: index ? displayId(entries[index - 1]!) : null, seq: entry.id, timestamp: Number(data?.timestamp ?? (message && "timestamp" in message ? message.timestamp : 0)) };
    return message ? { ...base, type: "message", message: message as AgentMessage } : { ...base, type: "other", native: entry };
  });
}
export function messageDraft(message: AgentMessage): EntryDraft {
  const safe = JSON.parse(JSON.stringify(message)) as AgentMessage;
  return ["user", "assistant", "toolResult", "system"].includes(safe.role)
    ? { kind: safe.role === "system" ? "carmel.system-message" : `pi.${safe.role === "toolResult" ? "tool-result" : safe.role}`, model: [safe as Message] }
    : { kind: "carmel.message", data: { carmelMessage: safe as unknown as JsonValue } };
}
export async function resolveEntryId(session: PiSession, id: string): Promise<EntryId> {
  const legacy = (await session.native.snapshot(ActiveConversation, ctx))?.legacyIds[id];
  const number = legacy ?? (/^durable:\d+$/.test(id) ? Number(id.slice(8)) : NaN);
  if (!Number.isSafeInteger(number)) throw new SessionEntryNotFoundError(id);
  return number as EntryId;
}
export async function readPiSessionBranch(session: PiSession): Promise<DisplayEntry[]> {
  // Read history and progress on one serialized commit line, preventing reconnect gaps.
  const { entries, live } = await session.conversation.commit(async tx => {
    const entries = await scanEntries(tx, session.conversation.id);
    const live = JSON.parse(JSON.stringify(await tx.doc(LiveDoc, session.conversation.id))) as import("@earendil-works/pi-durable").LiveState;
    return { entries, live };
  }, ctx);
  const displayed = displayEntries(entries);
  const partial = live?.generation?.message;
  if (partial) displayed.push({ id: `${PENDING_ENTRY_ID_PREFIX}${live.run?.taskId ?? session.conversation.id}`, parentId: displayed.at(-1)?.id ?? null, seq: (displayed.at(-1)?.seq ?? 0)+1, timestamp: partial.timestamp, type: "message", message: partial as unknown as AgentMessage });
  return displayed;
}
export async function appendPiMessage(session: PiSession, message: AgentMessage) {
  return displayId(await session.conversation.commit(tx => tx.appendEntry(session.conversation.id, messageDraft(message)), ctx));
}
export async function navigatePiSession(session: PiSession, id: string | null) {
  const entryId = id === null ? undefined : await resolveEntryId(session, id);
  const agent = await session.native.snapshot(AgentDoc, session.conversation.id, ctx);
  const conversationId = await session.native.commit(async tx => {
    const entry = entryId === undefined ? undefined : await tx.entry(entryId);
    if (entryId !== undefined && !entry) throw new SessionEntryNotFoundError(id!);
    const next = entry ? await tx.forkConversation(entry.conversationId, entry.id, { ownership: { kind: "ownerless" } }) : await tx.createConversation({ ownership: { kind: "ownerless" } });
    if (agent) Object.assign(await tx.doc(AgentDoc, next.id), structuredClone(agent));
    (await tx.doc(ActiveConversation)).id = next.id;
    return next.id;
  }, ctx);
  session.conversation = (await session.native.conversation(conversationId, ctx))!;
}
export async function replacePiSessionMessages(sessionId: string, messages: AgentMessage[]) {
  await withPiSession(sessionId, async session => {
    await navigatePiSession(session, null);
    await session.conversation.commit(async tx => { for (const message of messages) await tx.appendEntry(session.conversation.id, messageDraft(message)); }, ctx);
  });
}
export async function readPiSessionMessageEntry(sessionId: string, id: string) {
  return withPiSession(sessionId, async session => {
    let nativeId: EntryId;
    try { nativeId = await resolveEntryId(session, id); } catch (error) { if (error instanceof SessionEntryNotFoundError) return undefined; throw error; }
    const entry = await session.native.commit(tx => tx.entry(nativeId), ctx);
    const display = entry && displayEntries([entry])[0];
    return display?.type === "message" ? display.message : undefined;
  });
}
export async function movePiSessionToEntry(sessionId: string, id: string) { return withPiSession(sessionId, session => navigatePiSession(session, id)); }
export async function rewritePiSessionMessage(sessionId: string, id: string, message: AgentMessage, truncate: boolean) {
  return withPiSession(sessionId, async session => {
    const targetId = await resolveEntryId(session, id);
    const agent = await session.native.snapshot(AgentDoc, session.conversation.id, ctx);
    const result = await session.native.commit(async tx => {
      const entries = await scanEntries(tx, session.conversation.id);
      const index = entries.findIndex(e => e.id === targetId);
      if (index < 0 || displayEntries([entries[index]!])[0]?.type !== "message") throw new SessionEntryNotFoundError(id);
      const next = index ? await tx.forkConversation(session.conversation.id, entries[index-1]!.id, { ownership: { kind: "ownerless" } }) : await tx.createConversation({ ownership: { kind: "ownerless" } });
      if (agent) Object.assign(await tx.doc(AgentDoc, next.id), structuredClone(agent));
      const replacement = await tx.appendEntry(next.id, messageDraft(message));
      const remaps = new Map<number, EntryId>([[targetId, replacement.id]]);
      if (!truncate) for (const entry of entries.slice(index + 1)) {
        const { id: oldId, conversationId: _conversation, byTaskId: _task, ...draft } = entry;
        let copy: EntryDraft = { ...draft, ...(draft.head ? { head: remaps.get(draft.head) ?? draft.head } : {}), ...(draft.edits ? { edits: draft.edits.map(edit => ({ ...edit, target: remaps.get(edit.target) ?? edit.target })) } : {}) };
        if (copy.data && typeof copy.data === "object" && !Array.isArray(copy.data)) {
          const { carmelEntryId: _oldDisplayId, ...data } = copy.data;
          copy = { ...copy, data };
        }
        const appended = await tx.appendEntry(next.id, copy); remaps.set(oldId, appended.id);
      }
      (await tx.doc(ActiveConversation)).id = next.id;
      return { conversation: next.id, entry: displayId(replacement) };
    }, ctx);
    session.conversation = (await session.native.conversation(result.conversation, ctx))!;
    return result.entry;
  });
}
export async function forkPiSession(sourceId: string, targetId: string, id: string) {
  await withPiSession(sourceId, async source => {
    await resolveEntryId(source, id);
    const work = await source.native.inspect(ctx);
    if (work.tasks.length || work.submissions.length) throw new Error("Resume or stop pending Durable work before forking this session.");
    const targetPath = durableSessionPath(targetId);
    if (existsSync(targetPath)) throw new Error("Fork target storage already exists.");
    // SQLite makes a consistent snapshot including WAL; copying the file cannot do that.
    const snapshot = new Database(source.path);
    try { snapshot.prepare("VACUUM INTO ?").run(targetPath); } finally { snapshot.close(); }
    try { await withPiSession(targetId, target => navigatePiSession(target, id)); }
    catch (error) { rmSync(targetPath, { force: true }); throw error; }
  });
}
export async function hasPendingPiSessionWork(sessionId: string) {
  return withPiSession(sessionId, async session => {
    const work = await session.native.inspect(ctx);
    return Boolean(work.tasks.length || work.submissions.length);
  });
}
export async function deletePiSession(session: typeof sessions.$inferSelect) {
  if (leases.has(session.id)) throw new Error("Cannot delete an open Pi session.");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${durableSessionPath(session.id)}${suffix}`, { force: true });
}
export async function deletePiSessions(records: Array<typeof sessions.$inferSelect>) { for (const record of records) await deletePiSession(record); }
export class SessionEntryNotFoundError extends Error { constructor(id: string) { super(`Message entry ${id} not found`); this.name = "SessionEntryNotFoundError"; } }
function resolvePiDatabasePath() {
  const configured = process.env.CARMEL_PI_SESSION_DATABASE_URL;
  if (configured && configured !== ":memory:") return resolve(configured.replace(/^file:/, ""));
  if (process.env.DATABASE_URL === ":memory:" || configured === ":memory:") return join(mkdtempSync(join(tmpdir(), "carmel-pi-sessions-")), "sessions.sqlite");
  return join(dataDir, "pi-sessions.sqlite");
}
