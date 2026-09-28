import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  MessageCircleQuestionMarkIcon,
  OctagonAlertIcon,
  CircleDashedIcon,
  ClipboardCheckIcon,
  type LucideIcon,
} from "lucide-react";
import type { Issue, IssueStatus } from "@carmel-agent/shared";
type IssueState = {
  label: string;
  Icon: LucideIcon;
  className: string;
  attention: "blocking" | "review" | "none";
};
const states: Record<IssueStatus, [string, LucideIcon, IssueState["attention"]]> = {
  backlog: ["Backlog", CircleDashedIcon, "none"],
  todo: ["To do", CircleDotIcon, "none"],
  in_progress: ["In progress", LoaderCircleIcon, "none"],
  needs_input: ["Needs input", MessageCircleQuestionMarkIcon, "blocking"],
  blocked: ["Blocked", OctagonAlertIcon, "blocking"],
  in_review: ["In review", ClipboardCheckIcon, "review"],
  done: ["Done", CircleCheckIcon, "none"],
  cancelled: ["Cancelled", CircleSlashIcon, "none"],
};
export function describeIssue(issue: Issue): IssueState {
  const [label, Icon, attention] = states[issue.status];
  return {
    label,
    Icon,
    attention,
    className: issue.running
      ? "animate-spin text-primary"
      : attention === "blocking"
        ? "text-destructive"
        : "text-muted-foreground",
  };
}
export function issueVerdictSummary(issue: Issue) {
  return issue.running ? undefined : (issue.lastRunDetail ?? issue.verdictSummary);
}
export function isClosedIssue(issue: Issue) {
  return issue.status === "done" || issue.status === "cancelled";
}
export function sortIssues(a: Issue, b: Issue) {
  if (isClosedIssue(a) !== isClosedIssue(b)) return isClosedIssue(a) ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}
