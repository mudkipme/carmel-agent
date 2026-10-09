import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type AgentSnapshot, type PromptOutcome, RemoteAgent } from "@/lib/remote-agent";
import { errorMessage } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";
import {
  resolveModelRef,
  type AgentConfig,
  type ModelRef,
  type Session,
} from "@carmel-agent/shared";

const EMPTY_SNAPSHOT: AgentSnapshot = {
  messages: [],
  streamingMessage: undefined,
  pendingToolCalls: new Set(),
  isStreaming: false,
  model: undefined as unknown as Model<Api>,
  thinkingLevel: "off",
  errorMessage: undefined,
  contextPressure: undefined,
};

export function useSessionAgent(agentConfig: AgentConfig, session: Session, modelRef: ModelRef) {
  const connectSession = useHarnessStore((state) => state.connectSession);
  const refreshSession = useHarnessStore((state) => state.refreshSession);
  const updateSession = useHarnessStore((state) => state.updateSession);
  const resolvedModel = useMemo(() => resolveModelRef(modelRef), [modelRef]);
  const agentRef = useRef<RemoteAgent | null>(null);
  const sessionRef = useRef(session);
  const seedMessagesRef = useRef(session.messages);
  const modelSeedRef = useRef({ modelRefId: modelRef.id, model: resolvedModel });
  const [agent, setAgent] = useState<RemoteAgent | null>(null);

  const subscribeStore = useCallback(
    (onChange: () => void) => agent?.subscribeStore(onChange) ?? (() => {}),
    [agent],
  );
  const getSnapshot = useCallback(() => agent?.getSnapshot() ?? EMPTY_SNAPSHOT, [agent]);
  const snapshot = useSyncExternalStore(subscribeStore, getSnapshot);

  useEffect(() => {
    sessionRef.current = session;
    seedMessagesRef.current = session.messages;
  }, [session]);

  useEffect(() => {
    modelSeedRef.current = { modelRefId: modelRef.id, model: resolvedModel };
  }, [modelRef.id, resolvedModel]);

  useEffect(() => {
    let cancelled = false;
    let activeAgent: RemoteAgent | undefined;
    const createAgent = (authoritativeSession: Session) => {
      const seed = modelSeedRef.current;
      const nextAgent = new RemoteAgent({
        agentId: agentConfig.id,
        sessionId: authoritativeSession.id,
        modelRefId: seed.modelRefId,
        model: seed.model,
        thinkingLevel: clampThinkingLevel(seed.model, authoritativeSession.thinkingLevel),
        messages: authoritativeSession.messages,
        onRunComplete: async () => {
          const saved = await refreshSession(authoritativeSession.id);
          if (cancelled || activeAgent !== nextAgent) return;
          sessionRef.current = saved;
          seedMessagesRef.current = saved.messages;
          nextAgent.setMessages(saved.messages);
        },
      });
      return nextAgent;
    };

    void connectSession(session.id).then(
      (connection) => {
        if (cancelled) return;
        sessionRef.current = connection.session;
        seedMessagesRef.current = connection.session.messages;
        activeAgent = createAgent(connection.session);
        agentRef.current = activeAgent;
        setAgent(activeAgent);
        if (connection.activeRun) {
          void activeAgent.attachToRun(
            connection.activeRun.runId,
            connection.session.messages,
            connection.activeRun.eventCursor,
          );
        }
      },
      () => {
        if (cancelled) return;
        activeAgent = createAgent({ ...sessionRef.current, messages: seedMessagesRef.current });
        agentRef.current = activeAgent;
        setAgent(activeAgent);
      },
    );

    return () => {
      cancelled = true;
      if (activeAgent) seedMessagesRef.current = activeAgent.getSnapshot().messages;
      activeAgent?.detach();
      agentRef.current = null;
      setAgent(null);
    };
  }, [agentConfig.id, connectSession, refreshSession, session.id]);

  // Returns what happened to the submission so the composer can keep a message
  // the server never took. Everything that can stop a send before the prompt
  // reaches the agent has to answer with a rejection rather than nothing.
  const sendMessage = useCallback(
    async (text: string, images?: ImageContent[]): Promise<PromptOutcome> => {
      const activeAgent = agentRef.current;
      const { isStreaming, thinkingLevel } = activeAgent?.getSnapshot() ?? EMPTY_SNAPSHOT;
      if (!activeAgent)
        return { status: "rejected", error: "Not connected to this conversation yet." };
      if (isStreaming)
        return { status: "rejected", error: "This conversation already has a run in progress." };
      const currentSession = sessionRef.current;
      if (thinkingLevel !== currentSession.thinkingLevel) {
        try {
          await updateSession(currentSession.id, { thinkingLevel });
        } catch (error) {
          return { status: "rejected", error: errorMessage(error) };
        }
      }
      return activeAgent.prompt(text, images);
    },
    [updateSession],
  );

  return { agent, agentRef, resolvedModel, sendMessage, sessionRef, snapshot };
}
