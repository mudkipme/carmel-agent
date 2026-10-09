import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  knowledgeSettingsSchema,
  knowledgeSearchSchema,
  knowledgeReadSchema,
  memoryInputSchema,
  knowledgeSourceInputSchema,
  type KnowledgeStatus,
  type KnowledgeSettings,
  type KnowledgeOverview,
  type KnowledgeSource,
  type KnowledgeSearchInput,
  type KnowledgeReadInput,
  type KnowledgeDocument,
  type KnowledgeSearchResult,
  type SavedMemory,
  type MemoryInput,
} from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { agents, knowledgeConfigs, knowledgeMemories, knowledgeSources } from "../db/schema.ts";
import { dataDir } from "../paths.ts";
import { readVisibleAgent, type AgentRecord } from "./agent-access.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import {
  callKnowledgeWorker,
  stopKnowledgeWorker,
  type KnowledgeWorkerPlan,
} from "../runtime/knowledge/worker-client.ts";
import { knowledgeLock } from "../runtime/knowledge/queue.ts";

import { knowledgeEmbeddingModel, knowledgeModelPlan } from "../runtime/knowledge/models.ts";

const initialStatus: KnowledgeStatus = {
  state: "idle",
  lastUpdatedAt: null,
  documents: 0,
  needsEmbedding: 0,
  error: null,
  backend: null,
  devices: [],
};
const workerStatusSchema = z.object({
  documents: z.number().int().nonnegative(),
  needsEmbedding: z.number().int().nonnegative(),
  backend: z.string().nullable(),
  devices: z.array(z.string()),
});
const workerSearchSchema = workerStatusSchema.extend({
  hits: z
    .array(
      z.object({
        sourceId: z.string(),
        path: z.string(),
        hash: z.string(),
        score: z.number(),
      }),
    )
    .max(40),
});
export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function knowledgeDir(agentId: string) {
  return resolve(dataDir, "knowledge", hash(agentId));
}
function config(agentId: string) {
  const row = db.select().from(knowledgeConfigs).where(eq(knowledgeConfigs.agentId, agentId)).get();
  return row ? { ...row, settings: knowledgeSettingsSchema.parse(row.settings) } : undefined;
}
export function knowledgeEnabled(agentId: string) {
  return config(agentId)?.settings.enabled === true;
}
/** Metadata only: building a prompt must not read notes or start a qmd worker. */
export function knowledgePromptContext(userId: string, agentId: string) {
  const agent = readVisibleAgent(userId, agentId);
  if (!agent?.permissions.read || !knowledgeEnabled(agentId)) return undefined;
  return {
    permissions: agent.permissions,
    sources: db
      .select({
        id: knowledgeSources.id,
        name: knowledgeSources.name,
        description: knowledgeSources.description,
      })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.agentId, agentId))
      .orderBy(knowledgeSources.createdAt, knowledgeSources.id)
      .limit(21)
      .all(),
  };
}
function requireAgent(userId: string, agentId: string, owner = false) {
  const agent = readVisibleAgent(userId, agentId);
  if (!agent) throw new KnowledgeError("Agent not found.", 404);
  if (owner && agent.ownerUserId !== userId)
    throw new KnowledgeError("Knowledge settings are owner-only.", 403);
  if (!agent.permissions.read)
    throw new KnowledgeError("Knowledge requires the agent's read permission.", 403);
  return agent;
}
function requireWrite(agent: AgentRecord, editing = false) {
  if (!(editing ? agent.permissions.edit : agent.permissions.write))
    throw new KnowledgeError(
      `Memory requires the agent's ${editing ? "edit" : "write"} permission.`,
      403,
    );
}
function sources(agentId: string) {
  return db.select().from(knowledgeSources).where(eq(knowledgeSources.agentId, agentId)).all();
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}
async function sourceRoot(agent: AgentRecord, path: string) {
  const env = new AgentExecutionEnv(agent);
  let result: string;
  try {
    result = env.resolveAuthorizedPath(path, "read");
  } catch {
    throw new KnowledgeError(
      "Source must be inside the agent workspace or a configured mount.",
      403,
    );
  }
  // Knowledge never implicitly indexes tool homes, scratch, or the application database.
  const roots = [env.hostCwd, ...agent.mounts.map((m) => resolve(m.source))];
  const canonical = await realpath(result).catch(() => {
    throw new KnowledgeError("Source directory does not exist.");
  });
  const allowed = await Promise.all(roots.map((p) => realpath(p).catch(() => p)));
  if (!allowed.some((root) => inside(root, canonical)))
    throw new KnowledgeError("Source is outside the permitted document roots.", 403);
  if (!(await stat(canonical)).isDirectory())
    throw new KnowledgeError("Choose a directory containing Markdown files.");
  if (canonical.includes(":")) throw new KnowledgeError("Source paths cannot contain colons.");
  return canonical;
}
async function plan(agent: AgentRecord, network = false): Promise<KnowledgeWorkerPlan> {
  const settings = config(agent.id)?.settings ?? knowledgeSettingsSchema.parse({});
  if (!settings.enabled) throw new KnowledgeError("Knowledge is disabled for this agent.", 409);
  const stateDir = knowledgeDir(agent.id);
  await Promise.all(
    ["notes", "home", "cache", "config"].map((p) =>
      mkdir(resolve(stateDir, p), { recursive: true }),
    ),
  );
  const registered = await Promise.all(
    sources(agent.id).map(async (s) => ({
      id: s.id,
      hostPath: await sourceRoot(agent, s.path),
      description: s.description,
    })),
  );
  const result: KnowledgeWorkerPlan = {
    agentId: agent.id,
    stateDir,
    ...(await knowledgeModelPlan()),
    settings,
    network: network && agent.permissions.network,
    sources: [
      ...registered,
      {
        id: "memories",
        hostPath: resolve(stateDir, "notes"),
        description:
          "Saved memories shared by this agent's users. Statements retain their contributor and subject.",
      },
    ],
  };
  return result;
}
function setStatus(agentId: string, patch: Partial<KnowledgeStatus>, dirty?: boolean) {
  const current = config(agentId);
  if (!current) return;
  db.update(knowledgeConfigs)
    .set({
      status: { ...current.status, ...patch },
      ...(dirty === undefined ? {} : { dirty }),
    })
    .where(eq(knowledgeConfigs.agentId, agentId))
    .run();
}
function dirty(agentId: string) {
  setStatus(agentId, {}, true);
}

