import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeftIcon, CheckIcon, PlayIcon, SquareIcon } from "lucide-react";
import type { AgentConfig, IssueDetail } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { api } from "@/lib/api";
import { confirmAction } from "@/lib/action-dialogs";
import { showError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import { describeIssue, isClosedIssue } from "./issue-state";
import { IssueBriefForm } from "./IssueBriefForm";

export function IssueView({ agent, issueId }: { agent: AgentConfig; issueId: string }) {
  const navigate = useNavigate();
  const loadIssues = useHarnessStore((s) => s.loadIssues);
  const [issue, setIssue] = useState<IssueDetail>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState("brief");
  const [message, setMessage] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const refresh = useCallback(async () => {
    setIssue(await api.getIssue(agent.id, issueId));
    setError(false);
  }, [agent.id, issueId]);
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await api.getIssue(agent.id, issueId);
        if (!disposed) {
          setIssue(next);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 4000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [agent.id, issueId]);
  const act = async (action: () => Promise<unknown>, clearMessage = false) => {
    setBusy(true);
    try {
      await action();
      if (clearMessage) setMessage("");
      await refresh();
      await loadIssues(agent.id);
    } catch (cause) {
      showError("Unable to update issue", cause);
      await refresh().catch(() => undefined);
      await loadIssues(agent.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const focusReply = () => {
    setTab("activity");
    window.setTimeout(() => composer.current?.focus(), 0);
  };
  if (!issue)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{error ? "Unable to load issue" : "Loading issue…"}</EmptyTitle>
          <EmptyDescription>
            {error ? "Check your connection or return to the issue list." : "Fetching the brief and run history."}
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link to={`/agents/${agent.id}/issues`}>Back to issues</Link>
        </Button>
      </Empty>
    );
  const state = describeIssue(issue);
  const closed = isClosedIssue(issue);
  const executionDisabled = busy || editing;
  const latest = issue.attempts[0];
  const sendLabel =
    issue.status === "in_review"
      ? "Request changes"
      : issue.status === "needs_input"
        ? "Answer & resume"
        : "Send to agent";
  return (
    <div className="h-full overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <Link
          className="flex items-center gap-2 text-sm text-muted-foreground hover:underline"
          to={`/agents/${agent.id}/issues`}
        >
          <ArrowLeftIcon className="size-4" />
          {agent.name} / Issues
        </Link>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={state.attention === "blocking" ? "destructive" : "secondary"}>
              <state.Icon />
              {state.label}
            </Badge>
            <Badge variant="outline">{issue.priority} priority</Badge>
            <span className="text-xs text-muted-foreground">Updated {formatRelativeTime(issue.updatedAt)}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight break-words">{issue.title}</h1>
          <div className="flex flex-wrap gap-2">
            {issue.running ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => api.interruptIssue(agent.id, issueId))}
              >
                <SquareIcon data-icon="inline-start" />
                Pause run
              </Button>
            ) : closed ? (
              <Button disabled={executionDisabled} onClick={() => void act(() => api.reopenIssue(agent.id, issueId))}>
                Reopen issue
              </Button>
            ) : issue.status === "in_review" ? (
              <>
                <Button disabled={executionDisabled} onClick={() => void act(() => api.acceptIssue(agent.id, issueId))}>
                  <CheckIcon data-icon="inline-start" />
                  Accept result
                </Button>
                <Button variant="outline" disabled={executionDisabled} onClick={focusReply}>
                  Request changes
                </Button>
              </>
            ) : issue.status === "needs_input" ? (
              <Button disabled={executionDisabled} onClick={focusReply}>
                Answer & resume
              </Button>
            ) : (
              <Button disabled={executionDisabled} onClick={() => void act(() => api.runIssue(agent.id, issueId, {}))}>
                <PlayIcon data-icon="inline-start" />
                {issue.attempts.length ? "Start another attempt" : "Start work"}
              </Button>
            )}
            {!closed ? (
              <Button
                variant="ghost"
                disabled={busy || issue.running || editing}
                onClick={() => {
                  setEditing(true);
                  setTab("brief");
                }}
              >
                Edit brief
              </Button>
            ) : null}
            {["todo", "backlog"].includes(issue.status) ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api.updateIssue(agent.id, issueId, {
                      status: issue.status === "backlog" ? "todo" : "backlog",
                    }),
                  )
                }
              >
                {issue.status === "backlog" ? "Move to To do" : "Move to Backlog"}
              </Button>
            ) : null}
          </div>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Updates are unavailable</AlertTitle>
            <AlertDescription>Showing the last loaded version. Retrying automatically.</AlertDescription>
          </Alert>
        ) : null}
        {issue.running ? (
          <Alert>
            <AlertTitle>{agent.name} is working</AlertTitle>
            <AlertDescription>
              The run continues with this page closed. You can leave a note while it works.
            </AlertDescription>
          </Alert>
        ) : latest ? (
          <Alert>
            <AlertTitle>
              {issue.status === "in_review"
                ? "Ready for your review"
                : issue.status === "done"
                  ? "Accepted result"
                  : "Latest attempt"}
            </AlertTitle>
            <AlertDescription>
              <p className="whitespace-pre-wrap">
                {issue.lastRunDetail ??
                  latest.summary ??
                  "No report was provided. Check the run conversation before accepting."}
              </p>
              {latest.evidence ? (
                <div className="mt-3">
                  <p className="font-medium">Evidence reported by the agent</p>
                  <p className="whitespace-pre-wrap">{latest.evidence}</p>
                </div>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="brief">Brief</TabsTrigger>
            <TabsTrigger value="activity">Activity · {issue.notes.length}</TabsTrigger>
            <TabsTrigger value="runs">Runs · {issue.attempts.length}</TabsTrigger>
          </TabsList>
          <TabsContent value="brief" className="pt-5">
            {editing ? (
              <IssueBriefForm
                initial={{
                  title: issue.title,
                  description: issue.description,
                  criteria: issue.criteria,
                  priority: issue.priority,
                }}
                busy={busy}
                onCancel={() => setEditing(false)}
                onSave={(draft) =>
                  void act(async () => {
                    await api.updateIssue(agent.id, issueId, draft);
                    setEditing(false);
                  })
                }
              />
            ) : (
              <div className="flex flex-col gap-8">
                <section>
                  <h2 className="mb-3 font-medium">Desired outcome</h2>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{issue.description}</p>
                </section>
                <section>
                  <h2 className="mb-3 font-medium">Acceptance criteria</h2>
                  {issue.criteria.length ? (
                    <ol className="list-decimal pl-5 text-sm leading-relaxed">
                      {issue.criteria.map((criterion, index) => (
                        <li className="mb-2 pl-1 whitespace-pre-wrap" key={index}>
                          {criterion}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-muted-foreground">No additional criteria defined.</p>
                  )}
                  <p className="mt-4 text-xs text-muted-foreground">
                    You decide whether the result meets the brief. An agent report does not mark these as verified.
                  </p>
                </section>
              </div>
            )}
          </TabsContent>
          <TabsContent value="activity" className="pt-5">
            <div className="flex flex-col gap-5">
              {issue.notes.map((note) => (
                <article key={note.id} className="border-l-2 border-border pl-4">
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {note.kind === "result"
                        ? `${agent.name} · Run result`
                        : note.kind === "note"
                          ? "You · Note"
                          : "You · Activity"}
                    </span>
                    <time title={new Date(note.createdAt).toLocaleString()}>{formatRelativeTime(note.createdAt)}</time>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{note.body}</p>
                </article>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="runs" className="pt-5">
            <div className="flex flex-col gap-4">
              {issue.attempts.length ? (
                issue.attempts.map((attempt, index) => (
                  <article key={attempt.id} className="flex flex-col gap-3 rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="font-medium">Attempt {issue.attempts.length - index}</h2>
                      <Badge variant="outline">{attempt.outcome}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{new Date(attempt.createdAt).toLocaleString()}</p>
                    {attempt.instructions ? (
                      <p className="text-sm whitespace-pre-wrap">{attempt.instructions}</p>
                    ) : null}
                    <p className="text-sm whitespace-pre-wrap">
                      {attempt.summary ??
                        (attempt.outcome === "running" ? "Work is in progress." : "No report provided.")}
                    </p>
                    {attempt.evidence ? (
                      <p className="text-sm whitespace-pre-wrap text-muted-foreground">{attempt.evidence}</p>
                    ) : null}
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">Brief and context used</summary>
                      <pre className="mt-3 whitespace-pre-wrap font-sans text-xs">{attempt.brief}</pre>
                    </details>
                    {attempt.sessionId ? (
                      <Button asChild variant="outline" size="sm" className="self-start">
                        <Link to={`/agents/${agent.id}/sessions/${attempt.sessionId}`}>Open conversation</Link>
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">No conversation was started.</p>
                    )}
                  </article>
                ))
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No runs yet</EmptyTitle>
                    <EmptyDescription>
                      Start work when the brief is ready. Each attempt keeps its own conversation.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </TabsContent>
        </Tabs>
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <Field>
            <FieldLabel htmlFor="issue-reply">{closed ? "Leave a note" : "Add context or instructions"}</FieldLabel>
            <Textarea
              ref={composer}
              id="issue-reply"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={20000}
              placeholder={
                issue.status === "needs_input"
                  ? "Answer the agent’s questions…"
                  : "Write a note, an answer, or changes to request…"
              }
            />
            <FieldDescription>
              Add note saves this without triggering work. Notes are included in the next attempt.
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy || !message.trim()}
              onClick={() => void act(() => api.addIssueNote(agent.id, issueId, message), true)}
            >
              Add note
            </Button>
            {!closed ? (
              <Button
                disabled={executionDisabled || issue.running || !message.trim()}
                onClick={() =>
                  void act(
                    () =>
                      api.runIssue(agent.id, issueId, {
                        instructions: message,
                      }),
                    true,
                  )
                }
              >
                {sendLabel}
              </Button>
            ) : null}
          </div>
          {issue.running ? (
            <p className="text-xs text-muted-foreground">Pause the current run before sending new instructions.</p>
          ) : closed ? (
            <p className="text-xs text-muted-foreground">Reopen this issue to ask the agent for more work.</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 pb-6">
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
                      description: "Stop any active run and close this issue. You can reopen it later.",
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
            disabled={busy || issue.running || editing}
            onClick={async () => {
              if (
                !(await confirmAction({
                  title: "Delete issue?",
                  description: "This deletes the brief, notes, and all attempt conversations.",
                  actionLabel: "Delete",
                }))
              )
                return;
              setBusy(true);
              try {
                await api.deleteIssue(agent.id, issueId);
                await loadIssues(agent.id);
                navigate(`/agents/${agent.id}/issues`);
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
  );
}
