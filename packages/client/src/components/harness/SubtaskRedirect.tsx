import { Navigate, useParams } from "react-router-dom";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { ResourceError, ResourceLoading } from "./ResourceFeedback";

export function SubtaskRedirect() {
  const { agentId, sessionId, helperId } = useParams();
  const resource = useRemoteResource({
    key: `subtask-parent:${sessionId}:${helperId}`,
    load: (signal) => api.getSubtask(sessionId!, Number(helperId), undefined, signal),
  });
  if (resource.error) return <ResourceError error={resource.error} onRetry={resource.refresh} />;
  if (!resource.data) return <ResourceLoading label="Opening task" />;
  const parent = resource.data.session.issueId;
  const path = parent
    ? `/agents/${agentId}/tasks/${parent}`
    : `/agents/${agentId}/sessions/${sessionId}`;
  return <Navigate to={`${path}?subtask=${helperId}&subtaskSession=${sessionId}`} replace />;
}
