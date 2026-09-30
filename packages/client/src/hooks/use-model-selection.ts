import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { useEffect } from "react";
import { showError } from "@/lib/errors";
import type { AgentSnapshot, RemoteAgent } from "@/lib/remote-agent";
import { useHarnessStore } from "@/store/harness-store";
import { resolveModelRef, type ModelRef, type Session } from "@carmel-agent/shared";

export function useModelSelection(options: {
  agent: RemoteAgent | null;
  agentRef: React.RefObject<RemoteAgent | null>;
  modelRef: ModelRef;
  resolvedModel: ReturnType<typeof resolveModelRef>;
  session: Session;
  snapshot: AgentSnapshot;
}) {
  const { agent, agentRef, modelRef, resolvedModel, session, snapshot } = options;
  const updateSession = useHarnessStore((state) => state.updateSession);

  useEffect(() => {
    if (!agent || snapshot.isStreaming || snapshot.model === resolvedModel) return;
    agent.setModel(modelRef.id, resolvedModel, clampThinkingLevel(resolvedModel, agent.getSnapshot().thinkingLevel));
  }, [agent, modelRef.id, resolvedModel, snapshot.isStreaming, snapshot.model]);

  useEffect(() => {
    const level = clampThinkingLevel(resolvedModel, session.thinkingLevel);
    if (level === session.thinkingLevel) return;
    agentRef.current?.setThinkingLevel(level);
    void updateSession(session.id, { thinkingLevel: level });
  }, [agentRef, resolvedModel, session.id, session.thinkingLevel, updateSession]);

  const selectModel = async (nextModelRef: ModelRef) => {
    const activeAgent = agentRef.current;
    const nextModel = resolveModelRef(nextModelRef);
    const thinkingLevel = clampThinkingLevel(nextModel, activeAgent?.getSnapshot().thinkingLevel ?? session.thinkingLevel);
    activeAgent?.setModel(nextModelRef.id, nextModel, thinkingLevel);
    try {
      await updateSession(session.id, { modelRefId: nextModelRef.id, thinkingLevel });
    } catch (error) {
      showError("Unable to change model", error);
    }
  };

  const setThinkingLevel = (level: ThinkingLevel) => agentRef.current?.setThinkingLevel(level);
  return { selectModel, setThinkingLevel };
}
