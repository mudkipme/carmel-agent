import type { StoreApi } from "zustand";
import { api } from "@/lib/api";
import { readSessionConnection } from "@/lib/session-connection";
import { cacheSession, toSessionMetadata } from "@/store/harness-state";
import type { HarnessState } from "@/store/harness-types";

type SetState = StoreApi<HarnessState>["setState"];
type SessionActions = Pick<HarnessState,
  "createSession" | "importOpenWebuiSessions" | "updateSession" | "truncateSessionMessages" |
  "editSessionMessage" | "connectSession" | "refreshSession" | "forkSession" | "deleteSession"
>;

export function createSessionSlice(set: SetState): SessionActions {
  return {
    createSession: async (draft) => {
      const session = await api.createSession(draft);
      set((state) => ({ sessions: [toSessionMetadata(session), ...state.sessions], sessionDetails: { ...state.sessionDetails, [session.id]: session }, activeSessionId: session.id, activeAgentId: session.agentId }));
      return session;
    },
    importOpenWebuiSessions: async (draft) => {
      const imported = (await api.importOpenWebuiSessions(draft)).sessions;
      set((state) => ({
        sessions: [...imported.map(toSessionMetadata), ...state.sessions],
        sessionDetails: { ...state.sessionDetails, ...Object.fromEntries(imported.map((session) => [session.id, session])) },
        activeSessionId: imported[0]?.id ?? state.activeSessionId,
        activeAgentId: imported[0]?.agentId ?? state.activeAgentId,
      }));
      return imported;
    },
    updateSession: async (sessionId, patch) => {
      const saved = await api.updateSession(sessionId, patch);
      set((state) => cacheSession(state, saved));
    },
    truncateSessionMessages: async (sessionId, entryId, thinkingLevel) => {
      const saved = await api.truncateSessionMessages(sessionId, entryId, thinkingLevel);
      set((state) => cacheSession(state, saved));
      return saved;
    },
    editSessionMessage: async (sessionId, entryId, content, options) => {
      const saved = await api.editSessionMessage(sessionId, entryId, content, options);
      set((state) => cacheSession(state, saved));
      return saved;
    },
    connectSession: async (sessionId) => {
      const connection = await readSessionConnection(sessionId);
      set((state) => cacheSession(state, connection.session));
      return connection;
    },
    refreshSession: async (sessionId) => {
      const session = (await readSessionConnection(sessionId)).session;
      set((state) => cacheSession(state, session));
      return session;
    },
    forkSession: async (sessionId, entryId) => {
      const session = await api.forkSession(sessionId, entryId);
      set((state) => ({ sessions: [toSessionMetadata(session), ...state.sessions], sessionDetails: { ...state.sessionDetails, [session.id]: session }, activeSessionId: session.id, activeAgentId: session.agentId }));
      return session;
    },
    deleteSession: async (sessionId) => {
      await api.deleteSession(sessionId);
      set((state) => {
        const deleted = state.sessions.find((item) => item.id === sessionId);
        const sessions = state.sessions.filter((item) => item.id !== sessionId);
        const { [sessionId]: _deleted, ...sessionDetails } = state.sessionDetails;
        const activeSessionId = state.activeSessionId === sessionId
          ? (sessions.find((item) => item.userId === state.activeUserId && item.agentId === (deleted?.agentId ?? state.activeAgentId))?.id ?? "")
          : state.activeSessionId;
        return { sessions, sessionDetails, activeSessionId };
      });
    },
  };
}
