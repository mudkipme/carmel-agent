import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import { type ChatInputHandle } from "@/components/chat/ChatInput";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { MessageEditDialog, type MessageEditState } from "@/components/chat/MessageEditDialog";
import { ModelCommandDialog } from "@/components/chat/ModelCommandDialog";
import { type AgentSnapshot, RemoteAgent } from "@/lib/remote-agent";
import {
  findMessageIndex,
  getEditableUserImages,
  getMessageText,
  isEditableAssistantMessage,
  isUserMessage,
  updateAssistantMessageContent,
  updateUserMessageContent,
} from "@/components/chat/chat-utils";
import { resolveModelRef, useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef, ProviderConfig, Session, UserMessageEditOptions } from "@carmel-agent/shared";

// Stable snapshot used while no agent exists yet (useSyncExternalStore requires a
// referentially stable value). Its `model` is never read — the chat UI only renders
// once `agent` is set, at which point the agent supplies a real snapshot.
const EMPTY_SNAPSHOT: AgentSnapshot = {
  messages: [],
  streamingMessage: undefined,
  pendingToolCalls: new Set(),
  isStreaming: false,
  model: undefined as unknown as Model<Api>,
  thinkingLevel: "off",
  errorMessage: undefined,
};

type PiChatProps = {
  agentConfig: AgentConfig;
  session: Session;
  modelRef: ModelRef;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
};

