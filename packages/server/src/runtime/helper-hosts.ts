import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  InboxDoc,
  LiveDoc,
  defineExtension,
  section,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { helperHosts, sessions } from "../db/schema.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { resolveRunModel } from "../services/model-context.ts";
import { closePiSession, openPiSession, type PiSession } from "../services/pi-session-storage.ts";
import { createServerExecution } from "./tools.ts";
import { createSessionSearchTools } from "./session-search-tools.ts";
import {
  createHelperExtension,
  helperReadTools,
  helperTasks,
  readHelpers,
  stopHelper,
} from "./helpers.ts";
import { getActiveAgentRunForSessionId } from "./run-stream.ts";
import { compactionSettingsForWindow } from "../effectors/compaction-policy.ts";

type Execution = ReturnType<typeof createServerExecution>;
type HeldHost = {
  session: PiSession;
  cleanups: Array<() => Promise<void>>;
  agentRevision?: number;
};
const held = new Map<string, HeldHost>();
const preparing = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;

export async function retainHelperHost(session: PiSession, execution: Execution) {
  if (
    stopped ||
    !(await readHelpers(session)).some(
      (helper) => helper.background && ["working", "sleeping", "reporting"].includes(helper.status),
    )
  )
    return false;
  let host = held.get(session.id);
  if (!host) {
    const row = db.select().from(sessions).where(eq(sessions.id, session.id)).get();
    host = {
      session: await openPiSession(session.id),
      cleanups: [],
      agentRevision: row ? readVisibleAgent(row.userId, row.agentId)?.updatedAt : undefined,
    };
    held.set(session.id, host);
  }
  host.cleanups.push(() => execution.cleanup(BACKGROUND_CONTEXT));
  db.insert(helperHosts)
    .values({ sessionId: session.id, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: helperHosts.sessionId,
      set: { error: null, updatedAt: Date.now() },
    })
    .run();
  return true;
}

async function configureHost(host: HeldHost) {
  const row = db.select().from(sessions).where(eq(sessions.id, host.session.id)).get();
  if (!row) throw new Error("The subtask's session is unavailable.");
  const agent = readVisibleAgent(row.userId, row.agentId);
  if (!agent) throw new Error("This agent is no longer available. Stop its subtasks.");
  const model = await resolveRunModel(row.userId, row.modelRefId, row.thinkingLevel);
  if (!model.ok) throw new Error("Configure the session's model, then resume its subtasks.");
  const execution = createServerExecution(agent, undefined, row.userId, row.id);
  try {
    await execution.prepare();
    const tools = execution
      .resolveTools(createSessionSearchTools(row.userId, row.agentId))
      .filter((tool) => helperReadTools.has(tool.name));
    const carmel = defineExtension({
      name: "carmel",
      tools,
      sections: [
        section(
          "system",
          () => agent.systemPrompt || "You are a helpful read-only research assistant.",
          { tag: false },
        ),
      ],
    });
    const extension = createHelperExtension({
      sessionId: row.id,
      userId: row.userId,
      agentId: row.agentId,
    });
    host.session.registry.install(carmel);
    host.session.registry.install(helperTasks);
    host.session.registry.install(extension);
    host.session.models = model.value.modelRuntime;
    host.session.env = execution.env;
    host.session.settings = {
      extensions: [carmel, helperTasks, extension],
      retry: { maxRetries: 2 },
      compaction: compactionSettingsForWindow(model.value.model.contextWindow),
    };
    for (const helper of await readHelpers(host.session)) {
      if (!helper.background || !["working", "sleeping", "reporting"].includes(helper.status))
        continue;
      const child = await host.session.native.conversation(
        helper.id as ConversationId,
        BACKGROUND_CONTEXT,
      );
      await child?.configure(
        {
          model: { provider: model.value.model.provider, modelId: model.value.model.id },
          tools,
          modelTools: tools,
          extensions: [carmel, helperTasks],
        },
        BACKGROUND_CONTEXT,
      );
    }
    host.agentRevision = agent.updatedAt;
    host.cleanups.push(() => execution.cleanup(BACKGROUND_CONTEXT));
  } catch (error) {
    await execution.cleanup(BACKGROUND_CONTEXT);
    throw error;
  }
}

