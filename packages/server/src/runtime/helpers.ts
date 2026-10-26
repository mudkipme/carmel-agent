import { readVisibleAgent } from "../services/agent-access.ts";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type TaskId,
  type Extension,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { helperHosts } from "../db/schema.ts";
import { publishHomeEvent } from "../services/home-events.ts";
import { withPiSession, type PiSession } from "../services/pi-session-storage.ts";

export type HelperRecord = {
  userId: string;
  agentId: string;
  callId: number;
  id: number;
  parentId: number;
  name: string;
  task: string;
  background: boolean;
  createdAt: number;
  wakeAt: number;
  deadline: number;
  status: "working" | "sleeping" | "reporting" | "done" | "failed" | "stopped";
  reporterId?: number;
  answer?: string;
  reportEntry?: number;
};
export const Helpers = defineDoc({
  kind: "carmel.helpers",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} as Record<string, HelperRecord> }),
  checkpointWhen: () => false,
});
export const helperReadTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "knowledge_search",
  "knowledge_read",
  "session_search",
  "session_read",
  "load_builtin_skill",
]);

const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "carmel.helper-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type ReporterInput = { sessionId: string; userId: string; agentId: string; helperId: number };
type ReporterState =
  | { phase: "wait" }
  | { phase: "work" }
  | { phase: "report"; answer: string; failed: boolean };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "carmel.helper-reporter",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const helper = (await runtime.snapshot(Helpers, context))!.items[
        String(task.input.helperId)
      ]!;
      await runtime.sleepUntil(helper.wakeAt, { phase: "work" }, context);
    },
    work: async (task, runtime, context) => {
      const helper = (await runtime.snapshot(Helpers, context))!.items[
        String(task.input.helperId)
      ]!;
      const child = (await runtime.conversation(helper.id as ConversationId, context))!;
      if (runtime.now() >= helper.deadline) {
        await child.abort(context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "report",
              answer: "The helper reached its five-minute limit.",
              failed: true,
            },
          }),
          context,
        );
        return;
      }
      await runtime.commit(async (tx) => {
        (await tx.doc(Helpers)).items[String(helper.id)]!.status = "working";
      }, context);
      const cancelTimer = runtime.setTimer(() => {
        void child.abort(context).catch(() => {});
      }, helper.deadline - runtime.now());
      try {
        const settled = await (
          await child.submit(
            { type: "input", content: helper.task, requestId: `helper:${task.id}` },
            context,
          )
        ).wait(context);
        if (settled.status === "done" && settled.type === "input")
          await runtime.commit(async (tx) => {
            const entry = await tx.entry(settled.answer);
            const message = entry?.model?.[0];
            const text =
              message?.role === "assistant"
                ? message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                : "";
            return {
              status: "running",
              checkpoint: { phase: "report", answer: text.slice(0, 12000), failed: false },
            };
          }, context);
        else
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                phase: "report",
                answer: `The helper ${runtime.now() >= helper.deadline ? "reached its time limit" : settled.status === "unanswered" ? settled.reason : "stopped"}.`,
                failed: true,
              },
            }),
            context,
          );
      } finally {
        cancelTimer();
      }
    },
    report: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      if (checkpoint.phase !== "report") return;
      const helper = (await runtime.snapshot(Helpers, context))!.items[
        String(task.input.helperId)
      ]!;
      const text = `**${helper.name}** ${checkpoint.failed ? "stopped" : "finished"}.\n\n${checkpoint.answer}\n\n[Open helper](/agents/${task.input.agentId}/sessions/${task.input.sessionId}/helpers/${helper.id})`;
      await runtime.commit(async (tx) => {
        const record = (await tx.doc(Helpers)).items[String(helper.id)]!;
        if (!record.reportEntry)
          record.reportEntry = (
            await tx.appendEntry(helper.parentId as ConversationId, {
              kind: "carmel.helper-result",
              data: { text, timestamp: runtime.now() },
            })
          ).id;
        record.status = "reporting";
      }, context);
      publishHomeEvent(task.input.userId, task.input.agentId, {
        sourceKey: `helper:${task.input.sessionId}:${task.id}`,
        kind: "issue",
        text,
      });
      await runtime.commit(async (tx) => {
        const record = (await tx.doc(Helpers)).items[String(helper.id)]!;
        record.status = checkpoint.failed ? "failed" : "done";
        record.answer = checkpoint.answer;
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    const child = await runtime.conversation(task.input.helperId as ConversationId, context);
    await child?.abort(context);
    await runtime.commit(async (tx) => {
      const helper = (await tx.doc(Helpers)).items[String(task.input.helperId)];
      if (helper) helper.status = "stopped";
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

export const helperTasks: Extension = defineExtension({
  name: "carmel-helper-tasks",
  tasks: [Anchor, Reporter],
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const helper = (await api.snapshot(Helpers, context))?.items[String(api.conversationId)];
        if (!helper) return;
        const agent = readVisibleAgent(helper.userId, helper.agentId);
        if (!agent) return { block: "This agent is no longer available." };
        if (
          [
            "read",
            "grep",
            "find",
            "ls",
            "knowledge_search",
            "knowledge_read",
            "load_builtin_skill",
          ].includes(call.name) &&
          !agent.permissions.read
        )
          return { block: "Read permission is disabled for this agent." };
        return undefined;
      },
    }),
  ],
});

