import {
  CircleCheckIcon,
  CircleSlashIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PiChat } from "@/components/PiChat";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmAction, promptText } from "@/lib/action-dialogs";
import { showError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, Issue, ModelRef, ProviderConfig } from "@carmel-agent/shared";
import { describeIssue, issueVerdictSummary } from "./issue-state";
import { IssueStatusIcon } from "./IssueStatusIcon";

const SHOW_WORK_STORAGE_KEY = "carmel-issue-show-work";

/**
 * One issue: its state and controls above, and below them the conversation it
 * is worked in, with each run's working folded away unless asked for.
 */
export function IssueView({
  agent,
  issueId,
  modelRefs,
  providerConfigs,
}: {
  agent: AgentConfig;
  issueId: string;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
}) {
  const issue = useHarnessStore((state) => state.issues.find((item) => item.id === issueId));
  const loadIssue = useHarnessStore((state) => state.loadIssue);
  const loadUnlistedSession = useHarnessStore((state) => state.loadUnlistedSession);
  const sessionMetadata = useHarnessStore((state) => state.sessions.find((item) => item.id === issue?.sessionId));
  const sessionDetail = useHarnessStore((state) => (issue ? state.sessionDetails[issue.sessionId] : undefined));
  const [missing, setMissing] = useState(false);
  const [showWork, setShowWork] = useState(readShowWork);
  const sessionId = issue?.sessionId;

  useEffect(() => {
    setMissing(false);
    void loadIssue(agent.id, issueId).catch(() => setMissing(true));
  }, [agent.id, issueId, loadIssue]);

  useEffect(() => {
    if (sessionId) void loadUnlistedSession(sessionId).catch(() => setMissing(true));
  }, [loadUnlistedSession, sessionId]);

  /* The list polls, but a run starting or ending in this very chat should show
     in the status straight away. */
  const refreshIssue = useCallback(() => {
    void loadIssue(agent.id, issueId).catch(() => undefined);
  }, [agent.id, issueId, loadIssue]);

  const toggleShowWork = () => {
    setShowWork((value) => {
      try {
        window.localStorage.setItem(SHOW_WORK_STORAGE_KEY, value ? "0" : "1");
      } catch {
        // A preference that does not stick is not worth an error.
      }
      return !value;
    });
  };

  if (missing && !issue) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Issue not found.</div>;
  }
  if (!issue) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading issue...</div>;
  }

  const session = sessionMetadata ? (sessionDetail ?? { ...sessionMetadata, messages: [], messageEntryIds: [] }) : undefined;
  const modelRef = modelRefs.find((model) => model.id === session?.modelRefId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IssueBar issue={issue} showWork={showWork} onToggleShowWork={toggleShowWork} />
      <div className="min-h-0 flex-1">
        {session && modelRef ? (
          <PiChat
            key={session.id}
            agentConfig={agent}
            session={session}
            modelRef={modelRef}
            modelRefs={modelRefs}
            providerConfigs={providerConfigs}
            collapseRunDetails={!showWork}
            onStreamingChange={refreshIssue}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading issue...</div>
        )}
      </div>
    </div>
  );
}

function IssueBar({ issue, showWork, onToggleShowWork }: { issue: Issue; showWork: boolean; onToggleShowWork: () => void }) {
  const navigate = useNavigate();
  const updateIssue = useHarnessStore((state) => state.updateIssue);
  const interruptIssue = useHarnessStore((state) => state.interruptIssue);
  const cancelIssue = useHarnessStore((state) => state.cancelIssue);
  const deleteIssue = useHarnessStore((state) => state.deleteIssue);
  const [busy, setBusy] = useState(false);
  const state = describeIssue(issue);
  const summary = issueVerdictSummary(issue);
  const open = issue.status === "open";

  const act = async (title: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showError(title, error);
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const next = (await promptText({ title: "Rename issue", initialValue: issue.title }))?.trim();
    if (next && next !== issue.title) await act("Unable to rename issue", () => updateIssue(issue, { title: next }));
  };

  const cancel = async () => {
    const confirmed = await confirmAction({
      title: `Cancel “${issue.title}”?`,
      description: "The agent stops working on it and the issue is closed as cancelled. Its conversation is kept, and replying reopens it.",
      actionLabel: "Cancel issue",
    });
    if (confirmed) await act("Unable to cancel issue", () => cancelIssue(issue));
  };

  const remove = async () => {
    const confirmed = await confirmAction({
      title: `Delete “${issue.title}”?`,
      description: "The issue and its conversation will be permanently deleted.",
      actionLabel: "Delete issue",
    });
    if (!confirmed) return;
    await act("Unable to delete issue", async () => {
      await deleteIssue(issue);
      navigate(`/agents/${issue.agentId}/issues`, { replace: true });
    });
  };

  return (
    <div className="flex shrink-0 flex-col border-b bg-muted/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 text-[13px]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <IssueStatusIcon issue={issue} />
          <span className="shrink-0 font-medium">{state.label}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {issue.lastRunOutcome === "failed" && issue.lastRunDetail && !issue.running
              ? issue.lastRunDetail
              : `Opened ${formatRelativeTime(issue.createdAt)}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="ghost" aria-pressed={showWork} onClick={onToggleShowWork}>
            {showWork ? <EyeOffIcon data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
            {showWork ? "Hide work" : "Show work"}
          </Button>
          {issue.running ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void act("Unable to interrupt", () => interruptIssue(issue))}>
              <SquareIcon data-icon="inline-start" />
              Interrupt
            </Button>
          ) : open ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void act("Unable to resolve issue", () => updateIssue(issue, { status: "resolved" }))}>
              <CircleCheckIcon data-icon="inline-start" />
              Resolve
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void act("Unable to reopen issue", () => updateIssue(issue, { status: "open" }))}>
              <RotateCcwIcon data-icon="inline-start" />
              Reopen
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="ghost" title="Issue actions" disabled={busy}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={() => void rename()}>
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              {open ? (
                <DropdownMenuItem onSelect={() => void cancel()}>
                  <CircleSlashIcon />
                  Cancel issue
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={issue.running} onSelect={() => void remove()}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {/* The agent's own account of where it stopped: its questions, what
          blocks it, or what it did. Shown in full, since it is the one thing
          here written for the reader. */}
      {summary ? (
        <div className="max-h-40 overflow-y-auto border-t border-border/60 px-3 py-2 text-[13px] whitespace-pre-wrap">
          {summary}
        </div>
      ) : null}
    </div>
  );
}

function readShowWork() {
  try {
    return window.localStorage.getItem(SHOW_WORK_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
