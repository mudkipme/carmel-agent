import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  HomeMemoryCaptureReport,
  HomeMemoryDreamReport,
  HomeMemoryTidyReport,
} from "@carmel-agent/shared";
import { db, sqlite } from "../db/index.ts";
import { agentHomes, agents, homeMemories, homeMemorySettings, sessions } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { readHome } from "../services/agent-homes.ts";
import { getActiveAgentRunForSessionId } from "../runtime/run-stream.ts";
import { resolveModelContext } from "../services/model-context.ts";
import {
  activeHomeMemories,
  factIdentity,
  isAboutUserSlot,
  isHomeMemoryForgotten,
  memoryIdentity,
  readHomeMemorySettings,
  rejectHomeMemorySecrets,
  saveHomeMemory,
  saveRevision,
  updateAutomaticHomeMemory,
} from "./service.ts";
import { renderHomeMemoryTopicIndex } from "./notebook.ts";
import { purgeHomeMemoryIndex } from "./search-index.ts";
import {
  checkDreamFacts,
  contradictionPrompt,
  DREAM_FIRST_LOOKBACK_MS,
  DREAM_MARKER,
  DREAM_MAX_CONVERSATIONS,
  DREAM_MIN_CONVERSATIONS,
  dreamPrompt,
  ORGANIZE_MARKER,
  organizeCandidates,
  organizePrompt,
  parseContradictions,
  parseDream,
  parseOrganizeMoves,
  TIDY_MARKER,
  type Contradiction,
  type DreamConversation,
  type TopicMove,
} from "./upkeep-prompts.ts";

export {
  checkDreamFacts,
  contradictionPrompt,
  DREAM_FIRST_LOOKBACK_MS,
  DREAM_MARKER,
  DREAM_MAX_CONVERSATIONS,
  DREAM_MIN_CONVERSATIONS,
  dreamPrompt,
  ORGANIZE_MARKER,
  organizeCandidates,
  organizePrompt,
  parseContradictions,
  parseDream,
  parseOrganizeMoves,
  TIDY_MARKER,
  type Contradiction,
  type DreamConversation,
  type TopicMove,
};