export function createHelperExtension(owner: {
  sessionId: string;
  userId: string;
  agentId: string;
}): Extension {
  return defineExtension({
    name: "carmel-helpers",
    tools: [
      defineTool({
        name: "start_helper",
        description:
          "Delegate bounded read-only research or analysis to a helper of this same agent. Pass a self-contained task and relevant constraints. Helpers cannot edit files, browse, send messages, create issues, or delegate. Up to four may work at once; each has five minutes. Foreground returns its answer; background continues after this reply and reports to Home. wakeAt is optional UTC epoch milliseconds for a background helper to wake later.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 100 }),
          task: Type.String({ minLength: 1, maxLength: 16000 }),
          background: Type.Optional(Type.Boolean()),
          wakeAt: Type.Optional(Type.Number()),
        }),
        replay: "safe",
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const parent = await api.agent(context);
          const enabled = parent.tools.filter((tool) => helperReadTools.has(tool.name));
          const background = args.background === true;
          const wakeAt = args.wakeAt ?? api.now();
          if ((!background && wakeAt > api.now()) || wakeAt > api.now() + 7 * 86400000)
            throw new Error("Delayed helpers must be background work and wake within seven days.");
          if (background)
            db.insert(helperHosts)
              .values({ sessionId: owner.sessionId, updatedAt: Date.now() })
              .onConflictDoNothing()
              .run();
          const helper = await api.commit(async (tx) => {
            const state = await tx.doc(Helpers);
            for (const item of Object.values(state.items)) {
              if (!item.background && item.status === "working") {
                const call = await tx.task(item.callId as TaskId);
                if (call?.state.status === "terminal") item.status = "stopped";
              }
            }
            const existing = Object.values(state.items).find((item) => item.callId === api.taskId);
            if (existing) return existing;
            if (
              Object.values(state.items).filter((item) =>
                ["working", "sleeping", "reporting"].includes(item.status),
              ).length >= 4
            )
              throw new Error("Four helpers are already active. Wait for one or stop it.");
            const ownership = background
              ? {
                  kind: "task" as const,
                  taskId: await tx.createTask(Anchor, null, {
                    ownership: { kind: "conversation" },
                    background: true,
                  }),
                }
              : { kind: "task" as const, taskId: api.taskId };
            const child = await tx.createConversation({ ownership });
            await configure(tx, child.id, {
              tools: enabled,
              modelTools: enabled,
              extensions: { remove: [HelpersExtensionPlaceholder] },
              instructions: `You are the read-only helper ${args.name}. Complete only the supplied task. Return a concise answer with evidence and uncertainties. You share this agent's readable files; you have no private filesystem copy. Do not ask the user questions or delegate.`,
            });
            const record: HelperRecord = {
              userId: owner.userId,
              agentId: owner.agentId,
              callId: api.taskId,
              id: child.id,
              parentId: api.conversationId,
              name: args.name,
              task: args.task,
              background,
              createdAt: api.now(),
              wakeAt: Math.max(wakeAt, api.now()),
              deadline: Math.max(wakeAt, api.now()) + 300000,
              status: wakeAt > api.now() ? "sleeping" : "working",
            };
            if (background)
              record.reporterId = await tx.createTask(
                Reporter,
                { ...owner, helperId: child.id },
                { ownership: { kind: "conversation" }, background: true },
              );
            state.items[String(child.id)] = record;
            return { ...record };
          }, context);
          await api.details({ conversationId: helper.id, sessionId: owner.sessionId }, context);
          if (background)
            return {
              output: [
                {
                  type: "text",
                  text: JSON.stringify({
                    helperId: helper.id,
                    status: helper.status,
                    link: `/agents/${owner.agentId}/sessions/${owner.sessionId}/helpers/${helper.id}`,
                  }),
                },
              ],
            };
          const child = (await api.conversation(helper.id as ConversationId, context))!;
          if (api.now() >= helper.deadline) {
            await child.abort(context);
            const answer = "The helper reached its five-minute limit.";
            await api.commit(async (tx) => {
              const record = (await tx.doc(Helpers)).items[String(helper.id)]!;
              record.status = "failed";
              record.answer = answer;
            }, context);
            return { output: [{ type: "text", text: answer }] };
          }
          const timeout = setTimeout(
            () => {
              void child.abort(BACKGROUND_CONTEXT).catch(() => {});
            },
            Math.max(0, helper.deadline - api.now()),
          );
          try {
            const settled = await (
              await child.submit(
                { type: "input", content: args.task, requestId: `helper:${api.taskId}` },
                context,
              )
            ).wait(context);
            const answer = await api.commit(async (tx) => {
              const record = (await tx.doc(Helpers)).items[String(helper.id)]!;
              const entry =
                settled.status === "done" && settled.type === "input"
                  ? await tx.entry(settled.answer)
                  : undefined;
              const message = entry?.model?.[0];
              record.status =
                settled.status === "done"
                  ? "done"
                  : settled.status === "unanswered" && settled.reason === "aborted"
                    ? "stopped"
                    : "failed";
              record.answer =
                message?.role === "assistant"
                  ? message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n")
                      .slice(0, 12000)
                  : "The helper stopped without an answer.";
              return record.answer;
            }, context);
            return { output: [{ type: "text", text: answer }] };
          } finally {
            clearTimeout(timeout);
          }
        },
      }),
      defineTool({
        name: "helper_status",
        description: "List this conversation's helpers and their answers or progress.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => ({
          output: [
            {
              type: "text",
              text: JSON.stringify(
                Object.values((await api.snapshot(Helpers, context))?.items ?? {}).filter(
                  (helper) => helper.parentId === api.conversationId,
                ),
              ),
            },
          ],
        }),
      }),
      defineTool({
        name: "stop_helper",
        description:
          "Stop a selected helper of this conversation, including a helper waiting to wake later.",
        parameters: Type.Object({ helperId: Type.Number() }),
        replay: "unsafe",
        execute: async (args, api, context) => {
          const helper = (await api.snapshot(Helpers, context))?.items[String(args.helperId)];
          if (!helper || helper.parentId !== api.conversationId)
            throw new Error("Select a helper of this conversation.");
          await withPiSession(owner.sessionId, (pi) => stopHelper(pi, helper.id));
          return { output: [{ type: "text", text: "Helper stopped." }] };
        },
      }),
      defineTool({
        name: "send_helper",
        description: "Send a steering update to a selected active helper of this conversation.",
        parameters: Type.Object({
          helperId: Type.Number(),
          text: Type.String({ minLength: 1, maxLength: 16000 }),
        }),
        replay: "unsafe",
        execute: async (args, api, context) => {
          const helper = (await api.snapshot(Helpers, context))?.items[String(args.helperId)];
          if (
            !helper ||
            helper.parentId !== api.conversationId ||
            !["working", "sleeping"].includes(helper.status)
          )
            throw new Error("Select an active helper of this conversation.");
          if (helper.status === "sleeping") {
            await api.commit(async (tx) => {
              (await tx.doc(Helpers)).items[String(helper.id)]!.task += `\n\nUpdate: ${args.text}`;
            }, context);
          } else
            await (await api.conversation(helper.id as ConversationId, context))!.submit(
              {
                type: "input",
                content: args.text,
                whenBusy: "steer",
                requestId: `helper-update:${api.taskId}`,
              },
              context,
            );
          return { output: [{ type: "text", text: "Update sent." }] };
        },
      }),
    ],
  });
}

