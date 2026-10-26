import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";

export function SessionHelpers({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const helpers = useRemoteResource({
    key: `helpers:${sessionId}`,
    load: (signal) => api.sessionHelpers(sessionId, signal),
    pollInterval: 3000,
  });
  if (!helpers.data?.helpers.length && !helpers.data?.error) return null;
  const act = (action: Promise<unknown>) =>
    void action
      .then(helpers.refresh)
      .catch((error) => showError("Unable to update helpers", error));
  return (
    <details className="shrink-0 border-b px-4 py-2 text-sm">
      <summary className="cursor-pointer">Helpers ({helpers.data?.helpers.length ?? 0})</summary>
      {helpers.data?.error ? (
        <div role="status" className="py-2">
          {helpers.data.error}
          <Button variant="ghost" size="sm" onClick={() => act(api.resumeHelpers(sessionId))}>
            Resume helpers
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-1 pt-2">
        {helpers.data?.helpers.map((helper) => (
          <div key={helper.id} className="flex items-center gap-2">
            <Link
              className="min-w-0 flex-1 truncate hover:underline"
              to={`/agents/${agentId}/sessions/${sessionId}/helpers/${helper.id}`}
            >
              {helper.name}
            </Link>
            <span className="text-muted-foreground">{helper.status}</span>
            {["working", "sleeping", "reporting"].includes(helper.status) ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => act(api.stopHelper(sessionId, helper.id))}
              >
                Stop
              </Button>
            ) : null}
          </div>
        ))}
        {helpers.data?.helpers.some((helper) =>
          ["working", "sleeping", "reporting"].includes(helper.status),
        ) ? (
          <Button variant="ghost" size="sm" onClick={() => act(api.stopHelpers(sessionId))}>
            Stop all helpers
          </Button>
        ) : null}
      </div>
    </details>
  );
}
