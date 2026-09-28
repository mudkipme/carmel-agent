export type ActivityKind = "needs_input" | "blocked" | "failed" | "review" | "completed" | "interrupted" | "missed";
export type ActivityFilter = "unread" | "attention" | "all";

export type ActivityItem = {
  id: number;
  agentId: string;
  agentName: string;
  sessionId: string | null;
  issueId: string | null;
  taskId: string | null;
  title: string;
  summary: string;
  kind: ActivityKind;
  createdAt: number;
  readAt: number | null;
};

export type ActivityPage = {
  items: ActivityItem[];
  unreadCount: number;
  nextCursor: number | null;
};
