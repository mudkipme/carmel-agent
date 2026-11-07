import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  homeMemoryInputSchema,
  homeMemoryPatchSchema,
  homeMemorySettingsSchema,
  type HomeMemory,
  type HomeMemoryInput,
  type HomeMemoryOverview,
  type HomeMemoryPatch,
  type HomeMemoryRevision,
} from "@carmel-agent/shared";
import { db, sqlite } from "../db/index.ts";
import {
  homeMemories,
  homeMemorySettings,
  homeMemoryRevisions,
  homeMemoryCaptures,
  agentSecrets,
} from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { HomeError } from "./agent-homes.ts";
import { revealSecret } from "../security.ts";
import { readVisibleAgent } from "./agent-access.ts";
import { knowledgeEmbeddingModel } from "../runtime/knowledge/models.ts";
import { emptyMemoryIndexStatus, purgeHomeMemoryIndex } from "./home-memory-index.ts";
import { homeMemoryForgettingRule, matchesForgottenMemory } from "./home-memory-forgetting.ts";

import {
  HOME_MEMORY_MAX_LINES,
  HOME_MEMORY_MAX_BYTES,
  homeMemoryNotebookFits,
  homeMemoryNotebookSize,
} from "./home-memory-notebook.ts";
const owner = (userId: string, agentId: string) =>
  and(eq(homeMemories.userId, userId), eq(homeMemories.agentId, agentId));
const settingsOwner = (userId: string, agentId: string) =>
  and(eq(homeMemorySettings.userId, userId), eq(homeMemorySettings.agentId, agentId));
export const memoryIdentity = (text: string) =>
  text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
const queryStopWords = new Set(
  "a an and are as at be been but by can could did do does for from had has have help how i if in into is it its me my of on or our please say should show some tell that the their them then there these they this those to us use user was we were what when where which who why will with would you your about remember memory know status".split(
    " ",
  ),
);
export const memoryTokens = (
  memory: Pick<HomeMemory, "content" | "scope"> & Partial<Pick<HomeMemory, "id" | "revision">>,
) =>
  estimateTextTokens(
    JSON.stringify({
      id: memory.id,
      revision: memory.revision,
      scope: memory.scope,
      content: memory.content,
    }),
  );

export function readHomeMemorySettings(userId: string, agentId: string) {
  if (!readVisibleAgent(userId, agentId)) throw new HomeError("Agent not found.", 404);
  db.insert(homeMemorySettings).values({ userId, agentId }).onConflictDoNothing().run();
  return db.select().from(homeMemorySettings).where(settingsOwner(userId, agentId)).get()!;
}

export function isHomeMemoryForgotten(
  userId: string,
  agentId: string,
  fact: { content: string; scope: string; slot?: string },
) {
  const fingerprint = homeMemoryForgettingRule(fact);
  return readHomeMemorySettings(userId, agentId).forgotten.some((rule) =>
    matchesForgottenMemory(rule, fingerprint),
  );
}

function allowHomeMemoryAgain(
  userId: string,
  agentId: string,
  fact: { content: string; scope: string; slot?: string },
) {
  const settings = readHomeMemorySettings(userId, agentId);
  const fingerprint = homeMemoryForgettingRule(fact);
  const forgotten = settings.forgotten.filter((rule) => !matchesForgottenMemory(rule, fingerprint));
  if (forgotten.length !== settings.forgotten.length)
    db.update(homeMemorySettings).set({ forgotten }).where(settingsOwner(userId, agentId)).run();
}

export function invalidateHomeCapture(userId: string, agentId: string) {
  db.update(homeMemorySettings)
    .set({ generation: sql`${homeMemorySettings.generation} + 1` })
    .where(settingsOwner(userId, agentId))
    .run();
}

export function setHomeMemorySettings(userId: string, agentId: string, input: unknown) {
  const value = homeMemorySettingsSchema.parse(input);
  const previous = readHomeMemorySettings(userId, agentId);
  const mode = value.mode ?? previous.mode;
  const retrieval = value.retrieval ?? previous.retrieval;
  const modeChanged = previous.mode !== mode;
  const retrievalChanged = JSON.stringify(retrieval) !== JSON.stringify(previous.retrieval);
  if (!modeChanged && !retrievalChanged) return previous;
  db.update(homeMemorySettings)
    .set({
      mode,
      retrieval,
      ...(modeChanged
        ? { learnAfter: now(), generation: previous.generation + 1, error: null }
        : {}),
      ...(retrievalChanged ? { indexStatus: null, indexDirty: true } : {}),
    })
    .where(settingsOwner(userId, agentId))
    .run();
  return readHomeMemorySettings(userId, agentId);
}

