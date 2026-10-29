import { i18n } from "@lingui/core";
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
import type { Issue, IssueStatus, IssueAttempt } from "@carmel-agent/shared";
type IssueState = {
  label: string;
  Icon: LucideIcon;
  className: string;
  attention: "blocking" | "review" | "none";
};
const states: Record<IssueStatus, [string, LucideIcon, IssueState["attention"]]> = {
  backlog: [/*i18n*/ "Backlog", CircleDashedIcon, "none"],
  todo: [/*i18n*/ "Backlog", CircleDotIcon, "none"],
  queued: [/*i18n*/ "Queued", CircleDotIcon, "none"],
  in_progress: [/*i18n*/ "Working", LoaderCircleIcon, "none"],
  needs_input: [/*i18n*/ "Needs input", MessageCircleQuestionMarkIcon, "blocking"],
  blocked: [/*i18n*/ "Blocked", OctagonAlertIcon, "blocking"],
  in_review: [/*i18n*/ "In review", ClipboardCheckIcon, "review"],
  done: [/*i18n*/ "Done", CircleCheckIcon, "none"],
  cancelled: [/*i18n*/ "Cancelled", CircleSlashIcon, "none"],
};
export function describeIssue(
  issue: Pick<Issue, "status" | "running" | "lastRunOutcome">,
): IssueState {
  if (
    !isClosedIssue(issue) &&
    !issue.running &&
    issue.status !== "queued" &&
    issue.lastRunOutcome &&
    issue.lastRunOutcome !== "succeeded"
  )
    return {
      label: ["interrupted", "cancelled"].includes(issue.lastRunOutcome)
        ? i18n._("Stopped")
        : i18n._("Run failed"),
      Icon: OctagonAlertIcon,
      attention: "blocking",
      className: "text-destructive",
    };
  const [label, Icon, attention] = states[issue.status];
  return {
    label: i18n._(label),
    Icon,
    attention,
    className: issue.running
      ? "animate-spin text-primary"
      : attention === "blocking"
        ? "text-destructive"
        : "text-muted-foreground",
  };
}
export function isClosedIssue(issue: Pick<Issue, "status">) {
  return issue.status === "done" || issue.status === "cancelled";
}
export function sortIssues(a: Issue, b: Issue) {
  if (a.status === "queued" && b.status === "queued")
    return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (isClosedIssue(a) !== isClosedIssue(b)) return isClosedIssue(a) ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}
export function issueGroup(issue: Issue): "Working" | "Queued" | "Needs you" | "Backlog" | "Done" {
  if (issue.running) return "Working";
  if (isClosedIssue(issue)) return "Done";
  if (issue.status === "queued") return "Queued";
  return describeIssue(issue).attention !== "none" ? "Needs you" : "Backlog";
}

export function hasTaskResult(attempt: IssueAttempt) {
  return Boolean(
    attempt.summary ||
    attempt.evidence ||
    attempt.snapshot?.files.length ||
    attempt.snapshot?.warning,
  );
}
