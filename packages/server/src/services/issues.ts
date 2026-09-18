import { and, desc, eq } from "drizzle-orm";
import { toSessionRow, type Issue, type IssueVerdict, type Session } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { issues, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { errorMessage } from "../errors.ts";
import { startDetachedAgentRun, type SessionRunAddons } from "../runtime/agent-runtime.ts";
import {
  abortAgentRun,
  getActiveAgentRunForSessionId,
  onRunFinished,
  type ActiveAgentRun,
} from "../runtime/run-stream.ts";
import { readVisibleAgent, resolveSupportedThinkingLevel } from "./agent-access.ts";
import { resolveModelContext } from "./model-context.ts";
import { deletePiSession } from "./pi-session-storage.ts";
import { loadSession } from "./session-store.ts";

type IssueRecord = typeof issues.$inferSelect;
type SessionRecord = typeof sessions.$inferSelect;

export class IssueError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

/**
 * Issues are private to whoever opened them, like the sessions they are worked
 * in: a shared agent is shared tooling, not a shared inbox.
 */
export function readIssues(userId: string, agentId: string): Issue[] {
  assertAgentVisible(userId, agentId);
  return db
    .select()
    .from(issues)
    .where(and(eq(issues.agentId, agentId), eq(issues.userId, userId)))
    .orderBy(desc(issues.updatedAt))
    .all()
    .map(serializeIssue);
}

export function readIssue(userId: string, agentId: string, issueId: string): IssueRecord {
  assertAgentVisible(userId, agentId);
  const row = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!row || row.agentId !== agentId || row.userId !== userId) throw new IssueError("Issue not found.", 404);
  return row;
}

export function readIssueView(userId: string, agentId: string, issueId: string): Issue {
  return serializeIssue(readIssue(userId, agentId, issueId));
}

export type IssueDraft = {
  title: string;
  description: string;
  modelRefId?: string;
  thinkingLevel?: Session["thinkingLevel"];
};

/**
 * Open an issue and set the agent to work on it straight away.
 *
 * The model is resolved before anything is written, so an issue that cannot
 * run is a 400 the author sees rather than an issue with an empty session.
 */
