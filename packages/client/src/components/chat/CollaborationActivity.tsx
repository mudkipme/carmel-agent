import { useLingui } from "@lingui/react";
import { Link } from "react-router-dom";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useHarnessStore } from "@/store/harness-store";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "./MarkdownContent";

const statuses = {
  queued: /*i18n*/ "Queued",
  working: /*i18n*/ "Working",
  answered: /*i18n*/ "Answered",
  failed: /*i18n*/ "Failed",
  cancelled: /*i18n*/ "Cancelled",
};
export function CollaborationActivity({
  agentId,
  sessionId,
}: {
  agentId: string;
  sessionId: string;
}) {
  const { i18n } = useLingui();
  const agents = useHarnessStore((state) => state.agents);
  const resource = useRemoteResource({
    key: `collaborations:${agentId}:${sessionId}`,
    load: (signal) => api.getCollaborations(agentId, signal),
    topics: ["sessions", "issues"],
  });
  const items =
    resource.data?.filter(
      (row) => row.sourceSessionId === sessionId || row.targetSessionId === sessionId,
    ) ?? [];
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-3 py-3">
      {items.map((row) => {
        const peer = row.sourceAgentId === agentId ? row.targetAgentId : row.sourceAgentId;
        const link = row.targetIssueId
          ? `/agents/${row.targetAgentId}/tasks/${row.targetIssueId}`
          : row.targetSessionId
            ? `/agents/${row.targetAgentId}/sessions/${row.targetSessionId}`
            : undefined;
        return (
          <details key={row.id} className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              {agents.find((agent) => agent.id === peer)?.name ?? peer} ·{" "}
              {i18n._(statuses[row.status])}
            </summary>
            <div className="flex flex-col gap-3 pt-3">
              <MarkdownContent content={row.request} />
              {row.answer ? <MarkdownContent content={row.answer} /> : null}
              <div className="flex gap-2">
                {link ? (
                  <Button asChild variant="link" size="sm">
                    <Link to={link}>{i18n._("Open")}</Link>
                  </Button>
                ) : null}
                {row.sourceAgentId === agentId && ["queued", "working"].includes(row.status) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void api
                        .cancelCollaboration(agentId, row.id)
                        .then(() => resource.refresh())
                        .catch((error) => showError(i18n._("Unable to stop collaboration"), error))
                    }
                  >
                    {i18n._("Stop")}
                  </Button>
                ) : null}
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}
