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

export const ABOUT_USER_SLOT_PREFIX = "about-user:";

export const isAboutUserSlot = (slot: string) => slot.startsWith(ABOUT_USER_SLOT_PREFIX);

export function formatMemorySlot(slot: string, aboutUser?: boolean) {
  const clean = isAboutUserSlot(slot) ? slot.slice(ABOUT_USER_SLOT_PREFIX.length) : slot;
  if (aboutUser === true) return `${ABOUT_USER_SLOT_PREFIX}${clean}`;
  if (aboutUser === false) return clean;
  return slot;
}

export const memoryIdentity = (text: string) =>
  text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

export function factIdentity(text: string) {
  return text
    .normalize("NFKC")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+\-./#]+/gu, " ")
    .replace(/(^|\s)-(?![\p{N}])/gu, "$1")
    .replace(/[./]+(?=\s|$)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

const queryStopWords = new Set(
  "a an and are as at be been but by can could did do does for from had has have help how i if in into is it its me my of on or our please say should show some tell that the their them then there these they this those to us use user was we were what when where which who why will with would you your about remember memory know status".split(
    " ",
  ),
);

const cjkChar = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]/u;
const hanChar = /\p{Script=Han}/u;
const cjkRuns =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]+/gu;
const cjkFiller =
  /[ーｰ]{2,}|我们|你们|他们|她们|它们|这个|那个|一下|一个|可以|时候|现在|知道|告诉|记得|还是|就是|不是|没有|已经|因为|所以|但是|如果|然后|还有|请问|帮我|怎样|这样|那样|哪里|哪个|应该|一些|什么|怎么|哪些|如何|[的了是吗呢吧啊呀哦嗯么]/gu;

const ALWAYS_CORE =
  /\b(?:allerg\w*|anaphyla\w*|intoleran\w*|vegetarian|vegan|halal|kosher|gluten|lactose|diet\w*|diabet\w*|asthma\w*|epilep\w*|pregnan\w*|medicat\w*|medicine|medical|disabilit\w*|wheelchair|blind|deaf|health)\b|(?:过敏|素食|忌口|糖尿病|哮喘|医疗|健康)/iu;

export function alwaysCoreMemory(content: string, scope = "") {
  return ALWAYS_CORE.test(`${scope} ${content}`);
}

export const hasCjk = (text: string) => cjkChar.test(text);

export function memoryQueryEffectiveLength(query: string) {
  const trimmed = query.trim();
  return trimmed.length + [...trimmed].filter(hasCjk).length;
}

export function sameMemoryWord(term: string, word: string) {
  if (term === word) return true;
  if (hasCjk(term)) return word.includes(term) || term.includes(word);
  if (term.length < 4 || word.length < 4) return false;
  const stem =
    term.length > 4 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
  const wordStem =
    word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
  if (stem === wordStem) return true;
  return (
    stem.length >= 4 &&
    (word.startsWith(stem) || (stem.startsWith(word) && stem.length - word.length <= 3))
  );
}

export function passageMatches(text: string, passage: string) {
  const normText = memoryIdentity(text);
  const normPassage = memoryIdentity(passage);
  if (!normPassage) return false;
  if (hasCjk(normPassage)) return normText.includes(normPassage);
  const escaped = normPassage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(normText);
}

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
  db.insert(homeMemorySettings)
    .values({ userId, agentId, mode: "automatic" })
    .onConflictDoNothing()
    .run();
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
  const { userId: _user, agentId: _agent, slot, ...memory } = row;
  return isAboutUserSlot(slot) ? { ...memory, aboutUser: true } : memory;
}

