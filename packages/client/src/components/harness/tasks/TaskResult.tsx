import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { IssueAttempt } from "@carmel-agent/shared";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { Badge } from "@/components/ui/badge";

/** Always show the saved run versions, never the files from a later job. */
export function TaskResult({ attempt }: { attempt: IssueAttempt }) {
  const { i18n } = useLingui();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {attempt.summary ? <MarkdownContent content={attempt.summary} /> : null}
      {attempt.evidence ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">
            <Trans>Verification & evidence</Trans>
          </h2>
          <MarkdownContent content={attempt.evidence} />
        </div>
      ) : null}
      {attempt.snapshot && (attempt.snapshot.files.length || attempt.snapshot.warning) ? (
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">
            <Trans>Files</Trans>
          </h2>
          {attempt.snapshot.files.map((file) => (
            <details key={file.path} className="min-w-0 border-b last:border-0">
              <summary className="flex cursor-pointer items-center gap-2 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {file.path}
                </span>
                <Badge variant="outline">{file.change}</Badge>
              </summary>
              {file.omitted ? (
                <p className="p-3 text-sm text-muted-foreground">
                  <Trans>Binary content was not captured.</Trans>
                </p>
              ) : (
                <div className="grid min-w-0 gap-3 border-t p-3 md:grid-cols-2">
                  {(["before", "after"] as const).map((side) => (
                    <div key={side} className="min-w-0">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        {side === "before" ? i18n._("Before this run") : i18n._("After this run")}
                      </p>
                      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                        <code>
                          {file[side] ??
                            (side === "before"
                              ? i18n._("File did not exist")
                              : i18n._("File deleted"))}
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
      ) : null}
    </div>
  );
}
