import { z } from "zod";
import { issueCreateSchema, issuePatchSchema, issueRunSchema } from "@carmel-agent/shared";
import type { Context } from "@earendil-works/chord";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getCurrentSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import type { ToolRegistration } from "../effectors/pi-durable/index.ts";
import type { PiSession } from "../services/pi-session-storage.ts";
import {
  compactionSettingsForWindow,
  homeCompactionExtension,
} from "../effectors/compaction-policy.ts";
import {
  createIssue,
  readIssues,
  readIssueView,
  runIssue,
  updateIssue,
  addIssueNote,
  sendIssueUpdate,
  moveQueuedIssue,
  interruptIssue,
  removeIssueFromQueue,
} from "../services/issues.ts";

const taskId = z.object({ taskId: z.string().min(1) }).strict();
export function createHomeTools(userId: string, agentId: string): ToolRegistration[] {
  const tool = (
    name: string,
    description: string,
    schema: z.ZodType,
    execute: (args: unknown) => unknown,
    read = false,
  ): ToolRegistration => ({
    name,
    description,
    parameters: z.toJSONSchema(schema) as never,
    executionMode: "sequential",
    replay: read ? "safe" : "unsafe",
    async execute(args) {
      const value = await execute(schema.parse(args));
      return { output: [{ type: "text", text: JSON.stringify(value) }] };
    },
  });
  return [
    tool(
      "list_tasks",
      "List this user's tasks for this agent, including queue and review state.",
      z.object({}).strict(),
      () => readIssues(userId, agentId),
      true,
    ),
    tool(
      "read_task",
      "Read a task's brief, discussion, saved attempt results, and evidence.",
      taskId,
      (args) => readIssueView(userId, agentId, taskId.parse(args).taskId),
      true,
    ),
    tool(
      "create_task",
      "Create a bounded background job. Set queue=true to start it. Include the user's relevant constraints and acceptance criteria. notifyPlatform is only for a requested external notification; omit otherwise. Results return to Home. Only the user accepts completed work.",
      issueCreateSchema,
      (args) => createIssue(userId, agentId, issueCreateSchema.parse(args)),
    ),
    tool(
      "queue_task",
      "Queue/retry an existing task. Revisions reuse its conversation unless fresh is explicitly requested.",
      taskId.extend({
        instructions: z.string().max(40000).optional(),
        fresh: z.boolean().optional(),
      }),
      (args) => {
        const value = taskId
          .extend({ instructions: z.string().optional(), fresh: z.boolean().optional() })
          .parse(args);
        return runIssue(
          userId,
          agentId,
          value.taskId,
          issueRunSchema.parse({ instructions: value.instructions, fresh: value.fresh }),
        );
      },
    ),
    tool(
      "update_task",
      "Revise an idle task's brief or criteria. Running work takes an update instead.",
      taskId.extend({ patch: issuePatchSchema }),
      (args) => {
        const value = taskId.extend({ patch: issuePatchSchema }).parse(args);
        return updateIssue(userId, agentId, value.taskId, value.patch);
      },
    ),
    tool(
      "send_task_update",
      "Send an instruction to the explicitly selected running issue, or save a note for its next run.",
      taskId.extend({ text: z.string().min(1).max(40000), sendNow: z.boolean().default(false) }),
      (args) => {
        const value = taskId.extend({ text: z.string(), sendNow: z.boolean() }).parse(args);
        return value.sendNow
          ? sendIssueUpdate(userId, agentId, value.taskId, value.text)
          : addIssueNote(userId, agentId, value.taskId, value.text);
      },
    ),
    tool(
      "move_task",
      "Move this user's queued task up or down in the agent queue.",
      taskId.extend({ direction: z.enum(["up", "down"]) }),
      (args) => {
        const value = taskId.extend({ direction: z.enum(["up", "down"]) }).parse(args);
        return moveQueuedIssue(userId, agentId, value.taskId, value.direction);
      },
    ),
    tool(
      "stop_task",
      "Stop the selected task attempt or remove queued work. Other jobs and schedules continue.",
      taskId,
      (args) => {
        const selected = taskId.parse(args).taskId;
        const current = readIssueView(userId, agentId, selected);
        return current.status === "queued"
          ? removeIssueFromQueue(userId, agentId, selected)
          : interruptIssue(userId, agentId, selected);
      },
    ),
  ];
}

export function buildHomeInstructions(agentId: string, availableToolNames: readonly string[] = []) {
  const tools = new Set(availableToolNames);
  return [
    "Home is this user's persistent private conversation across the web and paired messaging channels. History, saved memory, and background work outlive the active model context, which may compact or reset. New context resets model context only. Stop Home stops its reply and pending user messages; background jobs continue.",
    "Keep Home available for discussion, coordination, focused recall, and brief answers. Before multi-step investigations, broad file/log reading, implementation, verification, or many tool rounds, delegate with create_task(queue=true), even without an explicit delegation request. Home's smaller context can compact within one tool loop. Pass a bounded brief and constraints, not full history; leave the work to the task. Independent work gets separate task sessions; revisions update the relevant task. Background results arrive asynchronously. Check authoritative task state for progress; clarify ambiguous targets.",
    `Report outcomes or questions briefly and conversationally; link /agents/${agentId}/tasks/:taskId when useful. Keep checks, artifacts, logs, evidence, and uncertainty on the task page. Only the user accepts completed work.`,
    "Proactively use session_search and focused session_read excerpts for relevant earlier conversations, decisions, preferences, people, and ongoing work unless verified in this exchange. Search before asking the user to repeat context. After compaction/reset or revisiting old topics, treat summaries as pointers and retrieve supporting detail. Reuse current evidence; avoid unrelated searches and reloading unchanged history.",
    tools.has("knowledge_search") && tools.has("knowledge_read")
      ? 'For saved facts, preferences, and decisions, search sourceId="memories" with knowledge_search, then verify with knowledge_read. Use session history for remaining private context. Keep memory notes concise and attributed; the knowledge workflow governs access and user-requested changes.'
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function configureHomeCompaction(
  session: PiSession,
  contextWindow: number,
  context: Context,
) {
  const agent = await session.conversation.agent(context);
  const view = await session.conversation.context(context);
  const current = getCurrentSystemMessage(view.messages);
  const shown = Object.fromEntries(
    Object.entries(current?.sections ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  const input = {
    conversationId: session.conversation.id,
    agent,
    env: session.env,
    shown,
    read: session.native,
  };
  const sections: Record<string, string> = {};
  for (const section of agent.sections) {
    let text;
    try {
      text = await section.render(input, context);
      if (text !== undefined && section.tag !== false)
        text = `<${section.key}>\n${text}\n</${section.key}>`;
    } catch {
      context.abortSignal?.throwIfAborted();
      text = shown[section.key];
    }
    if (text !== undefined) sections[section.key] = text;
  }
  const fixedTokens = estimateMessageTokens({
    role: "system",
    content: current?.content ?? "",
    sections,
    toolsAdded: agent.tools.map(toToolDeclaration),
    timestamp: 0,
  });
  const extension = homeCompactionExtension(contextWindow, fixedTokens);
  session.registry.install(extension);
  session.settings = {
    ...session.settings,
    compaction: compactionSettingsForWindow(contextWindow, "home", fixedTokens),
    extensions: [
      ...(session.settings.extensions ?? []).filter((item) => item.name !== extension.name),
      extension,
    ],
  };
}