export function PiChat({
  agentConfig,
  session,
  modelRef,
  modelRefs,
  providerConfigs,
}: PiChatProps) {
  const navigate = useNavigate();
  const agentRef = useRef<RemoteAgent | null>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  // Draft text mirror kept in a ref (writes don't re-render): the input's local
  // state dies when the agent is recreated (e.g. model switch unmounts ChatPanel),
  // so ChatInput is re-seeded from here on mount.
  const inputDraftRef = useRef("");
  const [agent, setAgent] = useState<RemoteAgent | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingMessage, setEditingMessage] = useState<MessageEditState | null>(null);
  const connectSession = useHarnessStore((state) => state.connectSession);
  const refreshSession = useHarnessStore((state) => state.refreshSession);
  const updateSession = useHarnessStore((state) => state.updateSession);
  const truncateSessionMessages = useHarnessStore((state) => state.truncateSessionMessages);
  const editSessionMessage = useHarnessStore((state) => state.editSessionMessage);
  const forkSession = useHarnessStore((state) => state.forkSession);
  const resolvedModel = useMemo(() => resolveModelRef(modelRef), [modelRef]);
  const sessionRef = useRef(session);
  // Seeds carried into a freshly recreated agent. Only read at agent creation;
  // kept current at the session boundary and on teardown.
  const seedMessagesRef = useRef(session.messages);
  const seedThinkingRef = useRef(session.thinkingLevel);
  // Read at agent creation instead of depending on the model in the creation
  // effect: model changes must not recreate the agent (that unmounts the chat
  // and drops any attached run) — they're applied in place via setModel below.
  const modelSeedRef = useRef({ modelRefId: modelRef.id, model: resolvedModel });

  // Render directly from the agent's store rather than a manual render counter:
  // every observable change emits, React reads getSnapshot, and re-renders if the
  // snapshot identity changed.
  const subscribeStore = useCallback(
    (onChange: () => void) => agent?.subscribeStore(onChange) ?? (() => {}),
    [agent],
  );
  const getSnapshot = useCallback(() => agent?.getSnapshot() ?? EMPTY_SNAPSHOT, [agent]);
  const snapshot = useSyncExternalStore(subscribeStore, getSnapshot);

  useEffect(() => {
    sessionRef.current = session;
    seedMessagesRef.current = session.messages;
    seedThinkingRef.current = session.thinkingLevel;
  }, [session]);

  useEffect(() => {
    modelSeedRef.current = { modelRefId: modelRef.id, model: resolvedModel };
  }, [modelRef.id, resolvedModel]);

  // Optimistically swap the agent's messages, persist via `commit`, then either
  // apply the server's authoritative result or roll back on failure. Shared by
  // retry/edit so the snapshot + rollback bookkeeping lives in exactly one place.
  const applyOptimisticMessages = useCallback(
    async (
      activeAgent: RemoteAgent,
      nextMessages: AgentMessage[],
      commit: () => Promise<Session>,
      options?: { afterCommit?: () => Promise<void>; errorMessage?: string },
    ) => {
      const previousMessages = activeAgent.state.messages;
      activeAgent.setMessages(nextMessages);

      try {
        const saved = await commit();
        sessionRef.current = saved;
        activeAgent.setMessages(saved.messages);
        await options?.afterCommit?.();
      } catch (error) {
        activeAgent.setMessages(previousMessages);
        console.error(options?.errorMessage ?? "Failed to update messages", error);
      }
    },
    [],
  );

  const retryFromMessage = useCallback(
    async (message: AgentMessage) => {
      const activeAgent = agentRef.current;
      if (!activeAgent || activeAgent.state.isStreaming || !isUserMessage(message)) return;

      const currentMessages = [...activeAgent.state.messages];
      const index = findMessageIndex(currentMessages, message);
      if (index < 0) return;
      const entryId = sessionRef.current.messageEntryIds[index];
      if (!entryId) return;

      await applyOptimisticMessages(
        activeAgent,
        currentMessages.slice(0, index + 1),
        () => truncateSessionMessages(sessionRef.current.id, entryId, activeAgent.state.thinkingLevel),
        { afterCommit: () => activeAgent.continue(), errorMessage: "Failed to retry message" },
      );
    },
    [applyOptimisticMessages, truncateSessionMessages],
  );

  const saveUserMessage = useCallback(
    async (message: AgentMessage, content: string, submit: boolean, removals?: UserMessageEditOptions) => {
      const activeAgent = agentRef.current;
      if (!activeAgent || activeAgent.state.isStreaming || !isUserMessage(message)) return;

      const currentMessages = [...activeAgent.state.messages];
      const index = findMessageIndex(currentMessages, message);
      if (index < 0) return;
      const entryId = sessionRef.current.messageEntryIds[index];
      if (!entryId) return;

      const editedMessage = updateUserMessageContent(currentMessages[index], content, removals);
      const nextMessages = submit
        ? [...currentMessages.slice(0, index), editedMessage]
        : currentMessages.map((item, itemIndex) => (itemIndex === index ? editedMessage : item));

      await applyOptimisticMessages(
        activeAgent,
        nextMessages,
        () =>
          editSessionMessage(sessionRef.current.id, entryId, content, {
            truncate: submit,
            thinkingLevel: activeAgent.state.thinkingLevel,
            ...removals,
          }),
        {
          afterCommit: submit ? () => activeAgent.continue() : undefined,
          errorMessage: "Failed to save message edit",
        },
      );
    },
    [applyOptimisticMessages, editSessionMessage],
  );

  const saveAssistantMessage = useCallback(
    async (message: AgentMessage, content: string) => {
      const activeAgent = agentRef.current;
      if (!activeAgent || activeAgent.state.isStreaming || !isEditableAssistantMessage(message)) return;

      const currentMessages = [...activeAgent.state.messages];
      const index = findMessageIndex(currentMessages, message);
      if (index < 0) return;
      const entryId = sessionRef.current.messageEntryIds[index];
      if (!entryId) return;

      // Editing an assistant message never truncates or reruns; it only rewrites
      // the stored message so it carries forward into the next turn.
      const editedMessage = updateAssistantMessageContent(currentMessages[index], content);
      const nextMessages = currentMessages.map((item, itemIndex) => (itemIndex === index ? editedMessage : item));

      await applyOptimisticMessages(
        activeAgent,
        nextMessages,
        () => editSessionMessage(sessionRef.current.id, entryId, content, { truncate: false }),
        { errorMessage: "Failed to save assistant message edit" },
      );
    },
    [applyOptimisticMessages, editSessionMessage],
  );

  const forkFromMessage = useCallback(
    async (message: AgentMessage) => {
      const activeAgent = agentRef.current;
      if (!activeAgent || activeAgent.state.isStreaming) return;

      const index = findMessageIndex([...activeAgent.state.messages], message);
      if (index < 0) return;
      const entryId = sessionRef.current.messageEntryIds[index];
      if (!entryId) return;

      try {
        const fork = await forkSession(sessionRef.current.id, entryId);
        navigate(`/agents/${fork.agentId}/sessions/${fork.id}`);
      } catch (error) {
        console.error("Failed to fork session", error);
      }
    },
    [forkSession, navigate],
  );

  useEffect(() => {
    let cancelled = false;
    let activeAgent: RemoteAgent | undefined;

    const createAgent = (authoritativeSession: Session) => {
      const { modelRefId, model } = modelSeedRef.current;
      const nextAgent = new RemoteAgent({
        agentId: agentConfig.id,
        sessionId: authoritativeSession.id,
        modelRefId,
        model,
        thinkingLevel: clampThinkingLevel(model, authoritativeSession.thinkingLevel),
        messages: authoritativeSession.messages,
        onRunComplete: async () => {
          const saved = await refreshSession(authoritativeSession.id);
          if (cancelled || activeAgent !== nextAgent) return;
          sessionRef.current = saved;
          seedMessagesRef.current = saved.messages;
          seedThinkingRef.current = saved.thinkingLevel;
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
        seedThinkingRef.current = connection.session.thinkingLevel;
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
      if (activeAgent) {
        // Carry the live messages/thinking level into the next agent instance.
        seedMessagesRef.current = activeAgent.state.messages;
        seedThinkingRef.current = activeAgent.state.thinkingLevel;
      }
      activeAgent?.detach();
      agentRef.current = null;
      setAgent(null);
    };
  }, [agentConfig.id, connectSession, refreshSession, session.id]);

  // Apply model changes to the live agent in place. setModel no-ops while a
  // response is streaming, so this also re-runs when streaming ends to pick up
  // a model switched mid-stream.
  useEffect(() => {
    if (!agent || snapshot.isStreaming) return;
    if (snapshot.model === resolvedModel) return;
    agent.setModel(modelRef.id, resolvedModel, clampThinkingLevel(resolvedModel, agent.state.thinkingLevel));
  }, [agent, modelRef.id, resolvedModel, snapshot.isStreaming, snapshot.model]);

  useEffect(() => {
    const selectedThinkingLevel = clampThinkingLevel(resolvedModel, session.thinkingLevel);
    if (selectedThinkingLevel === session.thinkingLevel) return;
    agentRef.current?.setThinkingLevel(selectedThinkingLevel);
    void updateSession(session.id, { thinkingLevel: selectedThinkingLevel });
  }, [resolvedModel, session.id, session.thinkingLevel, updateSession]);

  const sendMessage = useCallback(
    (text: string, images?: ImageContent[]) => {
      const activeAgent = agentRef.current;
      if (!activeAgent || activeAgent.state.isStreaming) return;
      const nextThinkingLevel = activeAgent.state.thinkingLevel;
      const currentSession = sessionRef.current;
      const send = async () => {
        if (nextThinkingLevel !== currentSession.thinkingLevel) {
          await updateSession(currentSession.id, { thinkingLevel: nextThinkingLevel });
        }
        await activeAgent.prompt(text, images);
      };
      void send();
    },
    [updateSession],
  );

  const selectModel = async (nextModelRef: ModelRef) => {
    setModelDialogOpen(false);
    const activeAgent = agentRef.current;
    const nextModel = resolveModelRef(nextModelRef);
    const nextThinkingLevel = clampThinkingLevel(nextModel, activeAgent?.state.thinkingLevel ?? session.thinkingLevel);
    activeAgent?.setModel(nextModelRef.id, nextModel, nextThinkingLevel);

    try {
      await updateSession(session.id, { modelRefId: nextModelRef.id, thinkingLevel: nextThinkingLevel });
    } catch (error) {
      console.error("Failed to update session model", error);
    }
  };

  const setThinkingLevel = (level: ThinkingLevel) => {
    const activeAgent = agentRef.current;
    if (!activeAgent) return;
    activeAgent.setThinkingLevel(level);
    seedThinkingRef.current = level;
  };

  const insertCommandText = (text: string) => {
    // Also mirror directly in case the input is unmounted (agent recreating).
    inputDraftRef.current = text;
    chatInputRef.current?.insertText(text);
  };

  const editMessage = useCallback((message: AgentMessage) => {
    const isAssistant = message.role === "assistant";
    setEditingMessage({
      message,
      draft: getMessageText(message),
      kind: isAssistant ? "assistant" : "user",
      images: isAssistant ? [] : getEditableUserImages(message),
      removedKeys: new Set(),
    });
  }, []);


  return (
    <>
      <div className="relative h-full min-h-0">
        {agent ? (
          <ChatPanel
            scrollResetKey={session.id}
            messages={snapshot.messages}
            streamingMessage={snapshot.streamingMessage}
            pendingToolCalls={snapshot.pendingToolCalls}
            isStreaming={snapshot.isStreaming}
            currentModel={snapshot.model}
            thinkingLevel={snapshot.thinkingLevel}
            inputRef={chatInputRef}
            initialInput={inputDraftRef.current}
            onInputDraftChange={(value) => {
              inputDraftRef.current = value;
            }}
            onThinkingLevelChange={setThinkingLevel}
            onSend={sendMessage}
            onAbort={() => void agent.abort()}
            onModelSelect={() => setModelDialogOpen(true)}
            onEditMessage={editMessage}
            onRetryMessage={retryFromMessage}
            onForkMessage={forkFromMessage}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            Loading chat...
          </div>
        )}
        <div className="absolute right-3 top-3">
          <AgentCommandPalette agent={agentConfig} onInsert={insertCommandText} />
        </div>
      </div>
      <ModelCommandDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        modelRefs={modelRefs}
        providerConfigs={providerConfigs}
        selectedModelRefId={session.modelRefId}
        onSelect={(nextModelRef) => void selectModel(nextModelRef)}
      />
      <MessageEditDialog
        value={editingMessage}
        onChange={setEditingMessage}
        onSave={async (edit, submit, removals) => {
          if (edit.kind === "assistant") {
            await saveAssistantMessage(edit.message, edit.draft);
          } else {
            await saveUserMessage(edit.message, edit.draft, submit, removals);
          }
        }}
      />
    </>
  );
}
