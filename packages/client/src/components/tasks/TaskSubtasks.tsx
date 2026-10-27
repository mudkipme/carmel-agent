import { useSearchParams } from "react-router-dom";
import { ChevronDownIcon, ChevronRightIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { ResourceError, ResourceLoading } from "@/components/harness/ResourceFeedback";

const active = (status: string) => ["working", "sleeping", "reporting"].includes(status);

export function TaskSubtasks({ sessionId }: { sessionId: string }) {
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get("subtask")) || undefined;
  const resource = useRemoteResource({
    key: `subtasks:${sessionId}`,
    load: (signal) => api.sessionSubtasks(sessionId, signal),
    pollInterval: 3000,
  });
  if (!resource.data?.helpers.length && !resource.data?.error && !resource.error) return null;
  const toggle = (id: number) => {
    const next = new URLSearchParams(params);
    next.delete("subtaskBefore");
    if (selected === id) {
      next.delete("subtask");
      next.delete("subtaskSession");
    } else {
      next.set("subtask", String(id));
      next.set("subtaskSession", sessionId);
    }
    setParams(next, { replace: true });
  };
  const act = async (action: Promise<unknown>) => {
    try {
      await action;
      await resource.refresh();
    } catch (error) {
      showError("Unable to update subtasks", error);
    }
  };
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Subtasks">
      <h2 className="text-sm font-medium">Subtasks</h2>
      {resource.error ? <ResourceError error={resource.error} onRetry={resource.refresh} /> : null}
      {resource.data?.error ? (
        <div role="status" className="flex items-center justify-between gap-3 text-sm">
          <span>{resource.data.error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void act(api.resumeSubtasks(sessionId))}
          >
            Resume
          </Button>
        </div>
      ) : null}
      <div className="divide-y rounded-lg border">
        {resource.data?.helpers.map((subtask) => (
          <div key={subtask.id}>
            <div className="flex min-w-0 items-center gap-2 p-2">
              <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start"
                aria-expanded={selected === subtask.id}
                aria-controls={`subtask-${subtask.id}`}
                onClick={() => toggle(subtask.id)}
              >
                {selected === subtask.id ? (
                  <ChevronDownIcon data-icon="inline-start" />
                ) : (
                  <ChevronRightIcon data-icon="inline-start" />
                )}
                <span className="truncate">{subtask.name}</span>
              </Button>
              <Badge variant={subtask.status === "failed" ? "destructive" : "secondary"}>
                {subtask.status === "done"
                  ? "Completed"
                  : subtask.status === "working"
                    ? "Running"
                    : subtask.status === "sleeping"
                      ? "Scheduled"
                      : subtask.status === "reporting"
                        ? "Finishing"
                        : subtask.status === "stopped"
                          ? "Stopped"
                          : "Failed"}
              </Badge>
              {active(subtask.status) ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Stop ${subtask.name}`}
                  onClick={() => void act(api.stopSubtask(sessionId, subtask.id))}
                >
                  <SquareIcon />
                </Button>
              ) : null}
            </div>
            {selected === subtask.id ? (
              <div
                id={`subtask-${subtask.id}`}
                className="flex min-w-0 flex-col gap-4 border-t px-4 py-3"
              >
                <SubtaskDetail
                  sessionId={sessionId}
                  id={subtask.id}
                  running={active(subtask.status)}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function SubtaskDetail({
  sessionId,
  id,
  running,
}: {
  sessionId: string;
  id: number;
  running: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const before = params.get("subtaskBefore") ?? undefined;
  const resource = useRemoteResource({
    key: `subtask:${sessionId}:${id}:${before}`,
    load: (signal) => api.getSubtask(sessionId, id, before, signal),
    pollInterval: running && !before ? 1500 : false,
    refreshKey: running,
  });
  const page = (cursor?: string) => {
    const next = new URLSearchParams(params);
    if (cursor) next.set("subtaskBefore", cursor);
    else next.delete("subtaskBefore");
    setParams(next, { replace: true });
  };
  if (resource.error) return <ResourceError error={resource.error} onRetry={resource.refresh} />;
  if (!resource.data) return <ResourceLoading label="Loading subtask" />;
  return (
    <>
      <MarkdownContent content={resource.data.helper.task} />
      {resource.data.session.olderCursor ? (
        <Button variant="ghost" size="sm" onClick={() => page(resource.data!.session.olderCursor!)}>
          Earlier messages
        </Button>
      ) : null}
      {before ? (
        <Button variant="ghost" size="sm" onClick={() => page()}>
          Latest messages
        </Button>
      ) : null}
      <ChatMessages
        messages={resource.data.session.messages}
        pendingToolCalls={new Set()}
        isStreaming={running}
      />
    </>
  );
}
