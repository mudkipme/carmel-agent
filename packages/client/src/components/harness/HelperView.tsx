import { Link, useParams, useSearchParams } from "react-router-dom";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { Button } from "@/components/ui/button";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { ResourceError, ResourceLoading } from "./ResourceFeedback";
import { WorkspaceFileLinkAgentContext } from "@/components/chat/workspace-file-links";

export function HelperView() {
  const { agentId, sessionId, helperId } = useParams();
  const [params, setParams] = useSearchParams();
  const before = params.get("before") ?? undefined;
  const detail = useRemoteResource({
    key: `helper:${sessionId}:${helperId}:${before}`,
    load: (signal) => api.getHelper(sessionId!, Number(helperId), before, signal),
    pollInterval: before ? false : 1500,
  });
  const helper = detail.data?.helper;
  return (
    <main className="flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b p-3">
        <Button variant="ghost" asChild>
          <Link to={`/agents/${agentId}/sessions/${sessionId}`}>Back to conversation</Link>
        </Button>
        <span className="min-w-0 flex-1 truncate">{helper?.name ?? "Helper"}</span>
        {helper ? <span className="text-sm text-muted-foreground">{helper.status}</span> : null}
        {helper && ["working", "sleeping", "reporting"].includes(helper.status) ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void api
                .stopHelper(sessionId!, helper.id)
                .then(detail.refresh)
                .catch((error) => showError("Unable to stop helper", error))
            }
          >
            Stop helper
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-5">
        <div className="mx-auto max-w-[var(--line-width)]">
          {detail.error ? (
            <ResourceError error={detail.error} onRetry={detail.refresh} />
          ) : !detail.data ? (
            <ResourceLoading label="Loading helper" />
          ) : (
            <>
              {detail.data.session.olderCursor ? (
                <Button
                  variant="ghost"
                  onClick={() => setParams({ before: detail.data!.session.olderCursor! })}
                >
                  Earlier messages
                </Button>
              ) : null}
              {before ? (
                <Button variant="ghost" onClick={() => setParams({})}>
                  Latest messages
                </Button>
              ) : null}
              <WorkspaceFileLinkAgentContext value={agentId}>
                <ChatMessages
                  messages={detail.data.session.messages}
                  pendingToolCalls={new Set()}
                  isStreaming={helper?.status === "working"}
                />
              </WorkspaceFileLinkAgentContext>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
