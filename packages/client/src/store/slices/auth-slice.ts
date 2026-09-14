import type { StoreApi } from "zustand";
import { ApiError, api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { canUserSeeAgent, isListedSession, resetState, resolveBootstrapState, upsertById } from "@/store/harness-state";
import type { HarnessState } from "@/store/harness-types";

type SetState = StoreApi<HarnessState>["setState"];
type GetState = StoreApi<HarnessState>["getState"];

export function createAuthSlice(set: SetState, get: GetState): Pick<
  HarnessState,
  "bootstrap" | "login" | "setup" | "logout" | "updateAccount" | "setActiveUser" | "setActiveAgent" | "setActiveSession"
> {
  return {
    bootstrap: async () => {
      set({ status: "loading", error: undefined });
      try {
        set(resolveBootstrapState(await api.bootstrap(), get()));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          const needsSetup = await api.setupStatus().then((status) => status.needsSetup).catch(() => false);
          set((state) => resetState({ status: needsSetup ? "setup" : "unauthenticated" }, state));
          return;
        }
        set({ status: "error", error: errorMessage(error, "Something went wrong while loading your workspace.") });
      }
    },
    setup: async (input) => {
      set({ status: "loading", error: undefined });
      try {
        set(resolveBootstrapState(await api.setup(input), get()));
      } catch (error) {
        set((state) => ({ ...resetState({ status: "setup" }, state), error: errorMessage(error, "Setup failed") }));
      }
    },
    login: async (username, password) => {
      set({ status: "loading", error: undefined });
      try {
        set(resolveBootstrapState(await api.login(username, password), get()));
      } catch (error) {
        set((state) => ({ ...resetState({ status: "unauthenticated" }, state), error: errorMessage(error, "Login failed") }));
      }
    },
    logout: async () => {
      await api.logout();
      set(resetState({ status: "unauthenticated" }));
    },
    updateAccount: async (currentPassword, email, newPassword) => {
      const saved = await api.updateAccount(currentPassword, email, newPassword);
      set((state) => ({ users: upsertById(state.users, saved) }));
    },
    setActiveUser: (userId) => {
      const state = get();
      const session = state.sessions.find((item) => item.userId === userId && isListedSession(item));
      const agent = state.agents.find((item) => item.id === session?.agentId && canUserSeeAgent(item, userId))
        ?? state.agents.find((item) => item.ownerUserId === userId || item.shared);
      set({ activeUserId: userId, activeAgentId: agent?.id ?? "", activeSessionId: session?.agentId === agent?.id ? (session?.id ?? "") : "" });
    },
    setActiveAgent: (agentId) => {
      const state = get();
      const agent = state.agents.find((item) => item.id === agentId && canUserSeeAgent(item, state.activeUserId));
      if (!agent) return;
      const session = state.sessions.find(
        (item) => item.agentId === agentId && item.userId === state.activeUserId && isListedSession(item),
      );
      set({ activeAgentId: agentId, activeSessionId: session?.id ?? "" });
    },
    setActiveSession: (sessionId) => {
      const state = get();
      const session = state.sessions.find((item) => item.id === sessionId && item.userId === state.activeUserId);
      if (session) set({ activeSessionId: sessionId, activeAgentId: session.agentId });
    },
  };
}