export function sharedAboutUserMemories(userId: string, agentId: string): HomeMemory[] {
  readHomeMemorySettings(userId, agentId);
  const own = activeHomeMemories(userId, agentId);
  const seenFacts = new Set(own.map((note) => factIdentity(note.content)).filter(Boolean));
  const seenSlots = new Set(
    own
      .map((note) =>
        isAboutUserSlot(note.slot) ? note.slot.slice(ABOUT_USER_SLOT_PREFIX.length) : note.slot,
      )
      .filter(Boolean),
  );
  const rows = db
    .select()
    .from(homeMemories)
    .where(
      and(
        eq(homeMemories.userId, userId),
        sql`${homeMemories.agentId} != ${agentId}`,
        sql`${homeMemories.slot} LIKE 'about-user:%'`,
        sql`(${homeMemories.expiresAt} IS NULL OR ${homeMemories.expiresAt} > ${now()})`,
      ),
    )
    .orderBy(desc(homeMemories.updatedAt), homeMemories.id)
    .all();
  const shared: HomeMemory[] = [];
  for (const row of rows) {
    if (!readVisibleAgent(userId, row.agentId)) continue;
    if (readHomeMemorySettings(userId, row.agentId).mode === "off") continue;
    if (isHomeMemoryForgotten(userId, agentId, row)) continue;
    const identity = factIdentity(row.content);
    const slotKey = row.slot.slice(ABOUT_USER_SLOT_PREFIX.length);
    if (!identity || seenFacts.has(identity) || (slotKey && seenSlots.has(slotKey))) continue;
    seenFacts.add(identity);
    if (slotKey) seenSlots.add(slotKey);
    shared.push(serializeHomeMemory(row));
  }
  return shared;
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
  const pinnedOnly = existing.filter((note) => note.pinned);
  if (homeMemoryNotebookFits([...pinnedOnly, value])) return "core";
  throw new HomeError(
    "Core memory is limited to 200 lines / 24,000 bytes. Shorten a note or move a core note to topics first.",
    400,
  );
}

function reserveCoreContext(userId: string, agentId: string, preferredId?: string) {
  const rank = { preference: 0, fact: 1, decision: 2 };
  const notes = coreHomeMemories(userId, agentId).sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.id === preferredId) - Number(a.id === preferredId) ||
      Number(alwaysCoreMemory(b.content, b.scope)) - Number(alwaysCoreMemory(a.content, a.scope)) ||
      Number(a.origin === "automatic") - Number(b.origin === "automatic") ||
      rank[a.kind] - rank[b.kind] ||
      b.updatedAt - a.updatedAt ||
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
  const lower = query.normalize("NFKC").toLowerCase();
  const words: string[] = [];
  const bigrams: string[] = [];
  for (const run of lower.match(cjkRuns) ?? []) {
    if (!cjkChar.test(run)) {
      for (const word of run.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
        if (!queryStopWords.has(word) && !words.includes(word)) words.push(word);
      }
      continue;
    }
    const segments = run
      .replace(cjkFiller, " ")
      .split(" ")
      .map((segment) => [...segment]);
    for (const chars of segments) {
      for (let i = 0; i + 1 < chars.length; i++) {
        const pair = chars[i]! + chars[i + 1]!;
        if (!bigrams.includes(pair)) bigrams.push(pair);
      }
    }
    if (segments.every((chars) => chars.length < 2)) {
      for (const chars of segments) {
        if (chars.length === 1 && hanChar.test(chars[0]!) && !bigrams.includes(chars[0]!))
          bigrams.push(chars[0]!);
      }
    }
  }
  return [...words.slice(0, 12), ...bigrams.slice(0, 16)];
}

function ftsTermExpression(term: string) {
  if (!/^[\p{L}\p{N}_-]+$/u.test(term)) return `"${term.replaceAll('"', "")}"`;
  const stem =
    term.length > 4 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
  return stem.length >= 4 && /^\p{L}+$/u.test(stem) ? `"${stem}"*` : `"${term}"`;
}

function noteMatchedTermCount(
  note: Pick<HomeMemory, "title" | "scope" | "content" | "aliases">,
  terms: readonly string[],
) {
  const haystack = `${note.title} ${note.scope} ${note.content} ${note.aliases.join(" ")}`
    .normalize("NFKC")
    .toLowerCase();
  const words = haystack.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  let matched = 0;
  for (const term of terms) {
    if (hasCjk(term)) {
      if (haystack.includes(term)) matched++;
    } else if (words.some((word) => sameMemoryWord(term, word))) {
      matched++;
    }
  }
  return matched;
}

