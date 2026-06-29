import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  fullscreenDialogContentClass,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { type AgentSnapshot, RemoteAgent } from "@/lib/remote-agent";
import {
  findMessageIndex,
  getMessageText,
  isEditableAssistantMessage,
  isUserMessage,
  updateAssistantMessageContent,
  updateUserMessageContent,
} from "@/components/chat/chat-utils";
import { resolveModelRef, useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef, ProviderConfig, Session } from "@carmel-agent/shared";

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
  const [agent, setAgent] = useState<RemoteAgent | null>(null);
  const [input, setInput] = useState("");
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingMessage, setEditingMessage] = useState<{
    message: AgentMessage;
    draft: string;
    kind: "user" | "assistant";
  } | null>(null);
  const refreshSession = useHarnessStore((state) => state.refreshSession);
  const updateSession = useHarnessStore((state) => state.updateSession);
  const truncateSessionMessages = useHarnessStore((state) => state.truncateSessionMessages);
  const editSessionMessage = useHarnessStore((state) => state.editSessionMessage);
  const forkSession = useHarnessStore((state) => state.forkSession);
  const resolvedModel = useMemo(() => resolveModelRef(modelRef), [modelRef]);
  const sessionRef = useRef(session);
  // Seeds carried into a freshly recreated agent (e.g. on model switch). Only read
  // at agent creation; kept current at the session boundary and on teardown.
  const seedMessagesRef = useRef(session.messages);
  const seedThinkingRef = useRef(session.thinkingLevel);

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

      await applyOptimisticMessages(
        activeAgent,
        currentMessages.slice(0, index + 1),
        () => truncateSessionMessages(sessionRef.current.id, index, activeAgent.state.thinkingLevel),
        { afterCommit: () => activeAgent.continue(), errorMessage: "Failed to retry message" },
      );
    },
    [applyOptimisticMessages, truncateSessionMessages],
  );

  const saveUserMessage = useCallback(
    async (message: AgentMessage, content: string, submit: boolean) => {
      const activeAgent = agentRef.current;
      if (!activeAgent || activeAgent.state.isStreaming || !isUserMessage(message)) return;

      const currentMessages = [...activeAgent.state.messages];
      const index = findMessageIndex(currentMessages, message);
      if (index < 0) return;

      const editedMessage = updateUserMessageContent(currentMessages[index], content);
      const nextMessages = submit
        ? [...currentMessages.slice(0, index), editedMessage]
        : currentMessages.map((item, itemIndex) => (itemIndex === index ? editedMessage : item));

      await applyOptimisticMessages(
        activeAgent,
        nextMessages,
        () =>
          editSessionMessage(sessionRef.current.id, index, content, {
            truncate: submit,
            thinkingLevel: activeAgent.state.thinkingLevel,
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

      // Editing an assistant message never truncates or reruns; it only rewrites
      // the stored message so it carries forward into the next turn.
      const editedMessage = updateAssistantMessageContent(currentMessages[index], content);
      const nextMessages = currentMessages.map((item, itemIndex) => (itemIndex === index ? editedMessage : item));

      await applyOptimisticMessages(
        activeAgent,
        nextMessages,
        () => editSessionMessage(sessionRef.current.id, index, content, { truncate: false }),
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

      try {
        const fork = await forkSession(sessionRef.current.id, index);
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

    const messagesForAgent = seedMessagesRef.current;
    const thinkingLevelForAgent = clampThinkingLevel(resolvedModel, seedThinkingRef.current);

    const createAgent = (messages: AgentMessage[]) =>
      new RemoteAgent({
        agentId: agentConfig.id,
        sessionId: session.id,
        modelRefId: modelRef.id,
        model: resolvedModel,
        thinkingLevel: thinkingLevelForAgent,
        messages,
        onRunComplete: () => refreshSession(session.id),
      });

    void api.getActiveSessionRun(session.id).then(
      (activeRun) => {
        if (cancelled) return;
        activeAgent = createAgent(activeRun ? sessionRef.current.messages : messagesForAgent);
        agentRef.current = activeAgent;
        setAgent(activeAgent);
        if (activeRun) void activeAgent.attachToRun(activeRun.runId, sessionRef.current.messages);
      },
      () => {
        if (cancelled) return;
        activeAgent = createAgent(messagesForAgent);
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
  }, [agentConfig.id, modelRef.id, refreshSession, resolvedModel, session.id]);

  useEffect(() => {
    const selectedThinkingLevel = clampThinkingLevel(resolvedModel, session.thinkingLevel);
    if (selectedThinkingLevel === session.thinkingLevel) return;
    agentRef.current?.setThinkingLevel(selectedThinkingLevel);
    void updateSession(session.id, { thinkingLevel: selectedThinkingLevel });
  }, [resolvedModel, session.id, session.thinkingLevel, updateSession]);

  const sendMessage = (text: string, images?: ImageContent[]) => {
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
  };

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

  const saveEdit = async (submit: boolean) => {
    if (!editingMessage) return;
    const { message, draft, kind } = editingMessage;
    setEditingMessage(null);
    if (kind === "assistant") {
      await saveAssistantMessage(message, draft);
    } else {
      await saveUserMessage(message, draft, submit);
    }
  };

  const setThinkingLevel = (level: ThinkingLevel) => {
    const activeAgent = agentRef.current;
    if (!activeAgent) return;
    activeAgent.setThinkingLevel(level);
    seedThinkingRef.current = level;
  };

  const insertCommandText = (text: string) => {
    setInput(text);
  };

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
            input={input}
            onInputChange={setInput}
            onThinkingLevelChange={setThinkingLevel}
            onSend={sendMessage}
            onAbort={() => agent.abort()}
            onModelSelect={() => setModelDialogOpen(true)}
            onEditMessage={(message) =>
              setEditingMessage({
                message,
                draft: getMessageText(message),
                kind: message.role === "assistant" ? "assistant" : "user",
              })
            }
            onRetryMessage={(message) => void retryFromMessage(message)}
            onForkMessage={(message) => void forkFromMessage(message)}
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
      <Dialog
        open={editingMessage !== null}
        onOpenChange={(open) => {
          if (!open) setEditingMessage(null);
        }}
      >
        <DialogContent className={fullscreenDialogContentClass("sm:max-w-4xl")}>
          <DialogHeader className="shrink-0 pr-8 text-left">
            <DialogTitle className="text-base sm:text-lg">
              {editingMessage?.kind === "assistant" ? "Edit Assistant Message" : "Edit Message"}
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              {editingMessage?.kind === "assistant"
                ? "Rewrites this assistant message in place. It won't rerun anything and only affects the next turn."
                : "Save updates the message only. Submit saves it and reruns from this point."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            className="min-h-0 flex-1 resize-none overflow-y-auto text-base sm:max-h-[60vh] sm:min-h-36 sm:flex-none sm:resize-y"
            value={editingMessage?.draft ?? ""}
            onChange={(event) =>
              setEditingMessage((current) =>
                current ? { ...current, draft: event.target.value } : current,
              )
            }
            onKeyDown={(event) => {
              // Plain Enter inserts a newline (multi-line edit); only the keyboard
              // shortcut commits. It triggers the dialog's primary action: rerun
              // (Submit) for user messages, in-place Save for assistant messages.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && editingMessage?.draft.trim()) {
                event.preventDefault();
                void saveEdit(editingMessage.kind === "user");
              }
            }}
          />
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setEditingMessage(null)}>
              Cancel
            </Button>
            <Button
              variant={editingMessage?.kind === "assistant" ? undefined : "outline"}
              disabled={!editingMessage?.draft.trim()}
              onClick={() => void saveEdit(false)}
            >
              Save
            </Button>
            {editingMessage?.kind === "assistant" ? null : (
              <Button disabled={!editingMessage?.draft.trim()} onClick={() => void saveEdit(true)}>
                Submit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ModelCommandDialog({
  open,
  onOpenChange,
  modelRefs,
  providerConfigs,
  selectedModelRefId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  selectedModelRefId: string;
  onSelect: (modelRef: ModelRef) => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Select Model"
      description="Select one of the models configured in settings."
      className="w-[calc(100vw-1.5rem)] max-w-md sm:max-w-lg"
    >
      <CommandInput placeholder="Search configured models..." />
      <CommandList>
        <CommandEmpty>No configured models found.</CommandEmpty>
        <CommandGroup heading="Models">
          {modelRefs.map((configuredModel) => {
            const configuredProvider = providerConfigs.find((item) => item.id === configuredModel.providerConfigId);
            const selected = configuredModel.id === selectedModelRefId;
            const providerLabel = configuredProvider?.label ?? configuredModel.provider;
            return (
              <CommandItem
                key={configuredModel.id}
                value={`${configuredModel.label} ${providerLabel} ${configuredModel.modelId}`}
                className="min-w-0"
                onSelect={() => onSelect(configuredModel)}
              >
                <CheckIcon className={selected ? "opacity-100" : "opacity-0"} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{configuredModel.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {providerLabel} · {configuredModel.modelId}
                  </span>
                </div>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
