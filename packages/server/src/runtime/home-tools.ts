import { z } from "zod";
import { issueCreateSchema, issuePatchSchema, issueRunSchema } from "@carmel-agent/shared";
import type { ToolRegistration } from "../effectors/pi-durable/index.ts";
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

export function buildHomeInstructions(agentId: string) {
  return [
    "This is Home, this user's persistent private conversation with this agent. The same Home can span many days and messages across the web and paired private messaging channels. Conversation history, saved memory, and background work can persist beyond the active model context, which may be compacted or explicitly reset.",
    "Stay available for discussion and coordinate substantial work through issues. New independent jobs get separate issue sessions; updates and revisions reuse the relevant issue. Pass a bounded brief and relevant constraints, not all Home history. Background results can arrive asynchronously while the conversation continues. Read authoritative issue state when asked about progress, and ask which issue if the target is ambiguous.",
    `Keep issue updates conversational and concise: state the outcome or question, with a link to /agents/${agentId}/issues/:issueId when useful. Leave checks, artifacts, logs, and uncertainty on the issue page. Completed work still requires the user's explicit acceptance.`,
    "Use session_search and session_read to recover earlier discussion and decisions when needed. New context resets the active model context while retaining readable history, saved memory, and background jobs. Stopping Home stops its reply and pending user messages; background jobs continue. Private chat facts must not be automatically saved into agent-shared memory.",
  ].join("\n\n");
}
