import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDownIcon, ChevronRightIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSubtasks } from "@/hooks/use-subtasks";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { ResourceError, ResourceLoading } from "@/components/harness/ResourceFeedback";

const active = (status: string) => ["working", "sleeping", "reporting"].includes(status);

export function TaskSubtasks({ sessionId }: { sessionId: string }) {
  const resource = useSubtasks(sessionId);
  return <SubtaskList sessionId={sessionId} resource={resource} />;
}

export function SubtaskList({
  sessionId,
  resource,
  showHeading = true,
}: {
  sessionId: string;
  resource: ReturnType<typeof useSubtasks>;
  showHeading?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get("subtask")) || undefined;
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
      {showHeading ? <h2 className="text-sm font-medium">Subtasks</h2> : null}
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
      <div className="divide-y">
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
              <SubtaskDetail
                sessionId={sessionId}
                id={subtask.id}
                running={active(subtask.status)}
              />
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
  const panel = useRef<HTMLDivElement>(null);
  const before = params.get("subtaskBefore") ?? undefined;
  const resource = useRemoteResource({
    key: `subtask:${sessionId}:${id}:${before}`,
    load: (signal) => api.getSubtask(sessionId, id, before, signal),
    pollInterval: running && !before ? 1500 : false,
    refreshKey: running,
  });
  const ready = Boolean(resource.data || resource.error);
  useEffect(() => {
    if (!ready) return;
    panel.current?.scrollIntoView({ block: "start", inline: "nearest" });
    panel.current?.focus({ preventScroll: true });
  }, [sessionId, id, before, ready]);
  const page = (cursor?: string) => {
    const next = new URLSearchParams(params);
    if (cursor) next.set("subtaskBefore", cursor);
    else next.delete("subtaskBefore");
    setParams(next, { replace: true });
  };
  const detail = resource.data;
  const transcript = detail ? (
    <>
      {detail.session.olderCursor ? (
        <Button variant="ghost" size="sm" onClick={() => page(detail.session.olderCursor!)}>
          Earlier messages
        </Button>
      ) : null}
      {before ? (
        <Button variant="ghost" size="sm" onClick={() => page()}>
          Latest messages
        </Button>
      ) : null}
      <ChatMessages
        messages={detail.session.messages}
        pendingToolCalls={new Set()}
        isStreaming={running}
      />
    </>
  ) : null;
  return (
    <div
      ref={panel}
      id={`subtask-${id}`}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-4 border-t px-4 py-3"
    >
      {resource.error ? (
        <ResourceError error={resource.error} onRetry={resource.refresh} />
      ) : !detail ? (
        <ResourceLoading label="Loading subtask" />
      ) : (
        <>
          {detail.helper.answer ? (
            <MarkdownContent content={detail.helper.answer} />
          ) : !detail.session.messages.length ? (
            <MarkdownContent content={detail.helper.task} />
          ) : null}
          {detail.helper.answer ? (
            <details open={Boolean(before) || undefined}>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Conversation
              </summary>
              <div className="flex min-w-0 flex-col gap-4 pt-4">{transcript}</div>
            </details>
          ) : (
            transcript
          )}
        </>
      )}
    </div>
  );
}
