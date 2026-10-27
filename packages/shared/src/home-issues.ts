import type { AgentRunOutcome, IssueStatus } from "./index.ts";

export type HomeIssueUpdate = {
  id: string;
  agentId: string;
  title: string;
  status: IssueStatus;
  lastRunOutcome?: AgentRunOutcome;
};

export function homeIssueUpdate(message: { text: string; issue?: HomeIssueUpdate }) {
  if (message.issue) return message.issue;
  const match = message.text.match(
    /^\[([^\]\n]+)\]\(\/agents\/([^/\s)]+)\/(?:issues|tasks)\/([^/?\s)]+)(?:\?[^)]*)?\) — ([^\n]+)/,
  );
  if (!match) return;
  const status = {
    "Ready for review": "in_review",
    needs_input: "needs_input",
    "Needs your input": "needs_input",
    "Needs input": "needs_input",
    blocked: "blocked",
    Blocked: "blocked",
    failed: "backlog",
    interrupted: "backlog",
    cancelled: "backlog",
  }[match[4]] as IssueStatus | undefined;
  if (!status) return;
  return {
    id: match[3],
    agentId: match[2],
    title: match[1],
    status,
    ...(["failed", "interrupted", "cancelled"].includes(match[4])
      ? { lastRunOutcome: match[4] as AgentRunOutcome }
      : {}),
  } satisfies HomeIssueUpdate;
}