function requiredTermMatches(terms: readonly string[]) {
  const cjkCount = terms.filter(hasCjk).length;
  const wordCount = terms.length - cjkCount + Math.ceil(cjkCount / 2);
  return wordCount >= 5 ? 2 : 1;
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
  const bound = Math.min(20, Math.max(1, limit));
  const minMatches = requiredTermMatches(terms);
  const nonCjkTerms = terms.filter((term) => !hasCjk(term));
  const ftsIds: string[] = [];
  if (nonCjkTerms.length) {
    try {
      const rows = sqlite
        .prepare(`SELECT m.id FROM home_memory_search f JOIN home_memories m ON m.id = f.memory_id
        WHERE home_memory_search MATCH ? AND m.user_id = ? AND m.agent_id = ? AND (m.expires_at IS NULL OR m.expires_at > ?)
        ORDER BY rank, m.id LIMIT ?`)
        .all(
          nonCjkTerms.map(ftsTermExpression).join(" OR "),
          userId,
          agentId,
          now(),
          bound * 2,
        ) as Array<{ id: string }>;
      for (const row of rows) ftsIds.push(row.id);
    } catch {
      // Fallback to direct term scan if FTS syntax is rejected.
    }
  }
  const ftsRank = new Map(ftsIds.map((memoryId, index) => [memoryId, index]));
  const active = activeHomeMemories(userId, agentId).map(serializeHomeMemory);
  return active
    .map((note) => ({
      note,
      matched: noteMatchedTermCount(note, terms),
      rank: ftsRank.get(note.id) ?? 9999,
    }))
    .filter(({ matched }) => matched >= minMatches)
    .sort(
      (a, b) =>
        b.matched - a.matched ||
        a.rank - b.rank ||
        b.note.updatedAt - a.note.updatedAt ||
        a.note.id.localeCompare(b.note.id),
    )
    .slice(0, bound)
    .map(({ note }) => note);
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
  const normQuery = memoryIdentity(query);
  const terms = normQuery ? homeMemoryQueryTerms(query) : [];
  const minMatches = terms.length ? requiredTermMatches(terms) : 0;
  const matches = !normQuery
    ? rows
    : rows.filter(
        (row) =>
          memoryIdentity(
            `${row.title} ${row.scope} ${row.content} ${row.aliases.join(" ")}`,
          ).includes(normQuery) ||
          (terms.length > 0 && noteMatchedTermCount(row, terms) >= minMatches),
      );
  return {
    mode: settings.mode,
    retrieval: settings.retrieval,
    indexStatus: settings.retrieval.enabled
      ? (settings.indexStatus ?? emptyMemoryIndexStatus)
      : { ...emptyMemoryIndexStatus, state: "disabled" },
    embeddingModel: knowledgeEmbeddingModel(),
    memories: matches.slice(offset, offset + 50).map(serializeHomeMemory),
    sharedMemories: sharedAboutUserMemories(userId, agentId),
    total: matches.length,
    coreIds: core.map((note) => note.id),
    coreLines: homeMemoryNotebookSize(core).lines,
    coreBytes: homeMemoryNotebookSize(core).bytes,
    coreMaxLines: HOME_MEMORY_MAX_LINES,
    coreMaxBytes: HOME_MEMORY_MAX_BYTES,
    lastCaptureAt: settings.lastCaptureAt,
    lastCapture: settings.lastCapture ?? null,
    lastTidy: settings.lastCapture?.lastTidy ?? null,
    lastDream: settings.lastCapture?.lastDream ?? null,
    error: settings.error,
  };
}

export function saveRevision(row: typeof homeMemories.$inferSelect) {
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
  const { aboutUser, ...value } = homeMemoryInputSchema.parse(input);
  const desiredPlacement = input.placement ?? (aboutUser ? "core" : value.placement);
  const slot = formatMemorySlot(
    source?.slot ?? (aboutUser ? factIdentity(value.scope || value.content).slice(0, 80) : ""),
    aboutUser,
  );
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
        (input.placement !== undefined && existing.placement !== desiredPlacement) ||
        (aboutUser !== undefined && isAboutUserSlot(existing.slot) !== aboutUser))
    )
      return editHomeMemory(userId, agentId, existing.id, {
        expectedRevision: existing.revision,
        content: value.content,
        title: input.title ?? existing.title,
        scope: value.scope,
        kind: value.kind,
        placement: input.placement ?? (aboutUser ? "core" : existing.placement),
        aliases: input.aliases ?? existing.aliases,
        expiresAt: value.expiresAt,
        ...(aboutUser !== undefined ? { aboutUser } : {}),
      });
    if (source?.origin !== "automatic") allowHomeMemoryAgain(userId, agentId, existing);
    return serializeHomeMemory(existing);
  }
  return db.transaction(() => {
    const stamp = now();
    const memoryId = id("memory");
    const automatic = source?.origin === "automatic";
    const placement = availablePlacement(
      userId,
      agentId,
      { ...value, placement: desiredPlacement, id: memoryId, revision: 1 },
      automatic,
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
        slot,
        sourceEventId: source?.eventId || null,
        sourceEntryId: source?.entryId || null,
        sourceQuote: source?.quote.slice(0, 2000) ?? null,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    saveRevision(row);
    if (!automatic && placement === "core") reserveCoreContext(userId, agentId, memoryId);
    if (!automatic) allowHomeMemoryAgain(userId, agentId, row);
    // An explicit save needs no invalidation: a pending batch that learns the same
    // fact later already loses on slot dedupe, so discarding the queue would only
    // throw away learning that has nothing to do with this note.
    return serializeHomeMemory(
      db.select().from(homeMemories).where(eq(homeMemories.id, memoryId)).get()!,
    );
  });
}

