import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createAuthSlice } from "@/store/slices/auth-slice";
import { createResourceSlice } from "@/store/slices/resource-slice";
import { createIssueSlice } from "@/store/slices/issue-slice";
import { createSessionSlice } from "@/store/slices/session-slice";
import type { HarnessPersistedState, HarnessState } from "@/store/harness-types";

export { defaultBaseUrlForProvider, getAppProviders, makeModelRef, resolveModelRef } from "@/store/model-utils";

export const useHarnessStore = create<HarnessState>()(
  persist<HarnessState, [], [], HarnessPersistedState>(
    (set, get) => ({
      status: "idle",
      users: [],
      activeUserId: "",
      agents: [],
      lastAgentId: "",
      providerConfigs: [],
      modelRefs: [],
      modelCatalog: { providers: [] },
      sessions: [],
      sessionDetails: {},
      issues: [],
      ...createAuthSlice(set, get),
      ...createResourceSlice(set, get),
      ...createSessionSlice(set),
      ...createIssueSlice(set, get),
    }),
    {
      name: "carmel-harness-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ lastAgentId: state.lastAgentId }),
      version: 3,
      // Versions 1 and 2 stored a selection; only the agent survives, as a memory.
      migrate: (persisted) => {
        const stored = (persisted ?? {}) as Partial<HarnessPersistedState> & { activeAgentId?: string };
        return { lastAgentId: stored.lastAgentId ?? stored.activeAgentId ?? "" };
      },
    },
  ),
);
