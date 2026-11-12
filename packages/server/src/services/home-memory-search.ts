import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  homeMemorySearchSchema,
  type HomeMemory,
  type HomeMemorySearchInput,
  type HomeMemorySearchResult,
  type HomeMemorySearchHit,
  type KnowledgeStatus,
} from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { homeMemorySettings } from "../db/schema.ts";
import { HomeError } from "./agent-homes.ts";
import { readVisibleAgent } from "./agent-access.ts";
import {
  activeHomeMemories,
  readHomeMemorySettings,
  searchHomeMemories,
  serializeHomeMemory,
} from "./home-memory.ts";
import {
  emptyMemoryIndexStatus,
  homeMemoryIndexDir,
  homeMemoryIndexKey,
} from "./home-memory-index.ts";
import { knowledgeModelPlan } from "../runtime/knowledge/models.ts";
import { knowledgeLock } from "../runtime/knowledge/queue.ts";
import {
  callKnowledgeWorker,
  knowledgeWorkerSearchSchema as searchSchema,
  knowledgeWorkerStatusSchema as statusSchema,
  type KnowledgeWorkerPlan,
} from "../runtime/knowledge/worker-client.ts";

const owner = (userId: string, agentId: string) =>
  and(eq(homeMemorySettings.userId, userId), eq(homeMemorySettings.agentId, agentId));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fingerprint = (notes: readonly HomeMemory[]) =>
  hash(JSON.stringify(notes.map((note) => [note.id, note.revision]).sort()));

function homeMemoryDocumentHeader(note: HomeMemory) {
  return `# ${note.title || note.scope || "Memory"}\n\n`;
}

export function homeMemoryDocument(note: HomeMemory) {
  return `${homeMemoryDocumentHeader(note)}${note.content}${note.aliases.length ? `\n\nAliases: ${note.aliases.join(", ")}` : ""}`;
}

function setStatus(
  userId: string,
  agentId: string,
  patch: Partial<KnowledgeStatus>,
  dirty?: boolean,
) {
  const current = readHomeMemorySettings(userId, agentId);
  db.update(homeMemorySettings)
    .set({
      indexStatus: { ...(current.indexStatus ?? emptyMemoryIndexStatus), ...patch },
      ...(dirty === undefined ? {} : { indexDirty: dirty }),
    })
    .where(owner(userId, agentId))
    .run();
}

export async function homeMemoryWorkerPlan(
  userId: string,
  agentId: string,
  allowDownloads = false,
): Promise<KnowledgeWorkerPlan> {
  const settings = readHomeMemorySettings(userId, agentId);
  const agent = readVisibleAgent(userId, agentId)!;
  const stateDir = homeMemoryIndexDir(userId, agentId);
  await Promise.all(
    ["notes", "home", "cache", "config"].map((name) =>
      mkdir(resolve(stateDir, name), { recursive: true, mode: 0o700 }),
    ),
  );
  return {
    agentId,
    scopeKey: homeMemoryIndexKey(userId, agentId),
    stateDir,
    settings: settings.retrieval,
    ...(await knowledgeModelPlan()),
    network: allowDownloads && agent.permissions.network,
    sources: [
      {
        id: "memories",
        hostPath: resolve(stateDir, "notes"),
        description: "Private Home notes for this user and agent only.",
      },
    ],
  };
}