export function editHomeMemory(
  userId: string,
  agentId: string,
  memoryId: string,
  input: HomeMemoryPatch,
) {
  const { expectedRevision, aboutUser, ...patch } = homeMemoryPatchSchema.parse(input);
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
    const nextSlot =
      aboutUser !== undefined
        ? formatMemorySlot(
            row.slot || factIdentity(value.scope || value.content).slice(0, 80),
            aboutUser,
          )
        : row.slot;
    const updated = db
      .update(homeMemories)
      .set({
        ...patch,
        slot: nextSlot,
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
        patch.expiresAt !== undefined ||
        aboutUser !== undefined
          ? { origin: "manual" as const }
          : {}),
      })
      .where(eq(homeMemories.id, memoryId))
      .returning()
      .get()!;
    saveRevision(updated);
    if (patch.content !== undefined) allowHomeMemoryAgain(userId, agentId, updated);
    if (updated.pinned || updated.placement === "core")
      reserveCoreContext(userId, agentId, updated.id);
    invalidateHomeCapture(userId, agentId);
    return serializeHomeMemory(
      db.select().from(homeMemories).where(eq(homeMemories.id, memoryId)).get()!,
    );
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
  let targetNote: typeof homeMemories.$inferSelect | undefined;
  if (memoryId) {
    targetNote = db
      .select()
      .from(homeMemories)
      .where(and(eq(homeMemories.userId, userId), eq(homeMemories.id, memoryId)))
      .get();
    if (!targetNote || (targetNote.agentId !== agentId && !isAboutUserSlot(targetNote.slot)))
      throw new HomeError("Memory not found.", 404);
    if (expectedRevision !== undefined && targetNote.revision !== expectedRevision)
      throw new HomeError("This memory changed. Review it before forgetting.", 409);
  }
  db.transaction(() => {
    const notes = targetNote
      ? [targetNote]
      : db.select().from(homeMemories).where(owner(userId, agentId)).all();
    const sharedIdentities = new Set(
      notes
        .filter((note) => isAboutUserSlot(note.slot))
        .map((note) => factIdentity(note.content))
        .filter(Boolean),
    );
    if (sharedIdentities.size) {
      const otherShared = db
        .select()
        .from(homeMemories)
        .where(and(eq(homeMemories.userId, userId), sql`${homeMemories.slot} LIKE 'about-user:%'`))
        .all()
        .filter((row) => sharedIdentities.has(factIdentity(row.content)));
      for (const row of otherShared) {
        if (!notes.some((item) => item.id === row.id)) notes.push(row);
      }
    }
    if (preventLearning) {
      const rules = new Map(settings.forgotten.map((rule) => [rule.contentHash, rule]));
      for (const note of notes) {
        const rule = homeMemoryForgettingRule(note);
        rules.set(rule.contentHash, rule);
      }
      db.update(homeMemorySettings)
        .set({ forgotten: [...rules.values()] })
        .where(settingsOwner(userId, agentId))
        .run();
      for (const note of notes) {
        if (note.agentId === agentId) continue;
        const otherSettings = readHomeMemorySettings(userId, note.agentId);
        const otherRules = new Map(otherSettings.forgotten.map((rule) => [rule.contentHash, rule]));
        const rule = homeMemoryForgettingRule(note);
        otherRules.set(rule.contentHash, rule);
        db.update(homeMemorySettings)
          .set({ forgotten: [...otherRules.values()] })
          .where(settingsOwner(userId, note.agentId))
          .run();
      }
    }
    if (memoryId) {
      db.delete(homeMemories)
        .where(
          and(
            eq(homeMemories.userId, userId),
            inArray(
              homeMemories.id,
              notes.map((note) => note.id),
            ),
          ),
        )
        .run();
    } else {
      db.delete(homeMemories).where(owner(userId, agentId)).run();
    }
    invalidateHomeCapture(userId, agentId);
  });
  if (settings.retrieval.enabled || settings.indexStatus)
    await purgeHomeMemoryIndex(userId, agentId);
}