export async function createIssue(userId: string, agentId: string, draft: IssueDraft): Promise<Issue> {
  const agent = assertAgentVisible(userId, agentId);
  const context = await resolveModelContext(userId, draft.modelRefId ?? agent.defaultModelRefId);
  if (!context.ok) {
    throw context.reason === "not_found"
      ? new IssueError("Model not found.", 404)
      : new IssueError("No API key or OAuth login configured for this model provider.", 400);
  }
  const { modelRef, providerConfig, modelRuntime } = context.value;
  const thinkingLevel = resolveSupportedThinkingLevel(modelRef, draft.thinkingLevel ?? agent.defaultThinkingLevel ?? "off");

  const timestamp = now();
  const issueId = id("issue");
  const session: Session = {
    id: id("session"),
    title: draft.title,
    userId,
    agentId,
    modelRefId: modelRef.id,
    thinkingLevel,
    revision: 0,
    messages: [],
    messageEntryIds: [],
    issueId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const row: IssueRecord = {
    id: issueId,
    agentId,
    userId,
    sessionId: session.id,
    title: draft.title,
    description: draft.description,
    status: "open",
    lastRunOutcome: null,
    lastRunDetail: null,
    verdict: null,
    verdictSummary: null,
    closedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(sessions).values(toSessionRow(session)).run();
  db.insert(issues).values(row).run();

  const sessionRecord = await loadSession(session.id);
  if (!sessionRecord) throw new Error("Could not create a session for this issue.");
  const run = startDetachedAgentRun({
    agent,
    session: sessionRecord,
    modelRef,
    providerConfig,
    modelRuntime,
    thinkingLevel,
    promptInput: { text: issuePrompt(draft) },
    sessionAddons: issueRunAddons(issueId),
  });
  watchIssueRun(issueId, run);
  return serializeIssue(row);
}

/**
 * Called whenever a run starts in an issue's session, which is how a reply
 * reaches the agent. Replying to a closed issue reopens it: a reply is a
 * request for more work, and leaving it marked resolved would hide that work.
 * The previous verdict goes too -- it answered a question the reply has moved on from.
 */
export function noteIssueRunStarted(session: SessionRecord, run: ActiveAgentRun) {
  if (!session.issueId) return;
  const issue = db.select().from(issues).where(eq(issues.id, session.issueId)).get();
  if (!issue) return;
  db.update(issues)
    .set({ status: "open", closedAt: null, verdict: null, verdictSummary: null, updatedAt: now() })
    .where(eq(issues.id, issue.id))
    .run();
  watchIssueRun(issue.id, run);
}

const ISSUE_VERDICTS: readonly IssueVerdict[] = ["done", "needs_input", "blocked"];

/**
 * What an issue's session adds to every run in it: the `report_issue` tool,
 * and the instructions to end each run by calling it. A run that ends without
 * a report is still recorded; the issue just cannot say what the agent made of it.
 */
export function issueRunAddons(issueId: string | null | undefined): SessionRunAddons | undefined {
  if (!issueId) return undefined;
  return {
    instructions: ISSUE_INSTRUCTIONS,
    tools: [
      {
        name: "report_issue",
        label: "Report issue status",
        description:
          "Report where the issue you are working on stands. Call it once, as the last thing you do before ending your turn.",
        parameters: reportIssueSchema as never,
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          const { state, summary } = parseReport(params);
          const updated = db
            .update(issues)
            .set({ verdict: state, verdictSummary: summary, updatedAt: now() })
            .where(eq(issues.id, issueId))
            .run();
          if (updated.changes === 0) throw new Error("This issue no longer exists.");
          return {
            content: [{ type: "text", text: "Reported. End your turn now with a short message for the user." }],
            details: { state, summary },
          };
        },
      },
    ],
  };
}

const ISSUE_INSTRUCTIONS = `<issue_workflow>
You are working on an issue: a task the user handed over for you to carry out on your own. They are not watching as you work, and will read what you leave behind.

Whenever you stop working -- finished, stuck, or waiting on the user -- call \`report_issue\` once as your final action, then end your turn with a short message for the user:
- "done": the task is complete. Summarize what you changed and how the user can check it. Do not report done while work remains.
- "needs_input": you need a decision, clarification, or information only the user has. Put the specific questions in the summary. Ask rather than guess when a wrong guess would be costly or hard to undo.
- "blocked": you cannot proceed -- missing access or credentials, a broken environment, or a task that cannot be done as specified. Say what is blocking you and what would unblock it.
</issue_workflow>`;

const reportIssueSchema = {
  type: "object",
  properties: {
    state: {
      type: "string",
      enum: ISSUE_VERDICTS,
      description: "done: the task is complete. needs_input: you need something from the user. blocked: you cannot proceed.",
    },
    summary: {
      type: "string",
      description:
        "For the user, in a few sentences: what you did (done), the questions you need answered (needs_input), or what blocks you and what would unblock it (blocked).",
    },
  },
  required: ["state", "summary"],
  additionalProperties: false,
};

function parseReport(params: unknown): { state: IssueVerdict; summary: string } {
  const args = (params ?? {}) as { state?: unknown; summary?: unknown };
  if (!ISSUE_VERDICTS.includes(args.state as IssueVerdict)) {
    throw new Error(`state must be one of: ${ISSUE_VERDICTS.join(", ")}.`);
  }
  if (typeof args.summary !== "string" || !args.summary.trim()) throw new Error("summary is required.");
  return { state: args.state as IssueVerdict, summary: args.summary.trim().slice(0, 4_000) };
}

/**
 * Record how a run ended as it ends. Nobody may be watching, so the issue has
 * to say -- and it has to say so in the same tick the run stops counting as
 * running, or a client reading in between sees a stopped run with the previous
 * run's outcome.
 */
function watchIssueRun(issueId: string, run: ActiveAgentRun) {
  onRunFinished(run, (result) => {
    try {
      db.update(issues)
        .set({ lastRunOutcome: result.outcome, lastRunDetail: result.detail ?? null, updatedAt: now() })
        .where(eq(issues.id, issueId))
        .run();
    } catch (error) {
      console.warn(`Could not record the run result for issue ${issueId}:`, errorMessage(error));
    }
  });
}

export function updateIssue(
  userId: string,
  agentId: string,
  issueId: string,
  patch: { title?: string; status?: "open" | "resolved" },
): Issue {
  const current = readIssue(userId, agentId, issueId);
  if (patch.status === "resolved" && isRunning(current)) {
    throw new IssueError("The agent is still working on this issue. Interrupt it before resolving.", 409);
  }
  const timestamp = now();
  const status = patch.status ?? current.status;
  const row: IssueRecord = {
    ...current,
    title: patch.title ?? current.title,
    status,
    closedAt: status === "open" ? null : status === current.status ? current.closedAt : timestamp,
    updatedAt: timestamp,
  };
  db.update(issues).set(row).where(eq(issues.id, issueId)).run();
  if (patch.title !== undefined) {
    db.update(sessions).set({ title: patch.title }).where(eq(sessions.id, current.sessionId)).run();
  }
  return serializeIssue(row);
}

/** Stop the agent's current run. The issue stays open, waiting for a reply. */
export function interruptIssue(userId: string, agentId: string, issueId: string): Issue {
  const issue = readIssue(userId, agentId, issueId);
  stopRun(userId, issue);
  return serializeIssue(issue);
}

/** Stop any run and close the issue as abandoned. */
export function cancelIssue(userId: string, agentId: string, issueId: string): Issue {
  const current = readIssue(userId, agentId, issueId);
  stopRun(userId, current);
  const timestamp = now();
  const row: IssueRecord = { ...current, status: "cancelled", closedAt: timestamp, updatedAt: timestamp };
  db.update(issues).set(row).where(eq(issues.id, issueId)).run();
  return serializeIssue(row);
}

export async function deleteIssue(userId: string, agentId: string, issueId: string) {
  const issue = readIssue(userId, agentId, issueId);
  if (isRunning(issue)) {
    throw new IssueError("The agent is still working on this issue. Cancel it before deleting.", 409);
  }
  const session = db.select().from(sessions).where(eq(sessions.id, issue.sessionId)).get();
  db.delete(issues).where(eq(issues.id, issue.id)).run();
  if (session) {
    await deletePiSession(session);
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
  }
}

/** Called from agent deletion, which deletes the agent's sessions itself. */
export function deleteIssuesForAgent(agentId: string) {
  db.delete(issues).where(eq(issues.agentId, agentId)).run();
}

/** Called when an issue's session is deleted directly: the issue has nothing left to show. */
export function deleteIssueForSession(session: SessionRecord) {
  if (session.issueId) db.delete(issues).where(eq(issues.id, session.issueId)).run();
}

function stopRun(userId: string, issue: IssueRecord) {
  const run = getActiveAgentRunForSessionId(issue.sessionId);
  if (run) abortAgentRun(userId, run.runId);
}

function isRunning(issue: IssueRecord) {
  return Boolean(getActiveAgentRunForSessionId(issue.sessionId));
}

function assertAgentVisible(userId: string, agentId: string) {
  const agent = readVisibleAgent(userId, agentId);
  if (!agent) throw new IssueError("Agent not found.", 404);
  return agent;
}

/** The first message of the issue's session: the brief, headed by its title. */
function issuePrompt(draft: IssueDraft) {
  return `# ${draft.title}\n\n${draft.description}`;
}

function serializeIssue(row: IssueRecord): Issue {
  return {
    id: row.id,
    agentId: row.agentId,
    userId: row.userId,
    sessionId: row.sessionId,
    title: row.title,
    description: row.description,
    status: row.status,
    running: isRunning(row),
    lastRunOutcome: row.lastRunOutcome ?? undefined,
    lastRunDetail: row.lastRunDetail ?? undefined,
    verdict: row.verdict ?? undefined,
    verdictSummary: row.verdictSummary ?? undefined,
    closedAt: row.closedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