async function releaseHost(sessionId: string) {
  const host = held.get(sessionId);
  if (!host) return;
  held.delete(sessionId);
  await closePiSession(host.session);
  await Promise.allSettled(host.cleanups.map((cleanup) => cleanup()));
}

export async function resumeHelperHost(sessionId: string, retry = false) {
  if (stopped || preparing.has(sessionId) || getActiveAgentRunForSessionId(sessionId)) return;
  preparing.add(sessionId);
  try {
    let host = held.get(sessionId);
    if (!host) {
      host = { session: await openPiSession(sessionId), cleanups: [] };
      held.set(sessionId, host);
      const pending = await host.session.conversation.commit(
        async (tx) =>
          Boolean(
            (await tx.doc(LiveDoc, host!.session.conversation.id)).run ||
            (await tx.doc(InboxDoc, host!.session.conversation.id)).items.length,
          ),
        BACKGROUND_CONTEXT,
      );
      if (pending)
        throw new Error(
          "Resume or stop the unfinished parent conversation before recovering its subtasks.",
        );
      const helpers = await readHelpers(host.session);
      if (
        !helpers.some(
          (helper) =>
            helper.background && ["working", "sleeping", "reporting"].includes(helper.status),
        )
      ) {
        db.delete(helperHosts).where(eq(helperHosts.sessionId, sessionId)).run();
        await releaseHost(sessionId);
        return;
      }
      await configureHost(host);
    }
    const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    const agent = row ? readVisibleAgent(row.userId, row.agentId) : undefined;
    if (!agent) throw new Error("This agent is no longer available. Stop its subtasks.");
    if (host.agentRevision !== undefined && host.agentRevision !== agent.updatedAt)
      await configureHost(host);
    if (retry) {
      const inspection = await host.session.native.inspect(BACKGROUND_CONTEXT);
      for (const task of inspection.tasks)
        if (task.state.kind === "blocked" && task.state.reason === "restart_limit")
          await host.session.native.retryTask(task.record.id, BACKGROUND_CONTEXT);
    }
    host.session.native.resume();
    const inspection = await host.session.native.inspect(BACKGROUND_CONTEXT);
    if (inspection.tasks.some((task) => task.state.kind === "blocked"))
      throw new Error(
        "A helper task is blocked. Inspect it, then stop it or retry after fixing its configuration.",
      );
    if (!inspection.tasks.length && !inspection.submissions.length) {
      db.delete(helperHosts).where(eq(helperHosts.sessionId, sessionId)).run();
      await releaseHost(sessionId);
    } else
      db.update(helperHosts).set({ error: null }).where(eq(helperHosts.sessionId, sessionId)).run();
  } catch (error) {
    db.update(helperHosts)
      .set({ error: error instanceof Error ? error.message : "Unable to recover helpers." })
      .where(eq(helperHosts.sessionId, sessionId))
      .run();
    await releaseHost(sessionId);
  } finally {
    preparing.delete(sessionId);
  }
}

export function startHelperHosts() {
  stopped = false;
  timer ??= setInterval(() => {
    for (const row of db.select().from(helperHosts).all())
      if (!row.error) void resumeHelperHost(row.sessionId);
  }, 500);
  timer.unref();
}

export function pauseHelperHosts() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
}
export async function shutdownHelperHosts() {
  pauseHelperHosts();
  await Promise.allSettled([...held.keys()].map(releaseHost));
}

export async function stopAllHelpers(sessionId: string) {
  const pi = await openPiSession(sessionId);
  try {
    pi.registry.install(helperTasks);
    const helpers = await readHelpers(pi);
    for (const helper of helpers)
      if (["working", "sleeping", "reporting"].includes(helper.status))
        await stopHelper(pi, helper.id);
    db.delete(helperHosts).where(eq(helperHosts.sessionId, sessionId)).run();
  } finally {
    await closePiSession(pi);
    await releaseHost(sessionId);
  }
}
