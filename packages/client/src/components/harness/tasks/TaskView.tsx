import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeftIcon,
  CheckIcon,
  MoreHorizontalIcon,
  PlayIcon,
  SquareIcon,
  ListTreeIcon,
  InfoIcon,
} from "lucide-react";
import type { AgentConfig, IssueDetail } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useSessionDraft } from "@/hooks/use-session-draft";
import { useElementWidth } from "@/hooks/use-element-width";
import { draftStorageKey, clearSessionDraft } from "@/lib/session-draft";
import { issueListSearch } from "@/lib/issue-navigation";
import { sessionPath } from "@/lib/shell-route";
import { ResourceError, ResourceLoading } from "../ResourceFeedback";
import { api } from "@/lib/api";
import { confirmAction } from "@/lib/action-dialogs";
import { showError } from "@/lib/errors";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { WorkspaceFileLinkAgentContext } from "@/components/chat/workspace-file-links";
import { SubtaskList } from "@/components/tasks/TaskSubtasks";
import { useSubtasks } from "@/hooks/use-subtasks";
import { describeIssue, isClosedIssue, hasTaskResult } from "./issue-state";
import { TaskBriefForm } from "./TaskBriefForm";
import { TaskConversation } from "./TaskConversation";
import { TaskResult } from "./TaskResult";
import { TaskComposer } from "./TaskComposer";
import { TaskActivity } from "./TaskActivity";
import { TaskPanel } from "./TaskPanel";

type TaskTab = "conversation" | "result" | "activity";

export function TaskView({
  agent,
  issueId,
  onIssuesChanged,
  headerTarget,
}: {
  agent: AgentConfig;
  issueId: string;
  onIssuesChanged: () => Promise<unknown>;
  headerTarget: HTMLElement | null;
}) {
  const resource = useRemoteResource({
    key: `${agent.id}:${issueId}`,
    load: (signal) => api.getIssue(agent.id, issueId, signal),
    pollInterval: (data) => (!data || data.running || data.status === "queued" ? 4_000 : 30_000),
  });
  if (!resource.data)
    return (
      <div className="flex flex-col gap-4 p-6">
        {resource.loading ? <ResourceLoading label="Loading task" /> : null}
        {resource.error ? (
          <ResourceError
            error={resource.error}
            title="Unable to load task"
            onRetry={resource.refresh}
          />
        ) : null}
        <Button asChild variant="link">
          <Link to={`/agents/${agent.id}/tasks`}>Back to tasks</Link>
        </Button>
      </div>
    );
  return (
    <TaskWorkspace
      agent={agent}
      issue={resource.data}
      resource={resource}
      onIssuesChanged={onIssuesChanged}
      headerTarget={headerTarget}
    />
  );
}

