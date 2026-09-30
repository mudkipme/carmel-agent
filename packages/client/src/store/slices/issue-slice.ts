import type { StoreApi } from "zustand";
import { api } from "@/lib/api";
import { upsertById } from "@/store/harness-state";
import type { HarnessState } from "@/store/harness-types";
import type { Issue } from "@carmel-agent/shared";

type SetState = StoreApi<HarnessState>["setState"];
type IssueActions = Pick<HarnessState, "loadIssues" | "createIssue">;

export function createIssueSlice(
  set: SetState,
  get: StoreApi<HarnessState>["getState"],
): IssueActions {
  const revisions = new Map<string, number>();
  const cache = (issue: Issue) => {
    set((state) => ({ issues: upsertById(state.issues, issue) }));
    return issue;
  };

  return {
    loadIssues: async (agentId, signal) => {
      const userId = get().activeUserId;
      const revision = (revisions.get(agentId) ?? 0) + 1;
      revisions.set(agentId, revision);
      const loaded = await api.listIssues(agentId, signal);
      if (
        signal?.aborted ||
        revisions.get(agentId) !== revision ||
        get().activeUserId !== userId
      )
        return loaded;
      set((state) => {
        const current = state.issues.filter(
          (issue) => issue.agentId === agentId,
        );
        // Polls mostly come back unchanged; keeping the array avoids re-rendering
        // everything that reads it.
        if (JSON.stringify(current) === JSON.stringify(loaded)) return state;
        return {
          issues: [
            ...state.issues.filter((issue) => issue.agentId !== agentId),
            ...loaded,
          ],
        };
      });
      return loaded;
    },
    createIssue: async (agentId, input) =>
      cache(await api.createIssue(agentId, input)),
  };
}
