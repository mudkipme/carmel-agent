import {
  CircleAlertIcon,
  CircleCheckBigIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  MessageCircleQuestionMarkIcon,
  OctagonAlertIcon,
  type LucideIcon,
} from "lucide-react";
import type { Issue } from "@carmel-agent/shared";

type IssueState = {
  label: string;
  Icon: LucideIcon;
  className: string;
  /**
   * How much the issue wants the user. `blocking`: the agent cannot go on
   * without them. `review`: the agent has stopped and its work is waiting to be
   * looked at. `none`: nothing to do, because it is working or closed.
   */
  attention: "blocking" | "review" | "none";
};

/**
 * What an issue is doing, in a word or two.
 *
 * How the run ended outranks what the agent reported: a run that failed or was
 * stopped after reporting "done" has not been left the way the report says.
 * The agent's verdict speaks for a run that ended normally, and a run that
 * ended without one can only be described as awaiting review.
 */
export function describeIssue(issue: Issue): IssueState {
  if (issue.status === "resolved") {
    // Closed issues recede: green is for work waiting to be looked at.
    return { label: "Resolved", Icon: CircleCheckIcon, className: "text-muted-foreground", attention: "none" };
  }
  if (issue.status === "cancelled") {
    return { label: "Cancelled", Icon: CircleSlashIcon, className: "text-muted-foreground", attention: "none" };
  }
  if (issue.running) {
    return { label: "Working", Icon: LoaderCircleIcon, className: "animate-spin text-[var(--color-blue)]", attention: "none" };
  }
  switch (issue.lastRunOutcome) {
    case "failed":
      return { label: "Failed", Icon: CircleAlertIcon, className: "text-destructive", attention: "blocking" };
    case "cancelled":
    case "interrupted":
      return { label: "Interrupted", Icon: CirclePauseIcon, className: "text-[var(--color-orange)]", attention: "review" };
  }
  switch (issue.verdict) {
    case "done":
      return { label: "Ready for review", Icon: CircleCheckBigIcon, className: "text-[var(--color-green)]", attention: "review" };
    case "needs_input":
      return { label: "Needs your input", Icon: MessageCircleQuestionMarkIcon, className: "text-[var(--color-purple)]", attention: "blocking" };
    case "blocked":
      return { label: "Blocked", Icon: OctagonAlertIcon, className: "text-[var(--color-red)]", attention: "blocking" };
  }
  if (issue.lastRunOutcome === "succeeded") {
    return { label: "Awaiting review", Icon: CircleDotIcon, className: "text-[var(--color-yellow)]", attention: "review" };
  }
  return { label: "Starting", Icon: LoaderCircleIcon, className: "animate-spin text-muted-foreground", attention: "none" };
}

/** The agent's own words on the issue, when they still describe it. */
export function issueVerdictSummary(issue: Issue) {
  if (issue.status !== "open" || issue.running || !issue.verdict) return undefined;
  if (issue.lastRunOutcome && issue.lastRunOutcome !== "succeeded") return undefined;
  return issue.verdictSummary;
}

export function isClosedIssue(issue: Issue) {
  return issue.status !== "open";
}

/** Most recently active first; open issues ahead of closed ones. */
export function sortIssues(a: Issue, b: Issue) {
  if (isClosedIssue(a) !== isClosedIssue(b)) return isClosedIssue(a) ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}