export function rejectHomeMemorySecrets(agentId: string, text: string) {
  const known = db
    .select({ value: agentSecrets.value })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentId))
    .all();
  if (
    /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?|gh[pousr]_)[\w-]{16,}|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/iu.test(
      text,
    ) ||
    known.some(({ value }) => {
      const secret = revealSecret(value);
      return secret && secret.length >= 4 && text.includes(secret);
    })
  ) {
    throw new HomeError("Store credentials in Secrets, not Home memory.", 400);
  }
}

export function serializeHomeMemory(row: typeof homeMemories.$inferSelect): HomeMemory {
  const { userId: _user, agentId: _agent, slot: _slot, ...memory } = row;
  return memory;
}

function requireMemory(userId: string, agentId: string, memoryId: string) {
  readHomeMemorySettings(userId, agentId);
  const row = db
    .select()
    .from(homeMemories)
    .where(and(owner(userId, agentId), eq(homeMemories.id, memoryId)))
    .get();
  if (!row) throw new HomeError("Memory not found.", 404);
  return row;
}

export function readHomeMemory(userId: string, agentId: string, memoryId: string) {
  return serializeHomeMemory(requireMemory(userId, agentId, memoryId));
}

export function activeHomeMemories(userId: string, agentId: string) {
  readHomeMemorySettings(userId, agentId);
  return db
    .select()
    .from(homeMemories)
    .where(
      and(
        owner(userId, agentId),
        sql`(${homeMemories.expiresAt} IS NULL OR ${homeMemories.expiresAt} > ${now()})`,
      ),
    )
    .orderBy(desc(homeMemories.pinned), desc(homeMemories.updatedAt), homeMemories.id)
    .all();
}

export function coreHomeMemories(userId: string, agentId: string) {
  return activeHomeMemories(userId, agentId)
    .filter((note) => note.pinned || note.placement === "core")
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
}

function availablePlacement(
  userId: string,
  agentId: string,
  value: {
    id: string;
    revision: number;
    content: string;
    scope: string;
    placement: HomeMemory["placement"];
    expiresAt: number | null;
  },
  automatic: boolean,
) {
  if (value.placement !== "core" || (value.expiresAt !== null && value.expiresAt <= now()))
    return value.placement;
  const existing = coreHomeMemories(userId, agentId).filter((note) => note.id !== value.id);
  if (homeMemoryNotebookFits([...existing, value])) return "core";
  if (automatic) return "topic";
  throw new HomeError(
    "Core memory is limited to 200 lines / 24,000 bytes. Shorten a note or move a core note to topics first.",
    400,
  );
}

function reservePinnedContext(userId: string, agentId: string) {
  const rank = { preference: 0, fact: 1, decision: 2 };
  const notes = coreHomeMemories(userId, agentId).sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(a.origin === "automatic") - Number(b.origin === "automatic") ||
      rank[a.kind] - rank[b.kind] ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
  const kept: typeof notes = [];
  for (const note of notes) {
    if (homeMemoryNotebookFits([...kept, note])) {
      kept.push(note);
      continue;
    }
    const updated = db
      .update(homeMemories)
      .set({ placement: "topic", revision: note.revision + 1, updatedAt: now() })
      .where(eq(homeMemories.id, note.id))
      .returning()
      .get()!;
    saveRevision(updated);
  }
}

export function homeMemoryQueryTerms(query: string) {
  return [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter(
        (term) => !queryStopWords.has(term),
      ),
    ),
  ].slice(0, 12);
}

export function searchHomeMemories(
  userId: string,
  agentId: string,
  query: string,
  limit = 20,
): HomeMemory[] {
  readHomeMemorySettings(userId, agentId);
  const terms = homeMemoryQueryTerms(query);
  if (!terms.length) return [];
  const ids = sqlite
    .prepare(`SELECT m.id FROM home_memory_search f JOIN home_memories m ON m.id = f.memory_id
    WHERE home_memory_search MATCH ? AND m.user_id = ? AND m.agent_id = ? AND (m.expires_at IS NULL OR m.expires_at > ?)
    ORDER BY rank, m.id LIMIT ?`)
    .all(
      terms.map((term) => `"${term}"`).join(" OR "),
      userId,
      agentId,
      now(),
      Math.min(20, Math.max(1, limit)),
    ) as Array<{ id: string }>;
  return ids
    .map(({ id: memoryId }) => serializeHomeMemory(requireMemory(userId, agentId, memoryId)))
    .filter((note) => {
      const words = new Set(
        `${note.title} ${note.scope} ${note.content} ${note.aliases.join(" ")}`
          .toLowerCase()
          .match(/[\p{L}\p{N}_-]{2,}/gu),
      );
      return terms.filter((term) => words.has(term)).length >= (terms.length >= 5 ? 2 : 1);
    });
}