const DREAM_CONVERSATION_BYTES = 4_000;
const DREAM_TOTAL_BYTES = 40_000;
const MAX_MOVES = 20;
const MAX_TOPIC_CHECKS = 4;
const CONTRADICTION_SHARE = 0.2;
const STALE_WORK_LOG =
  /\b(?:merged|shipped|deployed|released|completed|resolved|cancelled|closed|fixed\s+in\s+pr|pull\s+request\s+#?\d+\s+is\s+done)\b/iu;

function emptyCaptureReport(at: number): HomeMemoryCaptureReport {
  return {
    at,
    model: null,
    route: "none",
    stopReason: "not-called",
    candidates: 0,
    curated: 0,
    saved: 0,
    rejected: [],
    usage: null,
    error: null,
  };
}

function saveUpkeepState(
  userId: string,
  agentId: string,
  patch: Partial<
    Pick<HomeMemoryCaptureReport, "lastTidy" | "lastDream" | "dreamedTo" | "judgedCore">
  >,
  at = now(),
) {
  const settings = readHomeMemorySettings(userId, agentId);
  const current = settings.lastCapture ?? emptyCaptureReport(at);
  const next: HomeMemoryCaptureReport = { ...current, ...patch };
  db.update(homeMemorySettings)
    .set({ lastCapture: next })
    .where(and(eq(homeMemorySettings.userId, userId), eq(homeMemorySettings.agentId, agentId)))
    .run();
}

async function askUpkeepModel(
  userId: string,
  agentId: string,
  prompt: string,
  resolveModel = resolveModelContext,
  timeoutMs = 30_000,
): Promise<string | null> {
  const home = readHome(userId, agentId);
  const session = home
    ? db.select().from(sessions).where(eq(sessions.id, home.sessionId)).get()
    : undefined;
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  const modelRefId = session?.modelRefId ?? agent?.defaultModelRefId ?? null;
  if (!modelRefId) return null;
  const resolved = await resolveModel(userId, modelRefId);
  if (!resolved.ok) return null;
  const { model, modelRuntime } = resolved.value;
  const thinking = getSupportedThinkingLevels(model).includes("off")
    ? "off"
    : clampThinkingLevel(model, "low");
  try {
    const response = await modelRuntime.completeSimple(
      model,
      {
        systemPrompt: prompt,
        messages: [
          {
            role: "user",
            content: "Return the requested JSON object only.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 2048,
        signal: AbortSignal.timeout(timeoutMs),
        timeoutMs,
        reasoning: thinking === "off" ? undefined : thinking,
      },
    );
    if (response.stopReason === "error") return null;
    return response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  } catch {
    return null;
  }
}

function deduplicateNotes(userId: string, agentId: string): number {
  const active = activeHomeMemories(userId, agentId);
  const groups = new Map<string, (typeof homeMemories.$inferSelect)[]>();
  for (const note of active) {
    const identity = factIdentity(note.content);
    if (!identity) continue;
    const existing = groups.get(identity) ?? [];
    existing.push(note);
    groups.set(identity, existing);
  }
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.placement === "core") - Number(a.placement === "core") ||
        Number(a.origin === "automatic") - Number(b.origin === "automatic") ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
    const winner = sorted[0]!;
    const losers = sorted.slice(1).filter((loser) => {
      if (loser.pinned) return false;
      if (!winner.scope || !loser.scope) return true;
      return memoryIdentity(winner.scope) === memoryIdentity(loser.scope);
    });
    if (!losers.length) continue;
    const mergedAliases = [
      ...new Set([...winner.aliases, ...losers.flatMap((item) => item.aliases)]),
    ].slice(0, 12);
    const mergedScope = winner.scope || losers.find((item) => item.scope)?.scope || "";
    const mergedTitle = winner.title || losers.find((item) => item.title)?.title || "";
    const mergedSlot =
      isAboutUserSlot(winner.slot) || !losers.some((item) => isAboutUserSlot(item.slot))
        ? winner.slot
        : losers.find((item) => isAboutUserSlot(item.slot))!.slot;
    if (
      mergedScope !== winner.scope ||
      mergedTitle !== winner.title ||
      mergedSlot !== winner.slot ||
      JSON.stringify(mergedAliases) !== JSON.stringify(winner.aliases)
    ) {
      const updated = db
        .update(homeMemories)
        .set({
          scope: mergedScope,
          title: mergedTitle,
          slot: mergedSlot,
          aliases: mergedAliases,
          revision: winner.revision + 1,
          updatedAt: now(),
        })
        .where(eq(homeMemories.id, winner.id))
        .returning()
        .get()!;
      saveRevision(updated);
    }
    db.delete(homeMemories)
      .where(
        inArray(
          homeMemories.id,
          losers.map((item) => item.id),
        ),
      )
      .run();
    removed += losers.length;
  }
  return removed;
}

function coalesceTopicNotes(userId: string, agentId: string): number {
  const active = activeHomeMemories(userId, agentId);
  const byScope = new Map<string, (typeof homeMemories.$inferSelect)[]>();
  for (const note of active) {
    if (
      note.pinned ||
      note.placement !== "topic" ||
      note.origin !== "automatic" ||
      note.expiresAt !== null ||
      !note.scope.trim() ||
      note.content.length > 400
    )
      continue;
    const key = memoryIdentity(note.scope);
    const list = byScope.get(key) ?? [];
    list.push(note);
    byScope.set(key, list);
  }
  let coalesced = 0;
  for (const group of byScope.values()) {
    if (group.length < 3) continue;
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const primary = sorted[0]!;
    const others = sorted.slice(1);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const item of sorted) {
      for (const rawLine of item.content.split("\n")) {
        const line = rawLine.replace(/^\s*[-*•]\s+/u, "").trim();
        const key = factIdentity(line);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${line}`);
      }
    }
    const mergedContent = lines.join("\n").slice(0, 20_000);
    if (!mergedContent) continue;
    const mergedAliases = [...new Set(sorted.flatMap((item) => item.aliases))].slice(0, 12);
    const updated = db
      .update(homeMemories)
      .set({
        content: mergedContent,
        aliases: mergedAliases,
        revision: primary.revision + 1,
        updatedAt: now(),
      })
      .where(eq(homeMemories.id, primary.id))
      .returning()
      .get()!;
    saveRevision(updated);
    db.delete(homeMemories)
      .where(
        inArray(
          homeMemories.id,
          others.map((item) => item.id),
        ),
      )
      .run();
    coalesced += others.length;
  }
  return coalesced;
}

export async function organizeHomeMemories(
  userId: string,
  agentId: string,
  at = now(),
  resolveModel = resolveModelContext,
): Promise<number> {
  const settings = readHomeMemorySettings(userId, agentId);
  if (settings.mode === "off") return 0;
  const judgedCore = new Set(settings.lastCapture?.judgedCore ?? []);
  const active = activeHomeMemories(userId, agentId);
  const candidates = organizeCandidates(active, judgedCore);
  if (!candidates.length) return 0;

  let moves: TopicMove[] = [];
  const staleCutoff = at - 14 * 24 * 60 * 60_000;
  for (const note of candidates) {
    if (note.updatedAt <= staleCutoff && STALE_WORK_LOG.test(note.content)) {
      moves.push({
        memoryId: note.id,
        scope: note.scope || "Work log",
        aliases: note.aliases.length ? note.aliases : ["status", "completed"],
      });
    }
  }

  const remaining = candidates.filter((note) => !moves.some((move) => move.memoryId === note.id));
  if (remaining.length) {
    const today = new Date(at).toISOString().slice(0, 10);
    const answer = await askUpkeepModel(
      userId,
      agentId,
      organizePrompt(remaining, renderHomeMemoryTopicIndex(active), today),
      resolveModel,
    );
    if (answer !== null) {
      const proposed = parseOrganizeMoves(answer, remaining);
      if (proposed) {
        const movedIds = new Set(proposed.map((move) => move.memoryId));
        for (const note of remaining) {
          if (!movedIds.has(note.id)) judgedCore.add(factIdentity(note.content));
        }
        moves = [...moves, ...proposed].slice(0, MAX_MOVES);
      }
    }
  }

  let movedCount = 0;
  db.transaction(() => {
    for (const move of moves) {
      const current = db
        .select()
        .from(homeMemories)
        .where(
          and(
            eq(homeMemories.id, move.memoryId),
            eq(homeMemories.userId, userId),
            eq(homeMemories.agentId, agentId),
          ),
        )
        .get();
      if (!current || current.pinned || current.placement !== "core") continue;
      const mergedAliases = [...new Set([...current.aliases, ...move.aliases])].slice(0, 12);
      const updated = db
        .update(homeMemories)
        .set({
          placement: "topic",
          scope: move.scope || current.scope || "General",
          aliases: mergedAliases,
          revision: current.revision + 1,
          updatedAt: at,
        })
        .where(eq(homeMemories.id, current.id))
        .returning()
        .get()!;
      saveRevision(updated);
      movedCount++;
    }
    saveUpkeepState(
      userId,
      agentId,
      { judgedCore: [...judgedCore].filter(Boolean).slice(-500) },
      at,
    );
  });
  return movedCount;
}

function applyContradictions(
  userId: string,
  agentId: string,
  snapshot: readonly (typeof homeMemories.$inferSelect)[],
  contradictions: readonly Contradiction[],
  minimumBudget: number,
  at: number,
): number {
  if (!contradictions.length) return 0;
  const currentRows = activeHomeMemories(userId, agentId);
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  for (const item of snapshot) {
    const live = currentById.get(item.id);
    if (!live || live.revision !== item.revision) return 0;
  }
  const budget = Math.max(minimumBudget, Math.floor(snapshot.length * CONTRADICTION_SHARE));
  const touched = new Set<string>();
  let superseded = 0;
  db.transaction(() => {
    for (const pair of contradictions) {
      if (superseded >= budget) break;
      const a = snapshot[pair.a];
      const b = snapshot[pair.b];
      if (!a || !b || a.id === b.id) continue;
      const [winner, loser] = pair.keep === "a" ? [a, b] : [b, a];
      if (loser.pinned || touched.has(winner.id) || touched.has(loser.id)) continue;
      touched.add(winner.id);
      touched.add(loser.id);
      if (pair.remainder) {
        try {
          rejectHomeMemorySecrets(agentId, pair.remainder);
          const updated = db
            .update(homeMemories)
            .set({
              content: pair.remainder,
              revision: loser.revision + 1,
              updatedAt: at,
            })
            .where(eq(homeMemories.id, loser.id))
            .returning()
            .get()!;
          saveRevision(updated);
          superseded++;
          continue;
        } catch {
          // Fall through if remainder fails validation.
        }
      }
      db.delete(homeMemories).where(eq(homeMemories.id, loser.id)).run();
      superseded++;
    }
  });
  return superseded;
}

export async function tidyHomeMemories(
  userId: string,
  agentId: string,
  at = now(),
  resolveModel = resolveModelContext,
): Promise<HomeMemoryTidyReport> {
  const settings = readHomeMemorySettings(userId, agentId);
  const expiredRows = db
    .select({ id: homeMemories.id })
    .from(homeMemories)
    .where(
      and(
        eq(homeMemories.userId, userId),
        eq(homeMemories.agentId, agentId),
        sql`${homeMemories.expiresAt} IS NOT NULL AND ${homeMemories.expiresAt} <= ${at}`,
      ),
    )
    .all();
  if (expiredRows.length) {
    db.delete(homeMemories)
      .where(
        inArray(
          homeMemories.id,
          expiredRows.map((row) => row.id),
        ),
      )
      .run();
  }
  const duplicates = deduplicateNotes(userId, agentId);
  const coalesced = coalesceTopicNotes(userId, agentId);
  const organized = await organizeHomeMemories(userId, agentId, at, resolveModel);

  let superseded = 0;
  let contradictionsChecked = false;
  let note: string | null = null;

  const active = activeHomeMemories(userId, agentId);
  const coreNotes = active.filter((item) => item.pinned || item.placement === "core");
  if (coreNotes.length >= 2) {
    const answer = await askUpkeepModel(
      userId,
      agentId,
      contradictionPrompt(coreNotes),
      resolveModel,
    );
    if (answer !== null) {
      contradictionsChecked = true;
      const pairs = parseContradictions(answer, coreNotes.length);
      superseded += applyContradictions(userId, agentId, coreNotes, pairs, 1, at);
    }
  }

  const byTopic = new Map<string, (typeof homeMemories.$inferSelect)[]>();
  for (const item of activeHomeMemories(userId, agentId)) {
    if (item.pinned || item.placement === "core") continue;
    const key = memoryIdentity(item.scope || item.title || "General");
    const list = byTopic.get(key) ?? [];
    list.push(item);
    byTopic.set(key, list);
  }
  let topicChecks = 0;
  for (const group of byTopic.values()) {
    if (group.length < 2) continue;
    if (topicChecks >= MAX_TOPIC_CHECKS) break;
    topicChecks++;
    const answer = await askUpkeepModel(userId, agentId, contradictionPrompt(group), resolveModel);
    if (answer !== null) {
      contradictionsChecked = true;
      const pairs = parseContradictions(answer, group.length);
      superseded += applyContradictions(userId, agentId, group, pairs, 1, at);
    }
  }

  if (
    (expiredRows.length || duplicates || superseded) &&
    (settings.retrieval.enabled || settings.indexStatus)
  ) {
    await purgeHomeMemoryIndex(userId, agentId);
  }

  const report: HomeMemoryTidyReport = {
    at,
    expired: expiredRows.length,
    duplicates,
    superseded,
    organized,
    coalesced,
    contradictionsChecked,
    note,
  };
  saveUpkeepState(userId, agentId, { lastTidy: report }, at);
  return report;
}

export function dreamConversations(
  userId: string,
  agentId: string,
  since: number,
): DreamConversation[] {
  const recentSessions = db
    .select({ id: sessions.id, title: sessions.title, updatedAt: sessions.updatedAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.agentId, agentId),
        sql`${sessions.updatedAt} > ${since}`,
      ),
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(DREAM_MAX_CONVERSATIONS)
    .all();

  const out: DreamConversation[] = [];
  let totalBytes = 0;
  for (const session of recentSessions) {
    const rows = sqlite
      .prepare(
        "SELECT entry_id AS entryId, text FROM session_search WHERE session_id = ? AND entry_id != 'title' ORDER BY rowid ASC",
      )
      .all(session.id) as Array<{ entryId: string; text: string }>;
    if (!rows.length) continue;
    const lines: Array<{ by: "user" | "assistant"; text: string }> = [];
    let convBytes = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const cleaned = rows[i]!.text.replace(/\s+/gu, " ").trim().slice(0, 600);
      if (!cleaned) continue;
      const by: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
      const cost = Buffer.byteLength(cleaned, "utf8");
      if (
        convBytes + cost > DREAM_CONVERSATION_BYTES ||
        totalBytes + convBytes + cost > DREAM_TOTAL_BYTES
      )
        break;
      lines.unshift({ by, text: cleaned });
      convBytes += cost;
    }
    if (!lines.length) continue;
    out.push({ sessionId: session.id, title: session.title, lines });
    totalBytes += convBytes;
    if (totalBytes >= DREAM_TOTAL_BYTES) break;
  }
  return out;
}

export async function dreamHomeMemories(
  userId: string,
  agentId: string,
  at = now(),
  resolveModel = resolveModelContext,
): Promise<HomeMemoryDreamReport> {
  const settings = readHomeMemorySettings(userId, agentId);
  if (settings.mode !== "automatic") {
    return {
      at,
      conversations: 0,
      learned: [],
      outdated: [],
      ideas: [],
      aboutMe: 0,
      note: "Automatic learning is off.",
    };
  }
  const since = settings.lastCapture?.dreamedTo ?? at - DREAM_FIRST_LOOKBACK_MS;
  const conversations = dreamConversations(userId, agentId, since);
  if (conversations.length < DREAM_MIN_CONVERSATIONS) {
    const report: HomeMemoryDreamReport = {
      at,
      conversations: conversations.length,
      learned: [],
      outdated: [],
      ideas: [],
      aboutMe: 0,
      note: `Needs at least ${DREAM_MIN_CONVERSATIONS} active conversations since the last consolidation.`,
    };
    saveUpkeepState(userId, agentId, { lastDream: report }, at);
    return report;
  }

  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  const notes = activeHomeMemories(userId, agentId);
  const today = new Date(at).toISOString().slice(0, 10);
  const answer = await askUpkeepModel(
    userId,
    agentId,
    dreamPrompt({
      agentName: agent?.name ?? "Assistant",
      today,
      conversations,
      notes,
      topics: renderHomeMemoryTopicIndex(notes),
    }),
    resolveModel,
    60_000,
  );
  if (answer === null) {
    const report: HomeMemoryDreamReport = {
      at,
      conversations: conversations.length,
      learned: [],
      outdated: [],
      ideas: [],
      aboutMe: 0,
      note: "The consolidation model call did not answer in time.",
    };
    saveUpkeepState(userId, agentId, { lastDream: report }, at);
    return report;
  }

  const parsed = parseDream(answer, conversations.length, notes.length);
  const verifiedLearned = parsed.learned.filter(
    (item) =>
      checkDreamFacts(item.text, item.from, item.evidence, conversations) &&
      !isHomeMemoryForgotten(userId, agentId, { content: item.text, scope: item.scope }),
  );
  const verifiedOutdated = parsed.outdated.filter((item) => {
    const target = notes[item.line];
    return (
      target &&
      checkDreamFacts(item.now, item.from, item.evidence, conversations) &&
      !isHomeMemoryForgotten(userId, agentId, { content: item.now, scope: target.scope })
    );
  });

  const savedLearned: Array<{ content: string; scope: string }> = [];
  const savedOutdated: Array<{ was: string; now: string }> = [];
  let aboutMe = 0;

  for (const item of verifiedOutdated) {
    const target = notes[item.line]!;
    const updated = updateAutomaticHomeMemory(
      userId,
      agentId,
      target.id,
      target.revision,
      {
        content: item.now,
        title: target.title,
        scope: target.scope,
        kind: target.kind,
        placement: target.placement,
        aliases: target.aliases,
        expiresAt: target.expiresAt,
      },
      {
        eventId: target.sourceEventId ?? "",
        entryId: target.sourceEntryId ?? "",
        quote: item.evidence?.[0] ?? item.now,
        slot: target.slot || `dream/${factIdentity(target.scope || item.now).slice(0, 60)}`,
      },
    );
    if (updated) savedOutdated.push({ was: target.content, now: item.now });
  }

  for (const item of verifiedLearned) {
    try {
      const saved = saveHomeMemory(
        userId,
        agentId,
        {
          content: item.text,
          scope: item.scope,
          kind: "preference",
          placement: item.scope && !item.aboutUser ? "topic" : "core",
          aliases: item.aliases,
          aboutUser: item.aboutUser,
        },
        {
          origin: "automatic",
          eventId: "",
          entryId: null,
          quote: item.evidence?.[0] ?? item.text,
          slot: `dream/${factIdentity(item.scope || item.text).slice(0, 60)}`,
        },
      );
      savedLearned.push({ content: saved.content, scope: saved.scope });
      if (item.aboutUser) aboutMe++;
    } catch {
      // Skip candidates that fail secret checks or validation.
    }
  }

  const report: HomeMemoryDreamReport = {
    at,
    conversations: conversations.length,
    learned: savedLearned,
    outdated: savedOutdated,
    ideas: parsed.ideas,
    aboutMe,
    note: null,
  };
  saveUpkeepState(userId, agentId, { lastDream: report, dreamedTo: at }, at);
  return report;
}

const UPKEEP_INTERVAL_MS = 24 * 60 * 60_000;

export async function runHomeMemoryUpkeep(
  at = now(),
  resolveModel = resolveModelContext,
): Promise<void> {
  const homes = db
    .select()
    .from(agentHomes)
    .innerJoin(
      homeMemorySettings,
      and(
        eq(agentHomes.userId, homeMemorySettings.userId),
        eq(agentHomes.agentId, homeMemorySettings.agentId),
      ),
    )
    .where(eq(homeMemorySettings.mode, "automatic"))
    .all();
  for (const { agent_homes: home, home_memory_settings: settings } of homes) {
    if (!readHome(home.userId, home.agentId) || getActiveAgentRunForSessionId(home.sessionId))
      continue;
    const lastTidyAt = settings.lastCapture?.lastTidy?.at ?? 0;
    if (
      at - lastTidyAt >= UPKEEP_INTERVAL_MS &&
      activeHomeMemories(home.userId, home.agentId).length > 0
    ) {
      await tidyHomeMemories(home.userId, home.agentId, at, resolveModel).catch(() => {});
    }
    const lastDreamAt = settings.lastCapture?.lastDream?.at ?? 0;
    if (at - lastDreamAt >= UPKEEP_INTERVAL_MS) {
      await dreamHomeMemories(home.userId, home.agentId, at, resolveModel).catch(() => {});
    }
  }
}