// Purge every derived generation so forgotten content is not retained in old indexes.
async function purgeIndexes(agentId: string) {
  await stopKnowledgeWorker(agentId);
  await rm(resolve(knowledgeDir(agentId), "index"), {
    recursive: true,
    force: true,
  });
  setStatus(agentId, initialStatus, true);
}
export async function deleteAgentKnowledge(agentId: string) {
  return knowledgeLock(agentId, async () => {
    await stopKnowledgeWorker(agentId);
    await rm(knowledgeDir(agentId), { recursive: true, force: true });
    db.delete(knowledgeConfigs).where(eq(knowledgeConfigs.agentId, agentId)).run();
    db.delete(knowledgeSources).where(eq(knowledgeSources.agentId, agentId)).run();
    db.delete(knowledgeMemories).where(eq(knowledgeMemories.agentId, agentId)).run();
  });
}

export async function knowledgeOverview(
  userId: string,
  agentId: string,
): Promise<KnowledgeOverview> {
  requireAgent(userId, agentId);
  const current = config(agentId);
  return {
    settings: current?.settings ?? knowledgeSettingsSchema.parse({}),
    embeddingModel: knowledgeEmbeddingModel(),
    sources: sources(agentId),
    status: current?.settings.enabled ? current.status : { ...initialStatus, state: "disabled" },
    memories: await listMemories(agentId),
  };
}
/** Read navigation settings without loading memory files or starting a worker. */
export function readKnowledgeSettings(userId: string, agentId: string): KnowledgeSettings {
  requireAgent(userId, agentId);
  return config(agentId)?.settings ?? knowledgeSettingsSchema.parse({});
}
export async function saveKnowledgeSettings(
  userId: string,
  agentId: string,
  input: KnowledgeSettings,
) {
  return knowledgeLock(agentId, async () => {
    requireAgent(userId, agentId, true);
    const settings = knowledgeSettingsSchema.parse(input);
    await stopKnowledgeWorker(agentId);
    db.insert(knowledgeConfigs)
      .values({ agentId, settings, status: initialStatus, dirty: true })
      .onConflictDoUpdate({
        target: knowledgeConfigs.agentId,
        set: { settings, status: initialStatus, dirty: true },
      })
      .run();
    return settings;
  });
}
export async function addKnowledgeSource(
  userId: string,
  agentId: string,
  input: unknown,
): Promise<KnowledgeSource> {
  return knowledgeLock(agentId, async () => {
    const agent = requireAgent(userId, agentId, true);
    const data = knowledgeSourceInputSchema.parse(input);
    await sourceRoot(agent, data.path);
    if (sources(agentId).length >= 20)
      throw new KnowledgeError("An agent can register up to 20 source directories.");
    const source = {
      ...data,
      id: `s${randomUUID().replaceAll("-", "")}`,
      agentId,
      createdAt: Date.now(),
    };
    db.insert(knowledgeSources).values(source).run();
    dirty(agentId);
    await stopKnowledgeWorker(agentId);
    return source;
  });
}
export async function deleteKnowledgeSource(userId: string, agentId: string, sourceId: string) {
  return knowledgeLock(agentId, async () => {
    requireAgent(userId, agentId, true);
    db.delete(knowledgeSources)
      .where(and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.agentId, agentId)))
      .run();
    await purgeIndexes(agentId);
  });
}