const HelpersExtensionPlaceholder = defineExtension({ name: "carmel-helpers" });

export async function readHelpers(session: PiSession) {
  return session.native.commit(async (tx) => {
    const helpers = Object.values((await tx.doc(Helpers)).items);
    for (const helper of helpers) {
      if (!helper.background && helper.status === "working") {
        const call = await tx.task(helper.callId as TaskId);
        if (call?.state.status === "terminal") helper.status = "stopped";
      }
    }
    return helpers.map((helper) => ({ ...helper }));
  }, BACKGROUND_CONTEXT);
}

export async function stopHelper(session: PiSession, helperId: number) {
  const helper = (await readHelpers(session)).find((item) => item.id === helperId);
  if (!helper) throw new Error("Helper not found.");
  session.registry.install(helperTasks);
  if (helper.reporterId)
    await session.native.abortTask(helper.reporterId as TaskId, BACKGROUND_CONTEXT);
  const child = await session.native.conversation(helper.id as ConversationId, BACKGROUND_CONTEXT);
  await child?.abort(BACKGROUND_CONTEXT);
  if (helper.reporterId)
    await session.native.waitForTask(helper.reporterId as TaskId, BACKGROUND_CONTEXT);
  await session.native.commit(async (tx) => {
    (await tx.doc(Helpers)).items[String(helper.id)]!.status = "stopped";
  }, BACKGROUND_CONTEXT);
  db.update(helperHosts)
    .set({ updatedAt: Date.now() })
    .where(eq(helperHosts.sessionId, session.id))
    .run();
}
