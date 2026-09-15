import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createAuthSlice } from "@/store/slices/auth-slice";
import { createResourceSlice } from "@/store/slices/resource-slice";
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
      activeAgentId: "",
      providerConfigs: [],
      modelRefs: [],
      modelCatalog: { providers: [] },
      sessions: [],
      sessionDetails: {},
      activeSessionId: "",
      ...createAuthSlice(set, get),
      ...createResourceSlice(set, get),
      ...createSessionSlice(set),
    }),
    {
      name: "carmel-harness-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activeUserId: state.activeUserId,
        activeAgentId: state.activeAgentId,
      }),
      version: 2,
      // Version 1 also stored the open session; drop it so it is not restored.
      migrate: (persisted) => {
        const { activeUserId = "", activeAgentId = "" } = (persisted ?? {}) as Partial<HarnessPersistedState>;
        return { activeUserId, activeAgentId };
      },
    },
  ),
);