export async function searchHomeMemory(
  userId: string,
  agentId: string,
  input: HomeMemorySearchInput,
  signal?: AbortSignal,
  worker = callKnowledgeWorker,
): Promise<HomeMemorySearchResult> {
  const args = homeMemorySearchSchema.parse(input);
  const settings = readHomeMemorySettings(userId, agentId);
  if (settings.mode === "off") return { memories: [], mode: "fast" };
  const keyword = () =>
    args.query
      ? searchHomeMemories(userId, agentId, args.query)
      : activeHomeMemories(userId, agentId).map(serializeHomeMemory);
  if (!args.query || args.mode === "fast") return { memories: keyword(), mode: "fast" };
  if (!settings.retrieval.enabled || !settings.indexStatus?.lastUpdatedAt)
    return {
      memories: keyword(),
      mode: "fast",
      warning: "Embeddings are not ready; using keyword search.",
    };
  try {
    return await knowledgeLock(
      homeMemoryIndexKey(userId, agentId),
      async () => {
        signal?.throwIfAborted();
        const plan = await homeMemoryWorkerPlan(userId, agentId);
        const response = searchSchema.parse(
          await knowledgeLock(
            "$gpu",
            () =>
              worker(
                plan,
                {
                  op: "search",
                  query: args.query,
                  mode: args.mode,
                  collections: ["memories"],
                  limit: 20,
                },
                signal,
              ),
            signal,
          ),
        );
        const current = readHomeMemorySettings(userId, agentId);
        if (current.mode === "off" || !current.retrieval.enabled)
          return { memories: [], mode: "fast" as const };
        const notes = activeHomeMemories(userId, agentId);
        const memories: HomeMemorySearchHit[] = [];
        let stale = false;
        for (const hit of response.hits) {
          const note = notes.find(
            (item) => hit.sourceId === "memories" && hit.path === `${item.id}.md`,
          );
          if (!note || hit.hash !== hash(homeMemoryDocument(note))) {
            stale = true;
            continue;
          }
          if (!memories.some((item) => item.id === note.id)) {
            const headerLength = homeMemoryDocumentHeader(note).length;
            const start = Math.max(0, (hit.match?.start ?? 0) - headerLength);
            const end = Math.min(note.content.length, (hit.match?.end ?? 0) - headerLength);
            memories.push({
              ...serializeHomeMemory(note),
              ...(hit.match && end > start ? { match: { start, end } } : {}),
            });
          }
        }
        for (const note of keyword())
          if (!memories.some((item) => item.id === note.id)) memories.push(note);
        if (stale)
          db.update(homeMemorySettings)
            .set({ indexDirty: true })
            .where(owner(userId, agentId))
            .run();
        return {
          memories: memories.slice(0, 20),
          mode: args.mode,
          ...(stale || current.indexDirty
            ? {
                warning:
                  "Some memory changes are awaiting index refresh; current keyword matches are included.",
              }
            : {}),
        };
      },
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (readHomeMemorySettings(userId, agentId).mode === "off")
      return { memories: [], mode: "fast" };
    return {
      memories: keyword(),
      mode: "fast",
      warning: `Semantic retrieval unavailable; using keyword search. ${error instanceof Error ? error.message : ""}`,
    };
  }
}

export async function recallHomeMemories(userId: string, agentId: string, query: string) {
  try {
    return (
      await searchHomeMemory(
        userId,
        agentId,
        { query, mode: "semantic" },
        AbortSignal.timeout(5000),
      )
    ).memories;
  } catch {
    return readHomeMemorySettings(userId, agentId).mode === "off"
      ? []
      : searchHomeMemories(userId, agentId, query);
  }
}

const jobs = new Map<string, Promise<void>>();
let controller = new AbortController();
let timer: ReturnType<typeof setInterval> | undefined;
const retries = new Map<string, number>();

export async function refreshHomeMemoryIndex(
  userId: string,
  agentId: string,
  options: { embed?: boolean; allowDownloads?: boolean; deep?: boolean } = {},
  worker = callKnowledgeWorker,
) {
  const settings = readHomeMemorySettings(userId, agentId);
  if (!settings.retrieval.enabled) throw new HomeError("Enable memory indexing first.", 400);
  const key = homeMemoryIndexKey(userId, agentId);
  if (jobs.has(key)) throw new HomeError("Memory indexing is already running.", 409);
  const job = knowledgeLock(key, async () => {
    try {
      setStatus(userId, agentId, { state: "updating", error: null });
      const plan = await homeMemoryWorkerPlan(userId, agentId, options.allowDownloads);
      const notes = activeHomeMemories(userId, agentId);
      const before = fingerprint(notes);
      const names = new Set(notes.map((note) => `${note.id}.md`));
      for (const name of await readdir(resolve(plan.stateDir, "notes")))
        if (!names.has(name)) await rm(resolve(plan.stateDir, "notes", name), { force: true });
      for (const note of notes)
        await writeFile(
          resolve(plan.stateDir, "notes", `${note.id}.md`),
          homeMemoryDocument(note),
          { mode: 0o600 },
        );
      let status = statusSchema.parse(await worker(plan, { op: "update" }, controller.signal));
      if (options.deep) {
        setStatus(userId, agentId, { state: "embedding" });
        await knowledgeLock("$gpu", () => worker(plan, { op: "prepare" }, controller.signal));
      }
      if (options.embed) {
        setStatus(userId, agentId, { state: "embedding" });
        status = statusSchema.parse(
          await knowledgeLock("$gpu", () => worker(plan, { op: "embed" }, controller.signal)),
        );
      }
      setStatus(
        userId,
        agentId,
        {
          ...status,
          backend: status.backend ?? settings.indexStatus?.backend ?? null,
          devices: status.backend ? status.devices : (settings.indexStatus?.devices ?? []),
          state: "ready",
          lastUpdatedAt: Date.now(),
          error: null,
        },
        before !== fingerprint(activeHomeMemories(userId, agentId)),
      );
    } catch (error) {
      if (readVisibleAgent(userId, agentId))
        setStatus(userId, agentId, {
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
  jobs.set(key, job);
  void job.finally(() => jobs.delete(key)).catch(() => {});
}

export async function waitHomeMemoryIndexJob(userId: string, agentId: string) {
  await jobs.get(homeMemoryIndexKey(userId, agentId));
}

export async function tickHomeMemoryIndexes() {
  if (jobs.size || controller.signal.aborted) return;
  for (const row of db.select().from(homeMemorySettings).all()) {
    if (row.mode === "off" || !row.retrieval.enabled || !readVisibleAgent(row.userId, row.agentId))
      continue;
    if (!row.indexDirty && Date.now() - (row.indexStatus?.lastUpdatedAt ?? 0) < 5 * 60_000)
      continue;
    const key = homeMemoryIndexKey(row.userId, row.agentId);
    if (Date.now() - (retries.get(key) ?? 0) < 5 * 60_000) continue;
    retries.set(key, Date.now());
    await refreshHomeMemoryIndex(row.userId, row.agentId, {
      embed: Boolean(row.indexStatus?.backend),
    });
    break;
  }
}

export function startHomeMemoryIndexes() {
  controller = new AbortController();
  timer = setInterval(
    () =>
      void tickHomeMemoryIndexes().catch((error) => console.error("Memory indexing failed", error)),
    30_000,
  );
  timer.unref();
}

export async function stopHomeMemoryIndexes() {
  if (timer) clearInterval(timer);
  timer = undefined;
  controller.abort();
  await Promise.allSettled(jobs.values());
}