async function readCanonical(agent: AgentRecord, sourceId: string, path: string) {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (p) => !p || p.startsWith(".") || ["node_modules", "vendor", "dist", "build"].includes(p),
      ) ||
    !path.endsWith(".md")
  )
    throw new KnowledgeError("Invalid document reference.", 400);
  let root: string;
  if (sourceId === "memories") {
    const memory = db
      .select()
      .from(knowledgeMemories)
      .where(
        and(
          eq(knowledgeMemories.id, path.slice(0, -3)),
          eq(knowledgeMemories.agentId, agent.id),
          isNull(knowledgeMemories.deletedAt),
        ),
      )
      .get();
    if (!memory || memory.pendingContent !== null)
      throw new KnowledgeError("Memory not found.", 404);
    root = resolve(knowledgeDir(agent.id), "notes");
  } else {
    const source = sources(agent.id).find((s) => s.id === sourceId);
    if (!source) throw new KnowledgeError("Source not found.", 404);
    root = await sourceRoot(agent, source.path);
  }
  const pathName = resolve(root, path);
  const actual = await realpath(pathName).catch(() => {
    throw new KnowledgeError("Document not found.", 404);
  });
  if (!inside(await realpath(root), actual))
    throw new KnowledgeError("Document is outside its source.", 403);
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new KnowledgeError("Document exceeds the 2 MiB read limit.");
    const content = await handle.readFile("utf8");
    return { content, revision: hash(content) };
  } finally {
    await handle.close();
  }
}
function document(
  agentId: string,
  sourceId: string,
  path: string,
  text: { content: string; revision: string },
  fromLine: number,
  maxLines: number,
): KnowledgeDocument {
  const lines = text.content.split(/\r?\n/);
  const params = new URLSearchParams({
    source: sourceId,
    path,
    line: String(fromLine),
  });
  return {
    sourceId,
    path,
    title: lines.find((l) => l.startsWith("# "))?.slice(2) ?? path,
    content: lines
      .slice(fromLine - 1, fromLine - 1 + maxLines)
      .join("\n")
      .slice(0, 30_000),
    revision: text.revision,
    fromLine,
    totalLines: lines.length,
    citation: `/agents/${encodeURIComponent(agentId)}/knowledge?${params}`,
  };
}
export async function readKnowledge(
  userId: string,
  agentId: string,
  input: KnowledgeReadInput,
): Promise<KnowledgeDocument> {
  const agent = requireAgent(userId, agentId);
  const args = knowledgeReadSchema.parse(input);
  const result = await readCanonical(agent, args.sourceId, args.path);
  requireAgent(userId, agentId);
  return document(agentId, args.sourceId, args.path, result, args.fromLine, args.maxLines);
}

