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
const states: Record<
  IssueStatus,
  [string, LucideIcon, IssueState["attention"]]
> = {
  backlog: ["Backlog", CircleDashedIcon, "none"],
  todo: ["Backlog", CircleDotIcon, "none"],
  queued: ["Queued", CircleDotIcon, "none"],
  in_progress: ["Working", LoaderCircleIcon, "none"],
  needs_input: ["Needs input", MessageCircleQuestionMarkIcon, "blocking"],
  blocked: ["Blocked", OctagonAlertIcon, "blocking"],
  in_review: ["In review", ClipboardCheckIcon, "review"],
  done: ["Done", CircleCheckIcon, "none"],
  cancelled: ["Cancelled", CircleSlashIcon, "none"],
};
export function describeIssue(issue: Issue): IssueState {
  if (
    !isClosedIssue(issue) &&
    !issue.running &&
    issue.status !== "queued" &&
    issue.lastRunOutcome &&
    issue.lastRunOutcome !== "succeeded"
  )
    return {
      label: ["interrupted", "cancelled"].includes(issue.lastRunOutcome)
        ? "Stopped"
        : "Run failed",
      Icon: OctagonAlertIcon,
      attention: "blocking",
      className: "text-destructive",
    };
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
export function isClosedIssue(issue: Issue) {
  return issue.status === "done" || issue.status === "cancelled";
}
export function sortIssues(a: Issue, b: Issue) {
  if (a.status === "queued" && b.status === "queued")
    return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (isClosedIssue(a) !== isClosedIssue(b)) return isClosedIssue(a) ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}
export function issueGroup(
  issue: Issue,
): "Working" | "Queued" | "Needs you" | "Backlog" | "Done" {
  if (issue.running) return "Working";
  if (isClosedIssue(issue)) return "Done";
  if (issue.status === "queued") return "Queued";
  return describeIssue(issue).attention !== "none" ? "Needs you" : "Backlog";
}
