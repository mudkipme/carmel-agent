import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { RemoteAgent } from "@/lib/remote-agent";
import { findMessageIndex, getMessageText, isUserMessage, updateUserMessageContent } from "@/components/chat/chat-utils";
import { resolveModelRef, useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef, ProviderConfig, Session } from "@carmel-agent/shared";

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
  const [, setRenderVersion] = useState(0);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingUserMessage, setEditingUserMessage] = useState<{
    message: AgentMessage;
    draft: string;
  } | null>(null);
  const refreshSession = useHarnessStore((state) => state.refreshSession);
  const updateSession = useHarnessStore((state) => state.updateSession);
  const truncateSessionMessages = useHarnessStore((state) => state.truncateSessionMessages);
  const editSessionMessage = useHarnessStore((state) => state.editSessionMessage);
  const forkSession = useHarnessStore((state) => state.forkSession);
  const resolvedModel = useMemo(() => resolveModelRef(modelRef), [modelRef]);
  const sessionRef = useRef(session);
  const messagesSnapshotRef = useRef(session.messages);
  const thinkingLevelSnapshotRef = useRef(session.thinkingLevel);
  const requestRender = useCallback(() => {
    setRenderVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
    messagesSnapshotRef.current = session.messages;
    thinkingLevelSnapshotRef.current = session.thinkingLevel;
  }, [session]);

  const retryFromMessage = useCallback(
    async (message: AgentMessage) => {
      const activeAgent = agentRef.current;
      if (!activeAgent || activeAgent.state.isStreaming || !isUserMessage(message)) return;

      const currentMessages = [...activeAgent.state.messages];
      const index = findMessageIndex(currentMessages, message);
      if (index < 0) return;

      const truncatedMessages = currentMessages.slice(0, index + 1);
      const previousMessages = activeAgent.state.messages;
      messagesSnapshotRef.current = truncatedMessages;
      activeAgent.state.messages = truncatedMessages;
      requestRender();

      try {
        const saved = await truncateSessionMessages(sessionRef.current.id, index, activeAgent.state.thinkingLevel);
        messagesSnapshotRef.current = saved.messages;
        activeAgent.state.messages = saved.messages;
        requestRender();
        await activeAgent.continue();
      } catch (error) {
        messagesSnapshotRef.current = previousMessages;
        activeAgent.state.messages = previousMessages;
        requestRender();
        console.error("Failed to retry message", error);
      }
    },
    [requestRender, truncateSessionMessages],
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
      const previousMessages = activeAgent.state.messages;

      messagesSnapshotRef.current = nextMessages;
      activeAgent.state.messages = nextMessages;
      requestRender();

      try {
        const saved = await editSessionMessage(sessionRef.current.id, index, content, {
          truncate: submit,
          thinkingLevel: activeAgent.state.thinkingLevel,
        });
        messagesSnapshotRef.current = saved.messages;
        activeAgent.state.messages = saved.messages;
        requestRender();
        if (submit) await activeAgent.continue();
      } catch (error) {
        messagesSnapshotRef.current = previousMessages;
        activeAgent.state.messages = previousMessages;
        requestRender();
        console.error("Failed to save message edit", error);
      }
    },
    [editSessionMessage, requestRender],
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
    let unsubscribe: (() => void) | undefined;

    const messagesForAgent = messagesSnapshotRef.current;
    const thinkingLevelForAgent = clampThinkingLevel(resolvedModel, thinkingLevelSnapshotRef.current);

    void api.getActiveSessionRun(session.id).then(
      (activeRun) => {
        if (cancelled) return;
        activeAgent = new RemoteAgent({
          agentId: agentConfig.id,
          sessionId: session.id,
          modelRefId: modelRef.id,
          model: resolvedModel,
          thinkingLevel: thinkingLevelForAgent,
          messages: activeRun ? sessionRef.current.messages : messagesForAgent,
          onRunComplete: () => refreshSession(session.id),
        });
        agentRef.current = activeAgent;
        setAgent(activeAgent);

        unsubscribe = activeAgent.subscribe(async (event) => {
          if (!activeAgent) return;
          if (event.type === "message_end") {
            activeAgent.state.messages = [...activeAgent.state.messages];
            messagesSnapshotRef.current = activeAgent.state.messages;
          }
          if (event.type === "agent_end") {
            const messages = [...activeAgent.state.messages];
            activeAgent.state.messages = messages;
            messagesSnapshotRef.current = messages;
            thinkingLevelSnapshotRef.current = activeAgent.state.thinkingLevel;
          }
          requestRender();
        });

        requestRender();
        if (activeRun) {
          requestRender();
          void activeAgent.attachToRun(activeRun.runId, sessionRef.current.messages);
        }
      },
      () => {
        if (cancelled) return;
        activeAgent = new RemoteAgent({
          agentId: agentConfig.id,
          sessionId: session.id,
          modelRefId: modelRef.id,
          model: resolvedModel,
          thinkingLevel: thinkingLevelForAgent,
          messages: messagesForAgent,
          onRunComplete: () => refreshSession(session.id),
        });
        agentRef.current = activeAgent;
        setAgent(activeAgent);
        unsubscribe = activeAgent.subscribe(() => {
          requestRender();
        });
        requestRender();
      },
    );

    return () => {
      cancelled = true;
      if (activeAgent) {
        messagesSnapshotRef.current = activeAgent.state.messages;
        thinkingLevelSnapshotRef.current = activeAgent.state.thinkingLevel;
      }
      unsubscribe?.();
      activeAgent?.detach();
      agentRef.current = null;
      setAgent(null);
    };
  }, [agentConfig.id, modelRef.id, refreshSession, requestRender, resolvedModel, session.id]);

  useEffect(() => {
    const selectedThinkingLevel = clampThinkingLevel(resolvedModel, session.thinkingLevel);
    if (selectedThinkingLevel === session.thinkingLevel) return;
    const activeAgent = agentRef.current;
    if (activeAgent) activeAgent.state.thinkingLevel = selectedThinkingLevel;
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
    requestRender();
    void send();
  };

  const selectModel = async (nextModelRef: ModelRef) => {
    setModelDialogOpen(false);
    const activeAgent = agentRef.current;
    const nextModel = resolveModelRef(nextModelRef);
    const nextThinkingLevel = clampThinkingLevel(nextModel, activeAgent?.state.thinkingLevel ?? session.thinkingLevel);
    if (activeAgent) {
      activeAgent.setModel(nextModelRef.id, nextModel, nextThinkingLevel);
      thinkingLevelSnapshotRef.current = nextThinkingLevel;
      requestRender();
    }

    try {
      await updateSession(session.id, { modelRefId: nextModelRef.id, thinkingLevel: nextThinkingLevel });
    } catch (error) {
      console.error("Failed to update session model", error);
    }
  };

  const saveEdit = async (submit: boolean) => {
    if (!editingUserMessage) return;
    const { message, draft } = editingUserMessage;
    setEditingUserMessage(null);
    await saveUserMessage(message, draft, submit);
  };

  const setThinkingLevel = (level: ThinkingLevel) => {
    const activeAgent = agentRef.current;
    if (!activeAgent) return;
    activeAgent.state.thinkingLevel = level;
    thinkingLevelSnapshotRef.current = level;
    requestRender();
  };

  const insertCommandText = (text: string) => {
    setInput(text);
  };

  return (
    <>
      <div className="relative h-full min-h-0">
        {agent ? (
          <ChatPanel
            messages={agent.state.messages}
            streamingMessage={agent.state.streamingMessage}
            pendingToolCalls={agent.state.pendingToolCalls}
            isStreaming={agent.state.isStreaming}
            currentModel={agent.state.model}
            thinkingLevel={agent.state.thinkingLevel}
            input={input}
            onInputChange={setInput}
            onThinkingLevelChange={setThinkingLevel}
            onSend={sendMessage}
            onAbort={() => agent.abort()}
            onModelSelect={() => setModelDialogOpen(true)}
            onEditMessage={(message) => setEditingUserMessage({ message, draft: getMessageText(message) })}
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
        open={editingUserMessage !== null}
        onOpenChange={(open) => {
          if (!open) setEditingUserMessage(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Message</DialogTitle>
            <DialogDescription>
              Save updates the message only. Submit saves it and reruns from this point.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-36 resize-y"
            value={editingUserMessage?.draft ?? ""}
            onChange={(event) =>
              setEditingUserMessage((current) =>
                current ? { ...current, draft: event.target.value } : current,
              )
            }
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingUserMessage(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={!editingUserMessage?.draft.trim()}
              onClick={() => void saveEdit(false)}
            >
              Save
            </Button>
            <Button disabled={!editingUserMessage?.draft.trim()} onClick={() => void saveEdit(true)}>
              Submit
            </Button>
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
