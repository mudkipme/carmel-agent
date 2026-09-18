import type { StoreApi } from "zustand";
import { api } from "@/lib/api";
import { upsertById } from "@/store/harness-state";
import type { HarnessState } from "@/store/harness-types";
import type { Issue } from "@carmel-agent/shared";

type SetState = StoreApi<HarnessState>["setState"];
type IssueActions = Pick<HarnessState,
  "loadIssues" | "loadIssue" | "createIssue" | "updateIssue" | "interruptIssue" | "cancelIssue" | "deleteIssue"
>;

export function createIssueSlice(set: SetState): IssueActions {
  const cache = (issue: Issue) => {
    set((state) => ({ issues: upsertById(state.issues, issue) }));
    return issue;
  };

  return {
    loadIssues: async (agentId) => {
      const loaded = await api.listIssues(agentId);
      set((state) => ({ issues: [...state.issues.filter((issue) => issue.agentId !== agentId), ...loaded] }));
      return loaded;
    },
    loadIssue: async (agentId, issueId) => cache(await api.getIssue(agentId, issueId)),
    createIssue: async (agentId, input) => cache(await api.createIssue(agentId, input)),
    updateIssue: async (issue, patch) => cache(await api.updateIssue(issue.agentId, issue.id, patch)),
    interruptIssue: async (issue) => cache(await api.interruptIssue(issue.agentId, issue.id)),
    cancelIssue: async (issue) => cache(await api.cancelIssue(issue.agentId, issue.id)),
    deleteIssue: async (issue) => {
      await api.deleteIssue(issue.agentId, issue.id);
      set((state) => ({ issues: state.issues.filter((item) => item.id !== issue.id) }));
    },
  };
}
