import {
  Session,
  SessionError,
  uuidv7,
  type AgentMessage,
  type SessionEntryCursorOptions,
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { now } from "../db/seed.ts";

export type CarmelPiSessionMetadata = SessionMetadata & {
  userId: string;
  agentId: string;
};

type StoredEntryRow = {
  seq: number;
  entry: string;
};

function parseEntry(row: StoredEntryRow): SessionTreeEntry {
  try {
    const entry = JSON.parse(row.entry) as SessionTreeEntry;
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.type !== "string") {
      throw new Error("entry is not an object with an id and type");
    }
    return entry;
  } catch (error) {
    throw new SessionError(
      "invalid_entry",
      `Invalid SQLite session entry at sequence ${row.seq}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readStoredEntries(sessionId: string): SessionTreeEntry[] {
  return (sqlite
    .prepare("SELECT seq, entry FROM pi_session_entries WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as StoredEntryRow[]).map(parseEntry);
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

function timestampMillis(entry: SessionTreeEntry): number {
  const value = Date.parse(entry.timestamp);
  return Number.isFinite(value) ? value : now();
}

function insertEntries(sessionId: string, entries: SessionTreeEntry[]): void {
  if (entries.length === 0) return;
  const transaction = sqlite.transaction(() => {
    const nextSeqRow = sqlite
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM pi_session_entries WHERE session_id = ?")
      .get(sessionId) as { seq: number };
    const hasEntry = sqlite.prepare(
      "SELECT 1 FROM pi_session_entries WHERE session_id = ? AND entry_id = ? LIMIT 1",
    );
    const insert = sqlite.prepare(`
      INSERT INTO pi_session_entries
        (session_id, entry_id, seq, parent_id, entry_type, entry, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let seq = nextSeqRow.seq;
    for (const entry of entries) {
      if (hasEntry.get(sessionId, entry.id)) {
        throw new SessionError("invalid_entry", `Duplicate entry id ${entry.id}`);
      }
      insert.run(
        sessionId,
        entry.id,
        seq++,
        entry.parentId,
        entry.type,
        JSON.stringify(entry),
        timestampMillis(entry),
      );
    }
  });
  transaction();
}

function findLeafId(entries: SessionTreeEntry[]): string | null {
  let leafId: string | null = null;
  for (const entry of entries) leafId = leafIdAfterEntry(entry);
  return leafId;
}

export function readActivePiSessionBranch(sessionId: string): SessionTreeEntry[] {
  const entries = readStoredEntries(sessionId);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leafId = findLeafId(entries);
  if (leafId === null) return [];
  const branch: SessionTreeEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(leafId);
  if (!current) throw new SessionError("invalid_session", `Entry ${leafId} not found`);
  while (current) {
    if (visited.has(current.id)) throw new SessionError("invalid_session", `Cycle at entry ${current.id}`);
    visited.add(current.id);
    branch.unshift(current);
    if (!current.parentId) break;
    const parent = byId.get(current.parentId);
    if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
    current = parent;
  }
  return branch;
}

export function replacePiSessionMessages(sessionId: string, messages: AgentMessage[]): void {
  if (messages.length === 0) {
    const entries = readStoredEntries(sessionId);
    insertEntries(sessionId, [
      {
        type: "leaf",
        id: uuidv7(),
        parentId: findLeafId(entries),
        timestamp: new Date().toISOString(),
        targetId: null,
      },
    ]);
    return;
  }
  let parentId: string | null = null;
  const entries: SessionTreeEntry[] = messages.map((message) => {
    const entry: SessionTreeEntry = {
      type: "message",
      id: uuidv7(),
      parentId,
      timestamp: new Date().toISOString(),
      message,
    };
    parentId = entry.id;
    return entry;
  });
  insertEntries(sessionId, entries);
}

export class SqliteSessionStorage implements SessionStorage<CarmelPiSessionMetadata> {
  constructor(readonly sessionId: string) {}

  async getMetadata(): Promise<CarmelPiSessionMetadata> {
    const record = db.select().from(sessions).where(eq(sessions.id, this.sessionId)).get();
    if (!record) throw new SessionError("not_found", `Session ${this.sessionId} not found`);
    return {
      id: record.id,
      createdAt: new Date(record.createdAt).toISOString(),
      userId: record.userId,
      agentId: record.agentId,
    };
  }

  async getLeafId(): Promise<string | null> {
    const entries = readStoredEntries(this.sessionId);
    const leafId = findLeafId(entries);
    if (leafId !== null && !entries.some((entry) => entry.id === leafId)) {
      throw new SessionError("invalid_session", `Entry ${leafId} not found`);
    }
    return leafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !(await this.getEntry(leafId))) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    const entry: SessionTreeEntry = {
      type: "leaf",
      id: await this.createEntryId(),
      parentId: await this.getLeafId(),
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };
    insertEntries(this.sessionId, [entry]);
  }

  async createEntryId(): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const entryId = uuidv7();
      if (!(await this.getEntry(entryId))) return entryId;
    }
    throw new SessionError("storage", "Unable to allocate a unique session entry id");
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    insertEntries(this.sessionId, [entry]);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const row = sqlite
      .prepare("SELECT seq, entry FROM pi_session_entries WHERE session_id = ? AND entry_id = ?")
      .get(this.sessionId, id) as StoredEntryRow | undefined;
    return row ? parseEntry(row) : undefined;
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const rows = sqlite
      .prepare("SELECT seq, entry FROM pi_session_entries WHERE session_id = ? AND entry_type = ? ORDER BY seq")
      .all(this.sessionId, type) as StoredEntryRow[];
    return rows.map(parseEntry) as Array<Extract<SessionTreeEntry, { type: TType }>>;
  }

  async getLabel(id: string): Promise<string | undefined> {
    const labels = await this.findEntries("label");
    let label: string | undefined;
    for (const entry of labels) {
      if (entry.targetId === id) label = entry.label?.trim() || undefined;
    }
    return label;
  }

  async getSessionName(): Promise<string | undefined> {
    const entries = await this.findEntries("session_info");
    return entries.at(-1)?.name?.trim() || undefined;
  }

  async getSessionStats(): Promise<SessionStats> {
    let messageCount = 0;
    let cachedTokens = 0;
    let uncachedTokens = 0;
    let totalTokens = 0;
    let costTotal = 0;
    for (const entry of readStoredEntries(this.sessionId)) {
      if (entry.type === "message") messageCount += 1;
      const usage =
        entry.type === "message"
          ? entry.message.role === "assistant"
            ? entry.message.usage
            : undefined
          : entry.type === "compaction" || entry.type === "branch_summary"
            ? entry.usage
            : undefined;
      if (
        !usage ||
        typeof usage.input !== "number" ||
        typeof usage.output !== "number" ||
        typeof usage.cacheRead !== "number" ||
        typeof usage.cacheWrite !== "number" ||
        typeof usage.cost?.total !== "number"
      )
        continue;
      cachedTokens += usage.cacheRead;
      uncachedTokens += usage.input + usage.cacheWrite;
      totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      costTotal += usage.cost.total;
    }
    return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
  }

  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const entries = readStoredEntries(this.sessionId);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const path: SessionTreeEntry[] = [];
    let stopAtEntryId: string | null = null;
    let current = byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
      if (current.type === "compaction") {
        if (current.retainedTail) break;
        stopAtEntryId = current.firstKeptEntryId ?? null;
      }
      if (!current.parentId) break;
      const parent = byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
    const entries = readStoredEntries(this.sessionId);
    const start = options?.afterEntrySeq ?? 0;
    const end = options?.limit === undefined ? undefined : start + options.limit;
    return entries.slice(start, end);
  }
}

export function openPiSession(sessionId: string): Session<CarmelPiSessionMetadata> {
  return new Session(new SqliteSessionStorage(sessionId));
}
