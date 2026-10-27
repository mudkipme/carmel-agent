import { Link } from "react-router-dom";
import { CircleCheckIcon, CircleDotIcon, MessageSquareIcon } from "lucide-react";
import type { IssueDetail } from "@carmel-agent/shared";
import { hasTaskResult } from "./issue-state";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { sessionPath } from "@/lib/shell-route";
import { formatRelativeTime } from "@/lib/utils";

export function TaskActivity({
  issue,
  onViewResult,
}: {
  issue: IssueDetail;
  onViewResult: (id: string) => void;
}) {
  const events = [
    ...issue.attempts.map((attempt, index) => ({
      kind: "run" as const,
      id: attempt.id,
      at: attempt.finishedAt ?? attempt.createdAt,
      attempt,
      number: issue.attempts.length - index,
    })),
    ...issue.notes
      .filter((note) => note.kind !== "result")
      .map((note) => ({ kind: "note" as const, id: note.id, at: note.createdAt, note })),
  ].sort((a, b) => b.at - a.at);
  return (
    <ol className="flex flex-col">
      {events.map((event) => (
        <li key={event.id} className="flex min-w-0 gap-3 border-b py-5 last:border-0">
          {event.kind === "run" ? (
            event.attempt.outcome === "succeeded" ? (
              <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )
          ) : (
            <MessageSquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                {event.kind === "run"
                  ? `Run ${event.number} · ${event.attempt.outcome === "succeeded" ? "Completed" : event.attempt.outcome.replaceAll("_", " ")}`
                  : event.note.kind === "note"
                    ? "Note"
                    : "Task updated"}
              </h3>
              <time
                className="text-xs text-muted-foreground"
                dateTime={new Date(event.at).toISOString()}
              >
                {formatRelativeTime(event.at)}
              </time>
            </div>
            {event.kind === "run" ? (
              <>
                {event.attempt.instructions ? (
                  <MarkdownContent content={event.attempt.instructions} />
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {hasTaskResult(event.attempt) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`View result for run ${event.number}`}
                      onClick={() => onViewResult(event.id)}
                    >
                      View result
                    </Button>
                  ) : null}
                  {event.attempt.sessionId ? (
                    <Button asChild variant="ghost" size="sm">
                      <Link
                        aria-label={`Open conversation for run ${event.number}`}
                        to={sessionPath({ agentId: issue.agentId, id: event.attempt.sessionId })}
                      >
                        Open conversation
                      </Link>
                    </Button>
                  ) : null}
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Brief used for this run
                  </summary>
                  <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {event.attempt.brief}
                  </pre>
                </details>
              </>
            ) : (
              <MarkdownContent content={event.note.body} />
            )}
          </div>
        </li>
      ))}
      {!events.length ? (
        <li className="py-5 text-sm text-muted-foreground">No activity yet.</li>
      ) : null}
    </ol>
  );
}
