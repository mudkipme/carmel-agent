import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeftIcon, CheckIcon, PlayIcon, SquareIcon } from "lucide-react";
import type { AgentConfig } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useSessionDraft } from "@/hooks/use-session-draft";
import { draftStorageKey, clearSessionDraft } from "@/lib/session-draft";
import { issueListSearch } from "@/lib/issue-navigation";
import { sessionPath } from "@/lib/shell-route";
import { ResourceError, ResourceLoading } from "../ResourceFeedback";
import { api } from "@/lib/api";
import { confirmAction } from "@/lib/action-dialogs";
import { showError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { WorkspaceFileLinkAgentContext } from "@/components/chat/workspace-file-links";
import { describeIssue, isClosedIssue } from "./issue-state";
import { IssueBriefForm } from "./IssueBriefForm";
import { IssueConversation } from "./IssueConversation";
import { IssueResult } from "./IssueResult";

export function IssueView({
  agent,
  issueId,
  onIssuesChanged,
}: {
  agent: AgentConfig;
  issueId: string;
  onIssuesChanged: () => Promise<unknown>;
}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const listPath = `/agents/${agent.id}/issues${issueListSearch(params)}`;
  const userId = useHarnessStore((s) => s.activeUserId);
  const briefDraftKey = draftStorageKey(userId, agent.id, issueId, "brief");
  const replyDraftKey = draftStorageKey(userId, agent.id, issueId, "reply");
  const {
    data: issue,
    error,
    loading,
    refresh,
  } = useRemoteResource({
    key: `${agent.id}:${issueId}`,
    load: (signal) => api.getIssue(agent.id, issueId, signal),
    pollInterval: (data) =>
      !data || data.running || data.status === "queued" ? 4_000 : 30_000,
  });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [message, setMessage] = useSessionDraft(
    replyDraftKey,
    "",
    (value): value is string => typeof value === "string",
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const act = async (action: () => Promise<unknown>, clearMessage = false) => {
    const sentMessage = message;
    setBusy(true);
    try {
      await action();
      if (clearMessage) {
        setMessage((current) => (current === sentMessage ? "" : current));
      }
      await refresh();
      await onIssuesChanged();
    } catch (cause) {
      showError("Unable to update issue", cause);
      await refresh();
      await onIssuesChanged();
    } finally {
      setBusy(false);
    }
  };
  const focusReply = () => composer.current?.focus();
  if (!issue)
    return (
      <div className="flex flex-col gap-4 p-8">
        {loading ? <ResourceLoading label="Loading issue" /> : null}
        {error ? (
          <ResourceError
            error={error}
            title="Unable to load issue"
            onRetry={refresh}
          />
        ) : null}
        <Button asChild variant="link">
          <Link to={listPath}>Back to issues</Link>
        </Button>
      </div>
    );
  const state = describeIssue(issue);
  const closed = isClosedIssue(issue);
  const queued = issue.status === "queued";
  const latest = issue.attempts[0];
  const stopped =
    issue.lastRunOutcome === "interrupted" ||
    issue.lastRunOutcome === "cancelled";
  const failed =
    !issue.running &&
    issue.lastRunOutcome &&
    issue.lastRunOutcome !== "succeeded";
  const queueWork = () =>
    act(async () => {
      await api.runIssue(agent.id, issueId, {
        instructions: message || undefined,
        fresh,
      });
      setFresh(false);
    }, true);
  const sendLabel = issue.running
    ? "Send update"
    : issue.status === "in_review"
      ? "Request changes & queue"
      : issue.status === "needs_input"
        ? "Reply & queue"
        : failed
          ? "Retry & queue"
          : "Queue work";
  return (
    <WorkspaceFileLinkAgentContext value={agent.id}>
      <div className="h-full overflow-y-auto px-4 py-5 sm:px-8">
        <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-5">
          <Link
            className="flex items-center gap-2 text-sm text-muted-foreground hover:underline"
            to={listPath}
          >
            <ArrowLeftIcon className="size-4" />
            {agent.name} / Issues
          </Link>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  state.attention === "blocking" ? "destructive" : "secondary"
                }
              >
                <state.Icon />
                {state.label}
              </Badge>
              {issue.priority !== "normal" ? (
                <Badge variant="outline">{issue.priority} priority</Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">
                Updated {formatRelativeTime(issue.updatedAt)}
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">
              {issue.title}
            </h1>
            <div className="flex flex-wrap gap-2">
              {issue.running ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.interruptIssue(agent.id, issueId))
                  }
                >
                  <SquareIcon data-icon="inline-start" />
                  Stop run
                </Button>
              ) : queued ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.removeIssueFromQueue(agent.id, issueId))
                  }
                >
                  Remove from queue
                </Button>
              ) : closed ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.reopenIssue(agent.id, issueId))
                  }
                >
                  Reopen issue
                </Button>
              ) : issue.status === "in_review" ? (
                <>
                  <Button
                    disabled={busy || editing}
                    onClick={() =>
                      void act(() => api.acceptIssue(agent.id, issueId))
                    }
                  >
                    <CheckIcon data-icon="inline-start" />
                    Accept result
                  </Button>
                  <Button variant="outline" onClick={focusReply}>
                    Request changes
                  </Button>
                </>
              ) : issue.status === "needs_input" ? (
                <Button onClick={focusReply}>Reply to agent</Button>
              ) : (
                <Button
                  disabled={busy || editing}
                  onClick={() => void queueWork()}
                >
                  <PlayIcon data-icon="inline-start" />
                  {failed ? "Retry & queue" : "Queue work"}
                </Button>
              )}
              {!closed && !issue.running && !queued ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (editing) clearSessionDraft(briefDraftKey);
                    setEditing(!editing);
                  }}
                >
                  {editing ? "Cancel editing" : "Edit brief"}
                </Button>
              ) : null}
            </div>
          </div>
          {error ? (
            <ResourceError
              error={error}
              title="Connection lost"
              onRetry={refresh}
            />
          ) : null}
          {failed ||
          (!issue.running &&
            issue.status === "needs_input" &&
            issue.lastRunDetail) ? (
            <Alert variant={failed ? "destructive" : "default"}>
              <AlertTitle>
                {failed
                  ? stopped
                    ? "Run stopped"
                    : "Run failed"
                  : "No result delivered"}
              </AlertTitle>
              <AlertDescription>
                {issue.lastRunDetail ??
                  (stopped
                    ? "Execution stopped. Queue this issue to continue."
                    : "The run ended before completing the work. Queue a retry to continue.")}
              </AlertDescription>
            </Alert>
          ) : null}
          {queued ? (
            <Alert>
              <AlertTitle>Waiting in the agent’s queue</AlertTitle>
              <AlertDescription>
                This agent runs one issue at a time. Reorder jobs in the issue
                list.
                {issue.queuedInstructions ? (
                  <p className="mt-2 whitespace-pre-wrap break-words">
                    {issue.queuedInstructions}
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {editing ? (
            <div className="rounded-lg border p-4">
              <IssueBriefForm
                draftKey={briefDraftKey}
                busy={busy}
                initial={{
                  title: issue.title,
                  description: issue.description,
                  criteria: issue.criteria,
                  priority: issue.priority,
                }}
                onSave={(draft) =>
                  void act(async () => {
                    await api.updateIssue(agent.id, issueId, draft);
                    clearSessionDraft(briefDraftKey);
                    setEditing(false);
                  })
                }
                onCancel={() => {
                  clearSessionDraft(briefDraftKey);
                  setEditing(false);
                }}
              />
            </div>
          ) : (
            <details
              className="rounded-lg border"
              open={!issue.sessionId || undefined}
            >
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Brief & acceptance criteria
              </summary>
              <div className="flex flex-col gap-4 border-t p-4">
                {issue.description ? (
                  <MarkdownContent content={issue.description} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    The title is the brief. Add details when needed.
                  </p>
                )}
                {issue.criteria.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {issue.criteria.map((criterion, index) => (
                      <li key={index} className="break-words">
                        {criterion}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </details>
          )}
          <div className="flex min-w-0 flex-col gap-4">
            <h2 className="text-sm font-medium">Conversation</h2>
            {issue.sessionId ? (
              <IssueConversation
                key={issue.sessionId}
                agent={agent}
                sessionId={issue.sessionId}
                running={issue.running}
                notes={issue.notes}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Queue this issue to hand it to {agent.name}.
              </p>
            )}
            {!issue.sessionId
              ? issue.notes
                  .filter((note) => note.kind === "note")
                  .map((note) => (
                    <div key={note.id} className="rounded-lg bg-muted p-4">
                      <MarkdownContent content={note.body} />
                    </div>
                  ))
              : null}
            {!issue.running && latest && (latest.summary || latest.evidence) ? (
              <IssueResult attempt={latest} />
            ) : null}
          </div>
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <Field>
              <FieldLabel htmlFor="issue-reply">
                {issue.running
                  ? "Update the agent"
                  : closed
                    ? "Leave a note"
                    : "Instructions or feedback"}
              </FieldLabel>
              <Textarea
                ref={composer}
                id="issue-reply"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={20000}
                className="min-h-24"
                placeholder={
                  issue.status === "needs_input"
                    ? "Answer the agent’s questions…"
                    : issue.status === "in_review"
                      ? "Describe what should change…"
                      : "Add context or instructions…"
                }
              />
              <FieldDescription>
                {issue.running
                  ? "Updates reach the agent at its next step. Delivery is shown in the conversation."
                  : queued
                    ? "Remove this issue from the queue to change the instructions. You can still save notes."
                    : "Replies continue this conversation. Queueing work starts it when the agent is available."}
              </FieldDescription>
            </Field>
            {issue.sessionId && !issue.running && !closed && !queued ? (
              <Field orientation="horizontal">
                <Checkbox
                  id="issue-fresh"
                  checked={fresh}
                  onCheckedChange={(value) => setFresh(value === true)}
                />
                <FieldLabel
                  htmlFor="issue-fresh"
                  className="text-xs font-normal"
                >
                  Start a fresh conversation for the next run
                </FieldLabel>
              </Field>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy || !message.trim()}
                onClick={() =>
                  void act(
                    () => api.addIssueNote(agent.id, issueId, message),
                    true,
                  )
                }
              >
                Save note
              </Button>
              {!closed && !queued ? (
                <Button
                  disabled={
                    busy ||
                    editing ||
                    (!message.trim() &&
                      (issue.running ||
                        ["in_review", "needs_input"].includes(issue.status)))
                  }
                  onClick={() =>
                    void (issue.running
                      ? act(
                          () => api.sendIssueUpdate(agent.id, issueId, message),
                          true,
                        )
                      : queueWork())
                  }
                >
                  {sendLabel}
                </Button>
              ) : null}
            </div>
          </div>
          {issue.attempts.length || issue.notes.length ? (
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-4 py-3 text-sm text-muted-foreground">
                Run history & issue events · {issue.attempts.length} runs
              </summary>
              <div className="flex flex-col gap-4 border-t p-4">
                {issue.attempts.map((attempt, index) => (
                  <details key={attempt.id} className="rounded-lg border p-3">
                    <summary className="cursor-pointer text-sm">
                      Run {issue.attempts.length - index} · {attempt.outcome} ·{" "}
                      {formatRelativeTime(attempt.createdAt)}
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">
                      {attempt.instructions ? (
                        <MarkdownContent content={attempt.instructions} />
                      ) : null}
                      {attempt.sessionId &&
                      attempt.sessionId !== issue.sessionId ? (
                        <Button asChild variant="outline" size="sm">
                          <Link
                            to={sessionPath({
                              agentId: agent.id,
                              id: attempt.sessionId,
                            })}
                          >
                            Earlier conversation
                          </Link>
                        </Button>
                      ) : null}
                      {attempt.outcome !== "running" ? (
                        <IssueResult attempt={attempt} />
                      ) : null}
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          Brief used for this run
                        </summary>
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                          {attempt.brief}
                        </pre>
                      </details>
                    </div>
                  </details>
                ))}
                {issue.notes
                  .filter((note) => note.kind !== "note")
                  .map((note) => (
                    <p
                      key={note.id}
                      className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
                    >
                      {note.body}
                    </p>
                  ))}
              </div>
            </details>
          ) : null}
          <div className="flex justify-end gap-2 pb-4">
            {!closed ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (
                      await confirmAction({
                        title: "Cancel issue?",
                        description:
                          "Stop any active run and close this issue. You can reopen it later.",
                        actionLabel: "Cancel issue",
                      })
                    )
                      await api.cancelIssue(agent.id, issueId);
                  })
                }
              >
                Cancel issue
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || issue.running}
              onClick={async () => {
                if (
                  !(await confirmAction({
                    title: "Delete issue?",
                    description:
                      "Delete the brief, discussion, saved results, and all conversations.",
                    actionLabel: "Delete",
                  }))
                )
                  return;
                setBusy(true);
                try {
                  await api.deleteIssue(agent.id, issueId);
                  clearSessionDraft(briefDraftKey);
                  clearSessionDraft(replyDraftKey);
                  await onIssuesChanged();
                  navigate(listPath);
                } catch (cause) {
                  showError("Unable to delete issue", cause);
                  setBusy(false);
                }
              }}
            >
              Delete issue
            </Button>
          </div>
        </div>
      </div>
    </WorkspaceFileLinkAgentContext>
  );
}
