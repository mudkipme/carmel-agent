import type { StoreApi } from "zustand";
import { ApiError, api } from "@/lib/api";
import { oidcErrorMessage, takeOidcErrorCode } from "@/lib/auth-errors";
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
      const oidcErrorCode = takeOidcErrorCode();
      try {
        set(resolveBootstrapState(await api.bootstrap(), get()));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          const authOptions = await api.setupStatus().catch(() => undefined);
          set((state) => ({
            ...resetState({ status: authOptions?.needsSetup ? "setup" : "unauthenticated" }, state),
            authOptions,
            error: oidcErrorCode ? oidcErrorMessage(oidcErrorCode, authOptions?.oidc?.providerName) : undefined,
          }));
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
      const authOptions = await api.setupStatus().catch(() => undefined);
      set({ ...resetState({ status: "unauthenticated" }), authOptions });
    },
    updateAccount: async (currentPassword, email, newPassword) => {
      const saved = await api.updateAccount(currentPassword, email, newPassword);
      set((state) => ({ users: upsertById(state.users, saved) }));
    },
    setActiveUser: (userId) => {
      const state = get();
      const session = state.sessions.find((item) => item.userId === userId && isListedSession(item));
      const agent = state.agents.find((item) => item.id === session?.agentId && canUserSeeAgent(item, userId))
        ?? state.agents.find((item) => canUserSeeAgent(item, userId));
      set({ activeUserId: userId, activeAgentId: agent?.id ?? "", activeSessionId: "" });
    },
    setActiveAgent: (agentId) => {
      const state = get();
      const agent = state.agents.find((item) => item.id === agentId && canUserSeeAgent(item, state.activeUserId));
      if (!agent) return;
      // An agent opens on a blank composer; a session is only created once the
      // first message is sent, so there is no session to select here.
      set({ activeAgentId: agentId, activeSessionId: "" });
    },
    setActiveSession: (sessionId) => {
      const state = get();
      const session = state.sessions.find((item) => item.id === sessionId && item.userId === state.activeUserId);
      if (session) set({ activeSessionId: sessionId, activeAgentId: session.agentId });
    },
  };
}