export async function forgetHomeMemoryByQuery(
  userId: string,
  agentId: string,
  query: string,
  preventLearning = true,
) {
  const settings = readHomeMemorySettings(userId, agentId);
  const trimmed = query.trim();
  if (!trimmed) throw new HomeError("Provide a phrase or keywords to forget.", 400);
  const active = activeHomeMemories(userId, agentId);
  const phraseMatches = active.filter((note) =>
    passageMatches(
      `${note.title} ${note.scope} ${note.content} ${note.aliases.join(" ")}`,
      trimmed,
    ),
  );
  const matchedIds = new Set(
    (phraseMatches.length ? phraseMatches : searchHomeMemories(userId, agentId, trimmed, 50)).map(
      (note) => note.id,
    ),
  );
  const matched = active.filter((note) => matchedIds.has(note.id));
  const sharedMatches = db
    .select()
    .from(homeMemories)
    .where(
      and(
        eq(homeMemories.userId, userId),
        sql`${homeMemories.agentId} != ${agentId}`,
        sql`${homeMemories.slot} LIKE 'about-user:%'`,
        sql`(${homeMemories.expiresAt} IS NULL OR ${homeMemories.expiresAt} > ${now()})`,
      ),
    )
    .all()
    .filter((note) =>
      passageMatches(
        `${note.title} ${note.scope} ${note.content} ${note.aliases.join(" ")}`,
        trimmed,
      ),
    );
  const allMatched = [...matched, ...sharedMatches];
  db.transaction(() => {
    if (preventLearning) {
      const rules = new Map(settings.forgotten.map((rule) => [rule.contentHash, rule]));
      for (const note of allMatched) {
        const rule = homeMemoryForgettingRule(note);
        rules.set(rule.contentHash, rule);
      }
      const queryRule = homeMemoryForgettingRule({ content: trimmed, scope: "" });
      if (queryRule.terms.length) rules.set(queryRule.contentHash, queryRule);
      db.update(homeMemorySettings)
        .set({ forgotten: [...rules.values()] })
        .where(settingsOwner(userId, agentId))
        .run();
      for (const note of sharedMatches) {
        const otherSettings = readHomeMemorySettings(userId, note.agentId);
        const otherRules = new Map(otherSettings.forgotten.map((rule) => [rule.contentHash, rule]));
        const rule = homeMemoryForgettingRule(note);
        otherRules.set(rule.contentHash, rule);
        if (queryRule.terms.length) otherRules.set(queryRule.contentHash, queryRule);
        db.update(homeMemorySettings)
          .set({ forgotten: [...otherRules.values()] })
          .where(settingsOwner(userId, note.agentId))
          .run();
      }
    }
    if (allMatched.length) {
      db.delete(homeMemories)
        .where(
          and(
            eq(homeMemories.userId, userId),
            inArray(
              homeMemories.id,
              allMatched.map((note) => note.id),
            ),
          ),
        )
        .run();
    }
    invalidateHomeCapture(userId, agentId);
  });
  if (matched.length && (settings.retrieval.enabled || settings.indexStatus))
    await purgeHomeMemoryIndex(userId, agentId);
  return allMatched.length;
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
  source: { eventId: string | null; entryId: string | null; quote: string; slot: string },
) {
  const row = requireMemory(userId, agentId, memoryId);
  if (row.origin === "manual" || row.pinned || row.revision !== expectedRevision) return undefined;
  const { aboutUser, ...value } = homeMemoryInputSchema.parse(input);
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
  const nextSlot = formatMemorySlot(
    source.slot,
    aboutUser ?? (isAboutUserSlot(row.slot) ? true : undefined),
  );
  const updated = db
    .update(homeMemories)
    .set({
      ...value,
      placement,
      origin: "automatic",
      sourceEventId: source.eventId || null,
      sourceEntryId: source.entryId || null,
      sourceQuote: source.quote,
      slot: nextSlot,
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
