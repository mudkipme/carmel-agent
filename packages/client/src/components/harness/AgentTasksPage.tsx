import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import type { AgentConfig, AgentTaskCreateCommand } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { confirmAction } from "@/lib/action-dialogs";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { clearSessionDraft, draftStorageKey } from "@/lib/session-draft";
import {
  describeTaskSchedule,
  describeTaskState,
  emptyTaskDraft,
  taskDraft,
} from "@/lib/task-schedule";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useHarnessStore } from "@/store/harness-store";
import { ResourceError, ResourceLoading } from "./ResourceFeedback";
import { TaskForm } from "./tasks/TaskForm";
import { TaskRunHistory } from "./tasks/TaskRunHistory";

export function AgentTasksPage({ agent }: { agent: AgentConfig }) {
  const userId = useHarnessStore((state) => state.activeUserId);
  const tasks = useRemoteResource({
    key: `tasks:${agent.id}`,
    load: (signal) => api.listAgentTasks(agent.id, signal),
    pollInterval: 30_000,
  });
  const [editor, setEditor] = useState<{
    id?: string;
    initial: AgentTaskCreateCommand;
  }>();
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const historyTaskId = params.get("task") ?? undefined;
  const setHistoryTaskId = (id?: string) =>
    setParams(id ? { task: id } : {}, { replace: true });
  const [historyRevision, setHistoryRevision] = useState(0);
  const draftKey = draftStorageKey(
    userId,
    agent.id,
    "task",
    editor?.id ?? "new",
  );
  const act = async (action: () => Promise<unknown>, title: string) => {
    setBusy(true);
    try {
      await action();
      await tasks.refresh();
    } catch (error) {
      showError(title, error);
    } finally {
      setBusy(false);
    }
  };
  const closeEditor = () => {
    clearSessionDraft(draftKey);
    setEditor(undefined);
  };
  return (
    <div className="h-full min-w-0 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex min-w-0 max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="mb-1 text-sm text-muted-foreground">{agent.name}</p>
            <h1 className="text-2xl font-semibold">Tasks</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Schedule work for this agent. Each run has its own conversation
              and result.
            </p>
          </div>
          <Button
            disabled={busy || Boolean(editor)}
            onClick={() => setEditor({ initial: emptyTaskDraft() })}
          >
            <PlusIcon data-icon="inline-start" />
            New task
          </Button>
        </div>
        {tasks.error ? (
          <ResourceError
            error={tasks.error}
            title="Unable to load tasks"
            onRetry={tasks.refresh}
          />
        ) : null}
        {editor ? (
          <TaskForm
            key={editor.id ?? "new"}
            initial={editor.initial}
            editing={Boolean(editor.id)}
            draftKey={draftKey}
            busy={busy}
            onCancel={closeEditor}
            onSave={(draft) =>
              act(
                async () => {
                  if (editor.id)
                    await api.updateAgentTask(agent.id, editor.id, draft);
                  else await api.createAgentTask(agent.id, draft);
                  closeEditor();
                },
                editor.id ? "Unable to save task" : "Unable to create task",
              )
            }
          />
        ) : null}
        {tasks.loading ? (
          <ResourceLoading label="Loading tasks" />
        ) : tasks.data?.length === 0 && !tasks.error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No scheduled tasks</EmptyTitle>
              <EmptyDescription>
                Create a task to run this agent on a schedule, even while the
                app is closed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex min-w-0 flex-col gap-3">
            {tasks.data?.map((task) => (
              <li
                key={task.id}
                className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium break-words">
                      {task.name}
                    </h2>
                    <p className="mt-1 text-sm break-words text-muted-foreground">
                      {describeTaskSchedule(task)}
                    </p>
                    <p className="mt-1 text-xs break-words text-muted-foreground">
                      {describeTaskState(task)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Run ${task.name} now`}
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await api.runAgentTaskNow(
                            agent.id,
                            task.id,
                          );
                          if (result.outcome !== "running")
                            throw new Error(
                              result.detail ?? "The task did not run.",
                            );
                          setHistoryTaskId(task.id);
                          setHistoryRevision((revision) => revision + 1);
                        }, "Unable to run task")
                      }
                    >
                      <PlayIcon />
                    </Button>
                    <Button
                      variant={
                        historyTaskId === task.id ? "secondary" : "ghost"
                      }
                      size="icon-sm"
                      aria-label={`Run history for ${task.name}`}
                      aria-expanded={historyTaskId === task.id}
                      onClick={() =>
                        setHistoryTaskId(
                          historyTaskId === task.id ? undefined : task.id,
                        )
                      }
                    >
                      <HistoryIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api.updateAgentTask(agent.id, task.id, {
                              status:
                                task.status === "active" ? "paused" : "active",
                            }),
                          "Unable to update task",
                        )
                      }
                    >
                      {task.status === "active" ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${task.name}`}
                      disabled={busy || Boolean(editor)}
                      onClick={() =>
                        setEditor({ id: task.id, initial: taskDraft(task) })
                      }
                    >
                      <PencilIcon data-icon="inline-start" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${task.name}`}
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: `Delete “${task.name}”?`,
                            description:
                              "This deletes the task and its run conversations. Runs moved to your session list are kept.",
                            actionLabel: "Delete task",
                          })
                        ) {
                          void act(async () => {
                            await api.deleteAgentTask(agent.id, task.id);
                            clearSessionDraft(
                              draftStorageKey(
                                userId,
                                agent.id,
                                "task",
                                task.id,
                              ),
                            );
                            if (historyTaskId === task.id)
                              setHistoryTaskId(undefined);
                            if (editor?.id === task.id) setEditor(undefined);
                          }, "Unable to delete task");
                        }
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
                {historyTaskId === task.id ? (
                  <TaskRunHistory
                    task={task}
                    revision={historyRevision}
                    onRunFinished={tasks.refresh}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
