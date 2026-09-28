import type { ActivityItem, ActivityKind } from "@carmel-agent/shared";

export const activityLabels: Record<ActivityKind, string> = {
  needs_input: "Needs your input", blocked: "Blocked", failed: "Failed",
  review: "Ready for review", completed: "Reply ready", interrupted: "Interrupted", missed: "Missed run",
};

export function activityPath(item: Pick<ActivityItem, "agentId" | "issueId" | "sessionId" | "taskId">) {
  const base = `/agents/${encodeURIComponent(item.agentId)}`;
  if (item.issueId) return `${base}/issues/${encodeURIComponent(item.issueId)}`;
  if (item.sessionId) return `${base}/sessions/${encodeURIComponent(item.sessionId)}`;
  return `${base}/settings/tasks`;
}