export function readHomeMemoryOverview(
  userId: string,
  agentId: string,
  query = "",
  offset = 0,
): HomeMemoryOverview {
  const settings = readHomeMemorySettings(userId, agentId);
  const rows = db
    .select()
    .from(homeMemories)
    .where(owner(userId, agentId))
    .orderBy(desc(homeMemories.pinned), desc(homeMemories.updatedAt), homeMemories.id)
    .all();
  rows.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.placement === "core") - Number(a.placement === "core") ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  const core = coreHomeMemories(userId, agentId);
  const matches = rows.filter((row) =>
    memoryIdentity(`${row.title} ${row.scope} ${row.content} ${row.aliases.join(" ")}`).includes(
      memoryIdentity(query),
    ),
  );
  return {
    mode: settings.mode,
    retrieval: settings.retrieval,
    indexStatus: settings.retrieval.enabled
      ? (settings.indexStatus ?? emptyMemoryIndexStatus)
      : { ...emptyMemoryIndexStatus, state: "disabled" },
    embeddingModel: knowledgeEmbeddingModel(),
    memories: matches.slice(offset, offset + 50).map(serializeHomeMemory),
    total: matches.length,
    coreIds: core.map((note) => note.id),
    coreLines: homeMemoryNotebookSize(core).lines,
    coreBytes: homeMemoryNotebookSize(core).bytes,
    coreMaxLines: HOME_MEMORY_MAX_LINES,
    coreMaxBytes: HOME_MEMORY_MAX_BYTES,
    lastCaptureAt: settings.lastCaptureAt,
    lastCapture: settings.lastCapture ?? null,
    error: settings.error,
  };
}

function saveRevision(row: typeof homeMemories.$inferSelect) {
  const snapshot: HomeMemoryRevision = {
    revision: row.revision,
    content: row.content,
    title: row.title,
    scope: row.scope,
    kind: row.kind,
    placement: row.placement,
    aliases: row.aliases,
    expiresAt: row.expiresAt,
    createdAt: row.updatedAt,
  };
  db.insert(homeMemoryRevisions)
    .values({ memoryId: row.id, revision: row.revision, snapshot })
    .run();
  db.delete(homeMemoryRevisions)
    .where(
      and(
        eq(homeMemoryRevisions.memoryId, row.id),
        sql`${homeMemoryRevisions.revision} <= ${row.revision - 20}`,
      ),
    )
    .run();
}

