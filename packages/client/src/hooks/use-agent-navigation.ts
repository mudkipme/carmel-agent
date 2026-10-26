import { useCallback, useState } from "react";

type Navigation = { view: "agents" | "sessions"; sessions: Record<string, string> };

export function useAgentNavigation(userId: string) {
  const key = `carmel-navigation:${userId}`;
  const [state, setState] = useState<Navigation>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      return {
        view: saved?.view === "agents" ? "agents" : "sessions",
        sessions: saved?.sessions ?? {},
      };
    } catch {
      return { view: "sessions", sessions: {} };
    }
  });
  const save = useCallback(
    (change: (current: Navigation) => Navigation) => {
      setState((current) => {
        const next = change(current);
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* Navigation remains available without storage. */
        }
        return next;
      });
    },
    [key],
  );
  const rememberSession = useCallback(
    (agentId: string, sessionId: string) =>
      save((current) =>
        current.sessions[agentId] === sessionId
          ? current
          : { ...current, sessions: { ...current.sessions, [agentId]: sessionId } },
      ),
    [save],
  );
  return {
    view: state.view,
    setView: (view: Navigation["view"]) => save((current) => ({ ...current, view })),
    rememberSession,
    sessionPath: (agentId: string) =>
      state.sessions[agentId]
        ? `/agents/${agentId}/sessions/${state.sessions[agentId]}`
        : `/agents/${agentId}`,
  };
}