export async function searchKnowledge(
  userId: string,
  agentId: string,
  input: KnowledgeSearchInput,
  signal?: AbortSignal,
): Promise<KnowledgeSearchResult> {
  return knowledgeLock(agentId, async () => {
    const agent = requireAgent(userId, agentId);
    const args = knowledgeSearchSchema.parse(input);
    const workerPlan = await plan(agent);
    const ids = workerPlan.sources.map((s) => s.id);
    if (args.sourceId && !ids.includes(args.sourceId))
      throw new KnowledgeError("Source not found.", 404);
    const request = {
      op: "search",
      query: args.query,
      mode: args.mode,
      collections: args.sourceId ? [args.sourceId] : ids,
      limit: args.limit * 2,
    };
    let mode = args.mode;
    let warning: string | undefined;
    let response;
    try {
      response = workerSearchSchema.parse(
        await (mode === "fast"
          ? callKnowledgeWorker(workerPlan, request, signal)
          : knowledgeLock("$gpu", () => callKnowledgeWorker(workerPlan, request, signal))),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (mode === "fast")
        throw new KnowledgeError(
          error instanceof Error ? error.message : "Knowledge runner unavailable.",
          503,
        );
      mode = "fast";
      warning = `Semantic retrieval unavailable; showing keyword results. ${error instanceof Error ? error.message : ""}`;
      try {
        response = workerSearchSchema.parse(
          await callKnowledgeWorker(workerPlan, { ...request, mode }, signal),
        );
      } catch {
        throw new KnowledgeError(
          "Knowledge runner unavailable. No search results could be retrieved.",
          503,
        );
      }
    }
    setStatus(agentId, {
      documents: response.documents,
      needsEmbedding: response.needsEmbedding,
      backend: response.backend,
      devices: response.devices,
    });
    const currentAgent = requireAgent(userId, agentId);
    const hits: KnowledgeSearchResult["hits"] = [];
    const seen = new Set<string>();
    for (const hit of response.hits) {
      if (!ids.includes(hit.sourceId) || (args.sourceId && hit.sourceId !== args.sourceId))
        continue;
      const key = `${hit.sourceId}/${hit.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const text = await readCanonical(currentAgent, hit.sourceId, hit.path);
        if (hit.hash !== text.revision) {
          dirty(agentId);
          warning ??= "Some indexed documents changed. Refresh the index for current matches.";
          continue;
        }
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const line = Math.max(
          1,
          text.content
            .split(/\r?\n/)
            .findIndex((l) => words.some((w) => l.toLowerCase().includes(w))) - 1,
        );
        const doc = document(agentId, hit.sourceId, hit.path, text, line, 12);
        const { content, ...rest } = doc;
        hits.push({
          ...rest,
          excerpt: content.slice(0, 1800),
          score: hit.score,
          sourceName:
            hit.sourceId === "memories"
              ? "Saved memories"
              : (sources(agentId).find((s) => s.id === hit.sourceId)?.name ?? "Source"),
        });
        if (hits.length >= args.limit) break;
      } catch {
        dirty(agentId);
      }
    }
    if (!config(agentId)?.status.lastUpdatedAt) warning ??= "The index has not been refreshed yet.";
    return { hits, mode, ...(warning ? { warning } : {}) };
  });
}

export async function refreshKnowledge(
  userId: string,
  agentId: string,
  embed: boolean,
  allowDownloads = false,
  deep = false,
) {
  requireAgent(userId, agentId, true);
  if (jobs.has(agentId)) throw new KnowledgeError("Knowledge maintenance is already running.", 409);
  if (!knowledgeEnabled(agentId)) throw new KnowledgeError("Enable knowledge first.", 409);
  const job = knowledgeLock(agentId, async () => {
    const agent = requireAgent(userId, agentId, true);
    try {
      setStatus(agentId, { state: "updating", error: null });
      await recoverMemories(agentId);
      const workerPlan = await plan(agent, allowDownloads);
      const updated = workerStatusSchema.parse(
        await callKnowledgeWorker(workerPlan, { op: "update" }, maintenance.signal),
      );
      setStatus(
        agentId,
        { ...updated, lastUpdatedAt: Date.now(), state: "ready", error: null },
        false,
      );
      if (deep) {
        setStatus(agentId, { state: "embedding" });
        await callKnowledgeWorker(workerPlan, { op: "prepare" }, maintenance.signal);
        setStatus(agentId, { state: "ready" });
      }
      if (embed) {
        setStatus(agentId, { state: "embedding" });
        const embedded = workerStatusSchema.parse(
          await knowledgeLock("$gpu", () =>
            callKnowledgeWorker(workerPlan, { op: "embed" }, maintenance.signal),
          ),
        );
        setStatus(agentId, { ...embedded, state: "ready" });
      }
    } catch (error) {
      setStatus(agentId, {
        state: "error",
        error: String(error instanceof Error ? error.message : error).slice(0, 2000),
      });
    }
  });
  jobs.set(agentId, job);
  void job.finally(() => jobs.delete(agentId)).catch(() => {});
}
const jobs = new Map<string, Promise<void>>();
let maintenance = new AbortController();
let timer: ReturnType<typeof setInterval> | undefined;
export function startKnowledgeScheduler() {
  maintenance = new AbortController();
  for (const row of db.select().from(knowledgeConfigs).all())
    if (row.settings.enabled) setStatus(row.agentId, { state: "idle" }, true);
  timer = setInterval(
    () =>
      void tickKnowledge().catch((error) => console.error("Knowledge maintenance failed", error)),
    30_000,
  );
  timer.unref();
}
export async function tickKnowledge() {
  // One background index scan at a time. Failed jobs retry after a bounded delay.
  if (jobs.size || maintenance.signal.aborted) return;
  for (const row of db.select().from(knowledgeConfigs).all()) {
    if (!row.settings.enabled) continue;
    if (!row.dirty && Date.now() - (row.status.lastUpdatedAt ?? 0) < 5 * 60_000) continue;
    const agent = db.select().from(agents).where(eq(agents.id, row.agentId)).get();
    if (!agent?.permissions.read) continue;
    if (row.status.state === "error" && Date.now() - (lastRetry.get(agent.id) ?? 0) < 5 * 60_000)
      continue;
    lastRetry.set(agent.id, Date.now());
    await refreshKnowledge(agent.ownerUserId, agent.id, false).catch(() => {});
    break;
  }
}
const lastRetry = new Map<string, number>();
export async function stopKnowledgeScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
  maintenance.abort();
  await Promise.allSettled(jobs.values());
}
export async function waitKnowledgeJob(agentId: string) {
  await jobs.get(agentId);
}

async function recoverMemories(agentId: string) {
  await mkdir(resolve(knowledgeDir(agentId), "notes"), { recursive: true });
  const rows = db
    .select()
    .from(knowledgeMemories)
    .where(eq(knowledgeMemories.agentId, agentId))
    .all();
  for (const row of rows) {
    const path = resolve(knowledgeDir(agentId), "notes", `${row.id}.md`);
    if (row.deletedAt) {
      await rm(path, { force: true });
      continue;
    }
    if (row.pendingContent === null) continue;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, row.pendingContent, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
    db.update(knowledgeMemories)
      .set({ pendingContent: null })
      .where(eq(knowledgeMemories.id, row.id))
      .run();
  }
}
async function listMemories(agentId: string): Promise<SavedMemory[]> {
  const rows = db
    .select()
    .from(knowledgeMemories)
    .where(and(eq(knowledgeMemories.agentId, agentId), isNull(knowledgeMemories.deletedAt)))
    .all();
  return Promise.all(
    rows
      .filter((r) => r.pendingContent === null)
      .map(async (row) => ({
        id: row.id,
        agentId,
        title: row.title,
        content: (
          await readFile(resolve(knowledgeDir(agentId), "notes", `${row.id}.md`), "utf8")
        ).replace(/^# [^\n]*\n\n/, ""),
        revision: row.revision,
        contributorId: row.contributorId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
  );
}
export async function saveMemory(
  userId: string,
  agentId: string,
  input: MemoryInput,
  memoryId?: string,
): Promise<SavedMemory> {
  return knowledgeLock(agentId, async () => {
    const agent = requireAgent(userId, agentId);
    requireWrite(agent, Boolean(memoryId));
    if (!knowledgeEnabled(agentId))
      throw new KnowledgeError("Enable knowledge before saving memories.", 409);
    const data = memoryInputSchema.parse(input);
    await recoverMemories(agentId);
    const previous = memoryId
      ? db
          .select()
          .from(knowledgeMemories)
          .where(
            and(
              eq(knowledgeMemories.id, memoryId),
              eq(knowledgeMemories.agentId, agentId),
              isNull(knowledgeMemories.deletedAt),
            ),
          )
          .get()
      : undefined;
    if (memoryId && !previous) throw new KnowledgeError("Memory not found.", 404);
    if (previous && data.expectedRevision !== previous.revision)
      throw new KnowledgeError("Memory changed. Reload before editing.", 409);
    const content = `# ${data.title.replaceAll("\n", " ")}\n\n${data.content}\n`;
    const at = Date.now();
    const id = previous?.id ?? `m${randomUUID().replaceAll("-", "")}`;
    const row = {
      id,
      agentId,
      title: data.title,
      revision: hash(content),
      contributorId: userId,
      pendingContent: content,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    // Persist intent first. A crash during the filesystem write is replayed before indexing.
    db.insert(knowledgeMemories)
      .values(row)
      .onConflictDoUpdate({ target: knowledgeMemories.id, set: row })
      .run();
    dirty(agentId);
    await recoverMemories(agentId);
    return (await listMemories(agentId)).find((m) => m.id === id)!;
  });
}
export async function forgetMemory(
  userId: string,
  agentId: string,
  memoryId: string,
  expectedRevision: string,
) {
  return knowledgeLock(agentId, async () => {
    const agent = requireAgent(userId, agentId);
    requireWrite(agent, true);
    const previous = db
      .select()
      .from(knowledgeMemories)
      .where(
        and(
          eq(knowledgeMemories.id, memoryId),
          eq(knowledgeMemories.agentId, agentId),
          isNull(knowledgeMemories.deletedAt),
        ),
      )
      .get();
    if (!previous) throw new KnowledgeError("Memory not found.", 404);
    if (previous.revision !== expectedRevision)
      throw new KnowledgeError("Memory changed. Reload before forgetting it.", 409);
    db.update(knowledgeMemories)
      .set({ deletedAt: Date.now(), pendingContent: null })
      .where(eq(knowledgeMemories.id, memoryId))
      .run();
    await purgeIndexes(agentId);
    await recoverMemories(agentId);
  });
}
