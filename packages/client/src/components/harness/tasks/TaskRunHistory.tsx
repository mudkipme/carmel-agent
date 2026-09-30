import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { MessageSquareIcon } from "lucide-react";
import type { AgentTask } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { sessionPath } from "@/lib/shell-route";
import { cn } from "@/lib/utils";
import { describeTaskOutcome, formatTaskTime } from "@/lib/task-schedule";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useHarnessStore } from "@/store/harness-store";
import { ResourceError, ResourceLoading } from "../ResourceFeedback";

export function TaskRunHistory({
  task,
  revision,
  onRunFinished,
}: {
  task: AgentTask;
  revision: number;
  onRunFinished: () => Promise<unknown>;
}) {
  const canOpenSessions = useHarnessStore(
    (state) => state.activeUserId === task.userId,
  );
  const {
    data: runs,
    error,
    loading,
    refresh,
  } = useRemoteResource({
    key: `task-runs:${task.id}`,
    load: (signal) => api.listAgentTaskRuns(task.agentId, task.id, signal),
    refreshKey: revision,
    pollInterval: (data) =>
      data?.some((run) => run.outcome === "running") ? 3_000 : 30_000,
  });
  const running = runs?.some((run) => run.outcome === "running") ?? false;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void onRunFinished();
    wasRunning.current = running;
  }, [running, onRunFinished]);

  return (
    <div className="flex min-w-0 flex-col gap-3 border-t pt-3">
      <h3 className="text-sm font-medium">Run history</h3>
      {error ? (
        <ResourceError
          error={error}
          title="Unable to load run history"
          onRetry={refresh}
        />
      ) : null}
      {loading ? (
        <ResourceLoading label="Loading run history" />
      ) : runs?.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {runs?.map((run) => (
            <li
              key={run.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p>
                  {formatTaskTime(run.startedAt)} ·{" "}
                  <span
                    className={cn(
                      "text-muted-foreground",
                      ["failed", "interrupted"].includes(run.outcome) &&
                        "text-destructive",
                    )}
                  >
                    {describeTaskOutcome(run.outcome)}
                  </span>
                </p>
                {run.detail ? (
                  <p className="break-words text-muted-foreground">
                    {run.detail}
                  </p>
                ) : null}
              </div>
              {run.sessionId && canOpenSessions ? (
                <Button asChild variant="ghost" size="sm">
                  <Link
                    to={sessionPath({
                      agentId: task.agentId,
                      id: run.sessionId,
                    })}
                  >
                    <MessageSquareIcon data-icon="inline-start" />
                    Open conversation
                  </Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