export function saveHomeMemory(
  userId: string,
  agentId: string,
  input: HomeMemoryInput,
  source?: {
    origin: "explicit" | "automatic";
    eventId: string;
    entryId: string | null;
    quote: string;
    slot?: string;
  },
) {
  const value = homeMemoryInputSchema.parse(input);
  readHomeMemorySettings(userId, agentId);
  rejectHomeMemorySecrets(
    agentId,
    `${value.title}\n${value.scope}\n${value.content}\n${value.aliases.join(" ")}\n${source?.quote ?? ""}`,
  );
  const existing = activeHomeMemories(userId, agentId).find(
    (row) =>
      memoryIdentity(row.content) === memoryIdentity(value.content) &&
      memoryIdentity(row.scope) === memoryIdentity(value.scope),
  );
  if (existing) {
    if (
      source?.origin !== "automatic" &&
      (existing.origin === "automatic" ||
        (input.placement !== undefined && existing.placement !== value.placement))
    )
      return editHomeMemory(userId, agentId, existing.id, {
        expectedRevision: existing.revision,
        content: value.content,
        title: input.title ?? existing.title,
        scope: value.scope,
        kind: value.kind,
        placement: input.placement ?? existing.placement,
        aliases: input.aliases ?? existing.aliases,
        expiresAt: value.expiresAt,
      });
    if (source?.origin !== "automatic") allowHomeMemoryAgain(userId, agentId, existing);
    return serializeHomeMemory(existing);
  }
  return db.transaction(() => {
    const stamp = now();
    const memoryId = id("memory");
    const placement = availablePlacement(
      userId,
      agentId,
      { ...value, id: memoryId, revision: 1 },
      source?.origin === "automatic",
    );
    const row = db
      .insert(homeMemories)
      .values({
        id: memoryId,
        userId,
        agentId,
        ...value,
        placement,
        origin: source?.origin ?? "manual",
        contributorId: userId,
        slot: source?.slot ?? "",
        sourceEventId: source?.eventId ?? null,
        sourceEntryId: source?.entryId ?? null,
        sourceQuote: source?.quote.slice(0, 2000) ?? null,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    saveRevision(row);
    if (source?.origin !== "automatic") allowHomeMemoryAgain(userId, agentId, row);
    // An explicit save needs no invalidation: a pending batch that learns the same
    // fact later already loses on slot dedupe, so discarding the queue would only
    // throw away learning that has nothing to do with this note.
    return serializeHomeMemory(row);
  });
}

export function editHomeMemory(
  userId: string,
  agentId: string,
  memoryId: string,
  input: HomeMemoryPatch,
) {
  const { expectedRevision, ...patch } = homeMemoryPatchSchema.parse(input);
  const row = requireMemory(userId, agentId, memoryId);
  if (expectedRevision !== row.revision)
    throw new HomeError("This memory changed. Reload it before saving.", 409);
  const value = { ...row, ...patch };
  rejectHomeMemorySecrets(
    agentId,
    `${value.title}\n${value.scope}\n${value.content}\n${value.aliases.join(" ")}`,
  );
  if (value.pinned && (value.expiresAt === null || value.expiresAt > now())) {
    const pinned = activeHomeMemories(userId, agentId).filter(
      (note) => note.pinned && note.id !== memoryId,
    );
    if (!homeMemoryNotebookFits([...pinned, { ...value, revision: row.revision + 1 }]))
      throw new HomeError(
        "Pinned memory is limited to 200 lines / 24,000 bytes. Unpin or shorten a note first.",
        400,
      );
  }
  if (!value.pinned)
    availablePlacement(userId, agentId, { ...value, revision: row.revision + 1 }, false);
  return db.transaction(() => {
    const contentChanged =
      patch.content !== undefined ||
      patch.title !== undefined ||
      patch.scope !== undefined ||
      patch.kind !== undefined;
    const updated = db
      .update(homeMemories)
      .set({
        ...patch,
        revision: row.revision + 1,
        updatedAt: now(),
        ...(contentChanged
          ? ({
              origin: "manual",
              sourceEventId: null,
              sourceEntryId: null,
              sourceQuote: null,
            } as const)
          : {}),
        ...(patch.placement !== undefined ||
        patch.pinned !== undefined ||
        patch.aliases !== undefined ||
        patch.expiresAt !== undefined
          ? { origin: "manual" as const }
          : {}),
      })
      .where(eq(homeMemories.id, memoryId))
      .returning()
      .get()!;
    saveRevision(updated);
    if (patch.content !== undefined) allowHomeMemoryAgain(userId, agentId, updated);
    if (updated.pinned) reservePinnedContext(userId, agentId);
    invalidateHomeCapture(userId, agentId);
    return serializeHomeMemory(updated);
  });
}

export async function forgetHomeMemory(
  userId: string,
  agentId: string,
  memoryId?: string,
  expectedRevision?: number,
  preventLearning = true,
) {
  const settings = readHomeMemorySettings(userId, agentId);
  if (memoryId) {
    const note = requireMemory(userId, agentId, memoryId);
    if (expectedRevision !== undefined && note.revision !== expectedRevision)
      throw new HomeError("This memory changed. Review it before forgetting.", 409);
  }
  db.transaction(() => {
    if (preventLearning) {
      const notes = db
        .select()
        .from(homeMemories)
        .where(and(owner(userId, agentId), memoryId ? eq(homeMemories.id, memoryId) : undefined))
        .all();
      const rules = new Map(settings.forgotten.map((rule) => [rule.contentHash, rule]));
      for (const note of notes) {
        const rule = homeMemoryForgettingRule(note);
        rules.set(rule.contentHash, rule);
      }
      db.update(homeMemorySettings)
        .set({ forgotten: [...rules.values()] })
        .where(settingsOwner(userId, agentId))
        .run();
    }
    db.delete(homeMemories)
      .where(and(owner(userId, agentId), memoryId ? eq(homeMemories.id, memoryId) : undefined))
      .run();
    invalidateHomeCapture(userId, agentId);
  });
  if (settings.retrieval.enabled || settings.indexStatus)
    await purgeHomeMemoryIndex(userId, agentId);
}

export function homeMemoryHistory(userId: string, agentId: string, memoryId: string) {
  requireMemory(userId, agentId, memoryId);
  return db
    .select()
    .from(homeMemoryRevisions)
    .where(eq(homeMemoryRevisions.memoryId, memoryId))
    .orderBy(desc(homeMemoryRevisions.revision))
    .limit(20)
    .all()
    .map((row) => row.snapshot);
}

export function restoreHomeMemory(
  userId: string,
  agentId: string,
  memoryId: string,
  revision: number,
  expectedRevision: number,
) {
  const previous = homeMemoryHistory(userId, agentId, memoryId).find(
    (row) => row.revision === revision,
  );
  if (!previous) throw new HomeError("Revision not found.", 404);
  return editHomeMemory(userId, agentId, memoryId, {
    expectedRevision,
    content: previous.content,
    title: previous.title ?? "",
    scope: previous.scope,
    kind: previous.kind,
    placement: previous.placement ?? "topic",
    aliases: previous.aliases ?? [],
    expiresAt: previous.expiresAt,
  });
}

export function invalidateHomeMemorySources(sessionId: string, entryIds: string[]) {
  const rows = sqlite
    .prepare("SELECT user_id AS userId, agent_id AS agentId FROM agent_homes WHERE session_id = ?")
    .get(sessionId) as { userId: string; agentId: string } | undefined;
  if (!rows) return;
  db.transaction(() => {
    if (entryIds.length) {
      db.delete(homeMemories)
        .where(
          and(
            owner(rows.userId, rows.agentId),
            eq(homeMemories.origin, "automatic"),
            inArray(homeMemories.sourceEntryId, entryIds),
          ),
        )
        .run();
      // Only the edited messages lose their pending capture. Everything else keeps
      // learning; the commit step checks each event on its own.
      db.update(homeMemoryCaptures)
        .set({ status: "skipped" })
        .where(inArray(homeMemoryCaptures.entryId, entryIds))
        .run();
    }
  });
}

export function updateAutomaticHomeMemory(
  userId: string,
  agentId: string,
  memoryId: string,
  expectedRevision: number,
  input: HomeMemoryInput,
  source: { eventId: string; entryId: string; quote: string; slot: string },
) {
  const row = requireMemory(userId, agentId, memoryId);
  if (row.origin !== "automatic" || row.pinned || row.revision !== expectedRevision)
    return undefined;
  const value = homeMemoryInputSchema.parse(input);
  const placement = availablePlacement(
    userId,
    agentId,
    { ...value, id: memoryId, revision: row.revision + 1 },
    true,
  );
  rejectHomeMemorySecrets(
    agentId,
    `${value.content}\n${value.scope}\n${value.aliases.join(" ")}\n${source.quote}`,
  );
  const updated = db
    .update(homeMemories)
    .set({
      ...value,
      placement,
      sourceEventId: source.eventId,
      sourceEntryId: source.entryId,
      sourceQuote: source.quote,
      slot: source.slot,
      revision: row.revision + 1,
      updatedAt: now(),
    })
    .where(eq(homeMemories.id, memoryId))
    .returning()
    .get()!;
  saveRevision(updated);
  return serializeHomeMemory(updated);
}

export function placeAutomaticHomeMemory(
  userId: string,
  agentId: string,
  memoryId: string,
  expectedRevision: number,
  placement: HomeMemory["placement"],
  metadata: { scope?: string; aliases?: string[] } = {},
) {
  const row = requireMemory(userId, agentId, memoryId);
  if (row.origin !== "automatic" || row.pinned || row.revision !== expectedRevision)
    return undefined;
  const next = availablePlacement(
    userId,
    agentId,
    { ...row, scope: metadata.scope ?? row.scope, revision: row.revision + 1, placement },
    true,
  );
  if (
    next === row.placement &&
    (metadata.scope === undefined || metadata.scope === row.scope) &&
    (metadata.aliases === undefined ||
      JSON.stringify(metadata.aliases) === JSON.stringify(row.aliases))
  )
    return undefined;
  rejectHomeMemorySecrets(
    agentId,
    `${metadata.scope ?? row.scope}\n${(metadata.aliases ?? row.aliases).join(" ")}`,
  );
  const updated = db
    .update(homeMemories)
    .set({ ...metadata, placement: next, revision: row.revision + 1, updatedAt: now() })
    .where(eq(homeMemories.id, memoryId))
    .returning()
    .get()!;
  saveRevision(updated);
  return serializeHomeMemory(updated);
}
