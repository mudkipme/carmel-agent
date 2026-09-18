import { cn } from "@/lib/utils";
import type { Issue } from "@carmel-agent/shared";
import { describeIssue } from "./issue-state";

export function IssueStatusIcon({ issue, className }: { issue: Issue; className?: string }) {
  const state = describeIssue(issue);
  return <state.Icon aria-label={state.label} className={cn("size-3.5 shrink-0", state.className, className)} />;
}
