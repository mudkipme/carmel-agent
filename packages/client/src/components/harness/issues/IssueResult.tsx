import type { IssueAttempt } from "@carmel-agent/shared";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { Badge } from "@/components/ui/badge";

/** Always show the saved run versions, never the files from a later job. */
export function IssueResult({ attempt }: { attempt: IssueAttempt }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-lg border p-4">
      <h3 className="text-sm font-medium">
        {attempt.outcome === "succeeded" ? "Delivered result" : "Run result"}
      </h3>
      {attempt.summary ? <MarkdownContent content={attempt.summary} /> : null}
      {attempt.evidence ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            Checks, artifacts, and uncertainty
          </h4>
          <MarkdownContent content={attempt.evidence} />
        </div>
      ) : null}
      {attempt.snapshot ? (
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            Files changed during this run · Saved versions
          </h4>
          {attempt.snapshot.files.length === 0 ? (
            <p className="text-xs text-muted-foreground">No captured file changes.</p>
          ) : null}
          {attempt.snapshot.files.map((file) => (
            <details key={file.path} className="min-w-0 rounded-md border">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {file.path}
                </span>
                <Badge variant="outline">{file.change}</Badge>
              </summary>
              {file.omitted ? (
                <p className="p-3 text-sm text-muted-foreground">
                  Binary content was not captured.
                </p>
              ) : (
                <div className="grid min-w-0 gap-3 border-t p-3 md:grid-cols-2">
                  {(["before", "after"] as const).map((side) => (
                    <div key={side} className="min-w-0">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        {side === "before" ? "Before this run" : "After this run"}
                      </p>
                      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                        <code>
                          {file[side] ??
                            (side === "before" ? "File did not exist" : "File deleted")}
                        </code>
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </details>
          ))}
          {attempt.snapshot.warning ? (
            <p className="text-xs text-muted-foreground">{attempt.snapshot.warning}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          File versions were not captured for this run.
        </p>
      )}
    </div>
  );
}
