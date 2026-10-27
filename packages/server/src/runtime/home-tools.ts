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

const issueId = z.object({ issueId: z.string().min(1) }).strict();
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
      "list_issues",
      "List this user's issues for this agent, including queue and review state.",
      z.object({}).strict(),
      () => readIssues(userId, agentId),
      true,
    ),
    tool(
      "read_issue",
      "Read an issue's brief, discussion, saved attempt results, and evidence.",
      issueId,
      (args) => readIssueView(userId, agentId, issueId.parse(args).issueId),
      true,
    ),
    tool(
      "create_issue",
      "Create a bounded background job. Set queue=true to start it. Include the user's relevant constraints and acceptance criteria. notifyPlatform is only for a requested external notification; omit otherwise. Results return to Home. Only the user accepts completed work.",
      issueCreateSchema,
      (args) => createIssue(userId, agentId, issueCreateSchema.parse(args)),
    ),
    tool(
      "queue_issue",
      "Queue/retry an existing issue. Revisions reuse its conversation unless fresh is explicitly requested.",
      issueId.extend({
        instructions: z.string().max(40000).optional(),
        fresh: z.boolean().optional(),
      }),
      (args) => {
        const value = issueId
          .extend({ instructions: z.string().optional(), fresh: z.boolean().optional() })
          .parse(args);
        return runIssue(
          userId,
          agentId,
          value.issueId,
          issueRunSchema.parse({ instructions: value.instructions, fresh: value.fresh }),
        );
      },
    ),
    tool(
      "update_issue",
      "Revise an idle issue's brief or criteria. Running work takes an update instead.",
      issueId.extend({ patch: issuePatchSchema }),
      (args) => {
        const value = issueId.extend({ patch: issuePatchSchema }).parse(args);
        return updateIssue(userId, agentId, value.issueId, value.patch);
      },
    ),
    tool(
      "send_issue_update",
      "Send an instruction to the explicitly selected running issue, or save a note for its next run.",
      issueId.extend({ text: z.string().min(1).max(40000), sendNow: z.boolean().default(false) }),
      (args) => {
        const value = issueId.extend({ text: z.string(), sendNow: z.boolean() }).parse(args);
        return value.sendNow
          ? sendIssueUpdate(userId, agentId, value.issueId, value.text)
          : addIssueNote(userId, agentId, value.issueId, value.text);
      },
    ),
    tool(
      "move_issue",
      "Move this user's queued issue up or down in the agent queue.",
      issueId.extend({ direction: z.enum(["up", "down"]) }),
      (args) => {
        const value = issueId.extend({ direction: z.enum(["up", "down"]) }).parse(args);
        return moveQueuedIssue(userId, agentId, value.issueId, value.direction);
      },
    ),
    tool(
      "stop_issue",
      "Stop the selected issue attempt or remove queued work. Other jobs and schedules continue.",
      issueId,
      (args) => {
        const selected = issueId.parse(args).issueId;
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
    "This is Home, this user's persistent private conversation with this agent. The same Home can span many days and messages across the web and paired private messaging channels. Conversation history, saved memory, and background work can persist beyond the active model context, which may be compacted or explicitly reset.",
    "Stay available for discussion and coordinate substantial work through issues. New independent jobs get separate issue sessions; updates and revisions reuse the relevant issue. Pass a bounded brief and relevant constraints, not all Home history. Background results can arrive asynchronously while the conversation continues. Read authoritative issue state when asked about progress, and ask which issue if the target is ambiguous.",
    `Keep issue updates conversational and concise: state the outcome or question, with a link to /agents/${agentId}/issues/:issueId when useful. Leave checks, artifacts, logs, and uncertainty on the issue page. Completed work still requires the user's explicit acceptance.`,
    "Actively recover relevant context in Home. Before answering references to earlier conversations, decisions, preferences, people, or ongoing work, use session_search and focused session_read excerpts unless the needed facts are already verified in the current exchange. After compaction, a context reset, or a return to an older topic, treat summaries as pointers and retrieve details before relying on them. Search before asking the user to repeat information they previously provided. Reuse evidence already retrieved for the current topic; do not search for unrelated requests or repeatedly load unchanged history. Keep reads focused rather than filling the context with entire conversations.",
    tools.has("knowledge_search") && tools.has("knowledge_read")
      ? 'When relevant facts are not already verified for the current topic, proactively recall saved facts, preferences, and decisions with knowledge_search using sourceId="memories", then knowledge_read to verify the needed note. Follow the knowledge-search built-in skill workflow before memory searches or changes. Search conversation history for personal context that is not in saved memory; use read_issue for current issue state. Save, update, or forget memories when the user asks, and keep notes concise and attributed. Private chat facts must not be automatically saved into agent-shared memory.'
      : undefined,
    "New context resets the active model context while retaining readable history, saved memory, and background jobs. Stopping Home stops its reply and pending user messages; background jobs continue.",
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
