import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn, formatRelativeTime } from "@/lib/utils";
import type { Issue } from "@carmel-agent/shared";
import {
  describeIssue,
  isClosedIssue,
  issueVerdictSummary,
  issueGroup,
  sortIssues,
} from "./issue-state";
import { IssueStatusIcon } from "./IssueStatusIcon";

/**
 * The sidebar's issue list. Closed issues fold under their own heading: they
 * are finished work, kept for reference, and should not crowd the open ones.
 */
export function IssueList({
  issues,
  activeIssueId,
  onOpenIssue,
}: {
  issues: Issue[];
  activeIssueId?: string;
  onOpenIssue: () => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const open = issues.filter((issue) => !isClosedIssue(issue));
  const closed = issues.filter(isClosedIssue);
  // The open issue always has a visible row, even when it is a closed one.
  const closedShown =
    showClosed || closed.some((issue) => issue.id === activeIssueId);

  if (issues.length === 0) {
    return (
      <p className="px-2.5 py-2 text-[13px] text-muted-foreground">
        No issues yet.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {(["Working", "Queued", "Needs you", "Backlog"] as const).map((group) => {
        const rows = open
          .filter((issue) => issueGroup(issue) === group)
          .sort(sortIssues);
        return rows.length ? (
          <div key={group} className="flex flex-col">
            <p className="px-2.5 pt-3 pb-1 text-xs text-muted-foreground">
              {group} · {rows.length}
            </p>
            {rows.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                active={issue.id === activeIssueId}
                onOpenIssue={onOpenIssue}
              />
            ))}
          </div>
        ) : null;
      })}
      {closed.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={closedShown}
            className="nav-item mt-1 flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-left text-xs"
            onClick={() => setShowClosed(!closedShown)}
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                closedShown && "rotate-90",
              )}
            />
            Done · {closed.length}
          </button>
          {closedShown
            ? closed.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  active={issue.id === activeIssueId}
                  onOpenIssue={onOpenIssue}
                />
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}

function IssueRow({
  issue,
  active,
  onOpenIssue,
}: {
  issue: Issue;
  active: boolean;
  onOpenIssue: () => void;
}) {
  const navigate = useNavigate();
  const state = describeIssue(issue);
  /* An issue waiting on an answer shows the question under its title, so it
     can be read -- and often answered -- without opening the issue first. */
  const summary =
    state.attention === "blocking" ? issueVerdictSummary(issue) : undefined;
  return (
    <button
      type="button"
      data-active={active}
      title={`${issue.title} · ${state.label}${summary ? `\n\n${summary}` : ""}`}
      className={cn(
        "nav-item flex shrink-0 gap-2 rounded-md px-2.5 text-left",
        summary ? "items-start py-1.5" : "h-8 items-center",
      )}
      onClick={() => {
        navigate(`/agents/${issue.agentId}/issues/${issue.id}`);
        onOpenIssue();
      }}
    >
      <IssueStatusIcon
        issue={issue}
        className={summary ? "mt-[3px]" : undefined}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-[13px]",
            state.attention !== "none" && "font-medium text-foreground",
          )}
        >
          {issue.title}
        </span>
        {summary ? (
          <span className="line-clamp-2 text-ui-smaller text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "coarse-pointer-hidden shrink-0 text-ui-smaller text-muted-foreground",
          summary && "mt-px",
        )}
      >
        {formatRelativeTime(issue.updatedAt)}
      </span>
    </button>
  );
}