function TaskWorkspace({
  agent,
  issue,
  resource,
  onIssuesChanged,
  headerTarget,
}: {
  agent: AgentConfig;
  issue: IssueDetail;
  resource: ReturnType<typeof useRemoteResource<IssueDetail>>;
  onIssuesChanged: () => Promise<unknown>;
  headerTarget: HTMLElement | null;
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [host, width] = useElementWidth<HTMLDivElement>();
  const fromHome = params.get("from") === "home";
  const listPath = fromHome
    ? `/agents/${agent.id}/home`
    : `/agents/${agent.id}/tasks${issueListSearch(params)}`;
  const userId = useHarnessStore((s) => s.activeUserId);
  const briefDraftKey = draftStorageKey(userId, agent.id, issue.id, "brief");
  const replyDraftKey = draftStorageKey(userId, agent.id, issue.id, "reply");
  const [initialTab] = useState<TaskTab>(() =>
    !issue.running &&
    ["in_review", "done"].includes(issue.status) &&
    issue.attempts.some(hasTaskResult)
      ? "result"
      : "conversation",
  );
  const requestedTab = params.get("view");
  const tab: TaskTab =
    requestedTab === "conversation" || requestedTab === "result" || requestedTab === "activity"
      ? requestedTab
      : initialTab;
  const panel = params.get("panel") ?? (params.has("subtask") ? "subtasks" : undefined);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [focusRequested, setFocusRequested] = useState(false);
  const [message, setMessage] = useSessionDraft(
    replyDraftKey,
    "",
    (value): value is string => typeof value === "string",
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const subtaskSession = params.get("subtaskSession") ?? issue.sessionId ?? undefined;
  const subtasks = useSubtasks(subtaskSession);
  const state = describeIssue(issue);
  const closed = isClosedIssue(issue);
  const queued = issue.status === "queued";
  const stopped = issue.lastRunOutcome === "interrupted" || issue.lastRunOutcome === "cancelled";
  const failed = !issue.running && issue.lastRunOutcome && issue.lastRunOutcome !== "succeeded";
  const inputRequest =
    !issue.running && ["needs_input", "blocked"].includes(issue.status)
      ? (issue.lastRunDetail ?? issue.verdictSummary ?? issue.attempts[0]?.summary)
      : undefined;
  const attempt =
    issue.attempts.find((item) => item.id === params.get("run")) ??
    issue.attempts.find(hasTaskResult);
  const reviewingEarlier = tab === "result" && attempt && attempt.id !== issue.attempts[0]?.id;
  const subtaskCount = subtasks.data?.helpers.length ?? 0;
  const activeSubtaskCount =
    subtasks.data?.helpers.filter((item) =>
      ["working", "sleeping", "reporting"].includes(item.status),
    ).length ?? 0;
  const updateLocation = (update: (next: URLSearchParams) => void) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        update(next);
        return next;
      },
      { replace: true },
    );
  const closePanel = () => {
    setEditing(false);
    updateLocation((next) => {
      next.delete("panel");
      next.delete("subtask");
      next.delete("subtaskSession");
      next.delete("subtaskBefore");
    });
  };
  const openPanel = (name: string) => {
    if (name !== "details") setEditing(false);
    updateLocation((next) => next.set("panel", name));
  };
  const selectTab = (value: string) => updateLocation((next) => next.set("view", value));
  const focusReply = () => {
    setEditing(false);
    updateLocation((next) => {
      next.set("view", "conversation");
      next.delete("panel");
      next.delete("subtask");
      next.delete("subtaskSession");
      next.delete("subtaskBefore");
    });
    setFocusRequested(true);
  };
  useEffect(() => {
    if (focusRequested && tab === "conversation") {
      composer.current?.focus({ preventScroll: true });
      setFocusRequested(false);
    }
  }, [focusRequested, tab]);
  const act = async (action: () => Promise<unknown>, clearMessage = false) => {
    const sentMessage = message;
    setBusy(true);
    try {
      await action();
      if (clearMessage) setMessage((current) => (current === sentMessage ? "" : current));
      await resource.refresh();
      await onIssuesChanged();
    } catch (cause) {
      showError("Unable to update task", cause);
      await resource.refresh();
      await onIssuesChanged();
    } finally {
      setBusy(false);
    }
  };
  const queueWork = () =>
    act(async () => {
      await api.runIssue(agent.id, issue.id, { instructions: message || undefined, fresh });
      setFresh(false);
    }, true);
  const saveNote = () => void act(() => api.addIssueNote(agent.id, issue.id, message), true);
  const deleteTask = async () => {
    if (
      !(await confirmAction({
        title: "Delete task?",
        description: "Delete the brief, discussion, saved results, and all conversations.",
        actionLabel: "Delete",
      }))
    )
      return;
    setBusy(true);
    try {
      await api.deleteIssue(agent.id, issue.id);
      clearSessionDraft(briefDraftKey);
      clearSessionDraft(replyDraftKey);
      await onIssuesChanged();
      navigate(listPath);
    } catch (cause) {
      showError("Unable to delete task", cause);
      setBusy(false);
    }
  };
  const header = (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 basis-full items-start gap-2 sm:basis-0">
        <Button asChild variant="ghost" size="icon-sm">
          <Link to={listPath} aria-label={`${agent.name} / ${fromHome ? "Home" : "Tasks"}`}>
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1
            className="line-clamp-2 text-base font-semibold tracking-tight break-words"
            title={issue.title}
          >
            {issue.title}
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <state.Icon className={cn("size-3.5", state.className)} />
              {state.label}
            </span>
            {issue.priority !== "normal" ? <span>{issue.priority} priority</span> : null}
            <span>Updated {formatRelativeTime(issue.updatedAt)}</span>
          </div>
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
        {issue.running ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.interruptIssue(agent.id, issue.id))}
          >
            <SquareIcon data-icon="inline-start" />
            Stop run
          </Button>
        ) : queued ? null : closed ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.reopenIssue(agent.id, issue.id))}
          >
            Reopen task
          </Button>
        ) : issue.status === "in_review" ? (
          <>
            {tab !== "conversation" ? (
              <Button variant="ghost" onClick={focusReply}>
                Request changes
              </Button>
            ) : null}
            <Button
              disabled={busy || editing || Boolean(reviewingEarlier)}
              onClick={() => void act(() => api.acceptIssue(agent.id, issue.id))}
            >
              <CheckIcon data-icon="inline-start" />
              Accept result
            </Button>
          </>
        ) : issue.status === "needs_input" ? (
          <Button onClick={focusReply}>Reply to agent</Button>
        ) : (
          <Button disabled={busy || editing} onClick={() => void queueWork()}>
            <PlayIcon data-icon="inline-start" />
            {failed ? "Retry task" : "Queue task"}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Task actions">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {!closed && !issue.running && !queued ? (
                <DropdownMenuItem
                  disabled={busy}
                  onSelect={() => {
                    openPanel("details");
                    setEditing(true);
                  }}
                >
                  Edit brief
                </DropdownMenuItem>
              ) : null}
              {issue.sessionId && !issue.running && !closed && !queued ? (
                <DropdownMenuItem onSelect={() => setFresh(!fresh)}>
                  {fresh
                    ? "Continue this conversation next run"
                    : "Use a fresh conversation next run"}
                </DropdownMenuItem>
              ) : null}
              {queued ? (
                <DropdownMenuItem
                  disabled={busy}
                  onSelect={() => void act(() => api.removeIssueFromQueue(agent.id, issue.id))}
                >
                  Remove from queue
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {!closed ? (
                <DropdownMenuItem
                  disabled={busy}
                  onSelect={() =>
                    void (async () => {
                      if (
                        await confirmAction({
                          title: "Cancel task?",
                          description:
                            "Stop any active run and close this task. You can reopen it later.",
                          actionLabel: "Cancel task",
                        })
                      )
                        await act(() => api.cancelIssue(agent.id, issue.id));
                    })()
                  }
                >
                  Cancel task
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                variant="destructive"
                disabled={busy || issue.running}
                onSelect={() => void deleteTask()}
              >
                Delete task
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
  const brief = (
    <div className="flex flex-col gap-5">
      {issue.description ? <MarkdownContent content={issue.description} /> : null}
      {issue.criteria.length ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-medium text-muted-foreground">Acceptance criteria</h3>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
            {issue.criteria.map((criterion, index) => (
              <li key={index} className="break-words">
                {criterion}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
  return (
    <WorkspaceFileLinkAgentContext value={agent.id}>
      {headerTarget ? createPortal(header, headerTarget) : header}
      <Tabs
        ref={host}
        value={tab}
        onValueChange={selectTab}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b px-3 py-1 sm:px-5">
          <TabsList variant="line" aria-label="Task views">
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="result" disabled={!issue.attempts.some(hasTaskResult)}>
              Result
            </TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-1">
            {subtaskCount || subtasks.data?.error || subtasks.error ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Subtasks"
                aria-expanded={panel === "subtasks"}
                onClick={() => (panel === "subtasks" ? closePanel() : openPanel("subtasks"))}
              >
                <ListTreeIcon data-icon="inline-start" />
                <span className="sm:hidden">{subtaskCount}</span>
                <span className="hidden sm:inline">
                  {activeSubtaskCount
                    ? `${activeSubtaskCount} running`
                    : `${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}`}
                </span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              aria-label="Details"
              aria-expanded={panel === "details"}
              onClick={() => (panel === "details" ? closePanel() : openPanel("details"))}
            >
              <InfoIcon data-icon="inline-start" />
              <span className="hidden sm:inline">Details</span>
            </Button>
          </div>
        </div>
        {resource.error ? (
          <ResourceError
            error={resource.error}
            title="Connection lost"
            onRetry={resource.refresh}
          />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TabsContent
              value="conversation"
              forceMount
              className={cn("flex min-h-0 flex-col", tab !== "conversation" && "hidden")}
            >
              {failed || inputRequest ? (
                <div className="mx-auto max-h-48 w-full max-w-[var(--line-width)] shrink-0 overflow-y-auto px-4 pt-4">
                  <Alert variant={failed ? "destructive" : "default"}>
                    <AlertTitle>
                      {failed ? (stopped ? "Run stopped" : "Run failed") : "Needs your input"}
                    </AlertTitle>
                    <AlertDescription>
                      <MarkdownContent
                        content={
                          failed
                            ? (issue.lastRunDetail ??
                              (stopped
                                ? "Queue this task to continue."
                                : "Retry this task to continue."))
                            : inputRequest!
                        }
                      />
                    </AlertDescription>
                  </Alert>
                </div>
              ) : null}
              {queued ? (
                <div className="mx-auto w-full max-w-[var(--line-width)] px-4 pt-4">
                  <Alert>
                    <AlertTitle>Queued</AlertTitle>
                    <AlertDescription>
                      {issue.queuedInstructions ??
                        "This task will start when the agent is available."}
                    </AlertDescription>
                  </Alert>
                </div>
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col">
                {issue.sessionId ? (
                  <TaskConversation
                    key={issue.sessionId}
                    agent={agent}
                    sessionId={issue.sessionId}
                    running={issue.running}
                    notes={issue.notes}
                  />
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <div className="mx-auto flex max-w-[var(--line-width)] flex-col gap-6 px-4 py-6">
                      {brief}
                      {issue.notes
                        .filter((note) => note.kind === "note")
                        .map((note) => (
                          <MarkdownContent key={note.id} content={note.body} />
                        ))}
                    </div>
                  </div>
                )}
              </div>
              <TaskComposer
                inputRef={composer}
                message={message}
                onChange={setMessage}
                onSaveNote={saveNote}
                busy={busy || editing}
                fresh={fresh}
                sendLabel={
                  issue.running
                    ? "Send update"
                    : issue.status === "in_review"
                      ? "Request changes"
                      : "Send & queue"
                }
                placeholder={
                  closed || queued
                    ? "Leave a note…"
                    : issue.status === "needs_input"
                      ? "Answer the agent’s question…"
                      : issue.status === "in_review"
                        ? "Describe what should change…"
                        : "Reply to the agent…"
                }
                onSend={
                  closed || queued
                    ? undefined
                    : () =>
                        void (issue.running
                          ? act(() => api.sendIssueUpdate(agent.id, issue.id, message), true)
                          : queueWork())
                }
              />
            </TabsContent>
            <TabsContent
              value="result"
              forceMount
              className={cn("min-h-0 overflow-y-auto", tab !== "result" && "hidden")}
            >
              {attempt ? (
                <div className="mx-auto flex max-w-[var(--line-width)] flex-col gap-6 px-4 py-6">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      Run {issue.attempts.length - issue.attempts.indexOf(attempt)} ·{" "}
                      {attempt.outcome.replaceAll("_", " ")}
                    </span>
                    {attempt.finishedAt ? (
                      <span>{formatRelativeTime(attempt.finishedAt)}</span>
                    ) : null}
                  </div>
                  {reviewingEarlier ? (
                    <Button
                      variant="outline"
                      className="self-start"
                      size="sm"
                      onClick={() => updateLocation((next) => next.delete("run"))}
                    >
                      Latest result
                    </Button>
                  ) : null}
                  <TaskResult key={attempt.id} attempt={attempt} />
                  {attempt.sessionId && attempt.sessionId !== issue.sessionId ? (
                    <Button asChild variant="ghost" size="sm" className="self-start">
                      <Link to={sessionPath({ agentId: agent.id, id: attempt.sessionId })}>
                        View conversation
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      className="self-start"
                      variant="ghost"
                      size="sm"
                      onClick={() => selectTab("conversation")}
                    >
                      View conversation
                    </Button>
                  )}
                </div>
              ) : null}
            </TabsContent>
            <TabsContent
              value="activity"
              forceMount
              className={cn("min-h-0 overflow-y-auto", tab !== "activity" && "hidden")}
            >
              <div className="mx-auto max-w-[var(--line-width)] px-4">
                <TaskActivity
                  issue={issue}
                  onViewResult={(id) =>
                    updateLocation((next) => {
                      next.set("run", id);
                      next.set("view", "result");
                    })
                  }
                />
              </div>
            </TabsContent>
          </div>
          {panel === "details" || panel === "subtasks" ? (
            <TaskPanel
              key={panel}
              title={panel === "details" ? "Task details" : "Subtasks"}
              inline={width >= 1000}
              onClose={closePanel}
            >
              {panel === "subtasks" && subtaskSession ? (
                <SubtaskList sessionId={subtaskSession} resource={subtasks} showHeading={false} />
              ) : editing ? (
                <TaskBriefForm
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
                      await api.updateIssue(agent.id, issue.id, draft);
                      clearSessionDraft(briefDraftKey);
                      setEditing(false);
                    })
                  }
                  onCancel={() => {
                    clearSessionDraft(briefDraftKey);
                    setEditing(false);
                  }}
                />
              ) : (
                <div className="flex flex-col gap-5">
                  {brief}
                  {!closed && !issue.running && !queued ? (
                    <Button
                      variant="outline"
                      className="self-start"
                      disabled={busy}
                      onClick={() => setEditing(true)}
                    >
                      Edit brief
                    </Button>
                  ) : null}
                  <span className="text-xs text-muted-foreground">Priority · {issue.priority}</span>
                </div>
              )}
            </TaskPanel>
          ) : null}
        </div>
      </Tabs>
    </WorkspaceFileLinkAgentContext>
  );
}
