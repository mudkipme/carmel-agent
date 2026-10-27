import { useRemoteResource } from "./use-remote-resource";
import { api } from "@/lib/api";

export function useSubtasks(sessionId?: string) {
  return useRemoteResource({
    key: `subtasks:${sessionId}`,
    enabled: Boolean(sessionId),
    load: (signal) => api.sessionSubtasks(sessionId!, signal),
    pollInterval: 3000,
  });
}
