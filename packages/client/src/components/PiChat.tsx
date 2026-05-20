import {
  ChatPanel,
  createExtractDocumentTool,
  createJavaScriptReplTool,
} from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import "@earendil-works/pi-web-ui/app.css";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import { ensurePiWebUiStorage } from "@/lib/pi-web-ui-memory-storage";
import { RemoteAgent } from "@/lib/remote-agent";
import {
  EDIT_USER_MESSAGE_EVENT,
  ensureRetryUserMessageRenderer,
  RETRY_USER_MESSAGE_EVENT,
} from "@/lib/retry-user-message-renderer";
import { resolveModelRef, useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef, ProviderConfig, Session } from "@carmel-agent/shared";

ensureRetryUserMessageRenderer();

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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<ChatPanel | null>(null);
  const agentRef = useRef<RemoteAgent | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingUserMessage, setEditingUserMessage] = useState<{
    message: AgentMessage;
    draft: string;
  } | null>(null);
  const refreshSession = useHarnessStore((state) => state.refreshSession);
  const updateSession = useHarnessStore((state) => state.updateSession);
  const resolvedModel = useMemo(() => resolveModelRef(modelRef), [modelRef]);
  const sessionRef = useRef(session);
  const messagesSnapshotRef = useRef(session.messages);
  const thinkingLevelSnapshotRef = useRef(session.thinkingLevel);

  const retryFromMessage = useCallback(
    async (message: AgentMessage) => {
      const agent = agentRef.current;
      const panel = panelRef.current;
      if (!agent || agent.state.isStreaming || !isRetryableUserMessage(message)) return;

      const currentMessages = [...agent.state.messages];
      const index = findMessageIndex(currentMessages, message);
      if (index < 0) return;

      const truncatedMessages = currentMessages.slice(0, index + 1);
      const previousMessages = agent.state.messages;
      messagesSnapshotRef.current = truncatedMessages;
      agent.state.messages = truncatedMessages;
      panel?.agentInterface?.requestUpdate();
      panel?.requestUpdate();

      try {
        await updateSession(sessionRef.current.id, {
          messages: truncatedMessages,
          thinkingLevel: agent.state.thinkingLevel,
        });
        await agent.continue();
      } catch (error) {
        messagesSnapshotRef.current = previousMessages;
        agent.state.messages = previousMessages;
        panel?.agentInterface?.requestUpdate();
        panel?.requestUpdate();
        console.error("Failed to retry message", error);
      }
    },
    [updateSession],
  );

  const saveUserMessage = useCallback(
    async (message: AgentMessage, content: string, submit: boolean) => {
      const agent = agentRef.current;
      const panel = panelRef.current;
      if (!agent || agent.state.isStreaming || !isRetryableUserMessage(message)) return;

      const currentMessages = [...agent.state.messages];
      const index = findMessageIndex(currentMessages, message);
      if (index < 0) return;

      const editedMessage = updateUserMessageContent(currentMessages[index], content);
      const nextMessages = submit
        ? [...currentMessages.slice(0, index), editedMessage]
        : currentMessages.map((item, itemIndex) => (itemIndex === index ? editedMessage : item));
      const previousMessages = agent.state.messages;

      messagesSnapshotRef.current = nextMessages;
      agent.state.messages = nextMessages;
      panel?.agentInterface?.requestUpdate();
      panel?.requestUpdate();

      try {
        await updateSession(sessionRef.current.id, {
          messages: nextMessages,
          thinkingLevel: agent.state.thinkingLevel,
        });
        if (submit) await agent.continue();
      } catch (error) {
        messagesSnapshotRef.current = previousMessages;
        agent.state.messages = previousMessages;
        panel?.agentInterface?.requestUpdate();
        panel?.requestUpdate();
        console.error("Failed to save message edit", error);
      }
    },
    [updateSession],
  );

  useEffect(() => {
    sessionRef.current = session;
    messagesSnapshotRef.current = session.messages;
    thinkingLevelSnapshotRef.current = session.thinkingLevel;
  }, [session]);

  const insertCommandText = useCallback((text: string) => {
    const panel = panelRef.current ?? (hostRef.current?.querySelector("pi-chat-panel") as ChatPanel | null);
    panel?.agentInterface?.setInput(text);
    requestAnimationFrame(() => {
      const textarea = panel?.querySelector("message-editor textarea") as HTMLTextAreaElement | null;
      textarea?.focus();
      textarea?.setSelectionRange(text.length, text.length);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    host.replaceChildren();
    setEditingUserMessage(null);

    const messagesForAgent = messagesSnapshotRef.current;
    const thinkingLevelForAgent = clampThinkingLevel(
      resolvedModel,
      thinkingLevelSnapshotRef.current,
    );

    let agent: RemoteAgent | undefined;
    let panel: ChatPanel | undefined;
    let unsubscribe: (() => void) | undefined;
    const handleRetry = (event: Event) => {
      const message = (event as CustomEvent<{ message?: AgentMessage }>).detail?.message;
      if (message) void retryFromMessage(message);
    };
    const handleEdit = (event: Event) => {
      const message = (event as CustomEvent<{ message?: AgentMessage }>).detail?.message;
      if (message && isRetryableUserMessage(message)) {
        setEditingUserMessage({ message, draft: getUserMessageText(message) });
      }
    };
    host.addEventListener(RETRY_USER_MESSAGE_EVENT, handleRetry);
    host.addEventListener(EDIT_USER_MESSAGE_EVENT, handleEdit);

    void ensurePiWebUiStorage().then(async () => {
      if (cancelled || !hostRef.current) return;

      agent = new RemoteAgent({
        agentId: agentConfig.id,
        sessionId: session.id,
        modelRefId: modelRef.id,
        model: resolvedModel,
        thinkingLevel: thinkingLevelForAgent,
        messages: messagesForAgent,
        onRunComplete: () => refreshSession(session.id),
      });
      agentRef.current = agent;

      unsubscribe = agent.subscribe(async (event) => {
        if (!agent) return;
        if (event.type === "message_end") {
          agent.state.messages = [...agent.state.messages];
          messagesSnapshotRef.current = agent.state.messages;
        }
        if (event.type === "agent_end") {
          const messages = [...agent.state.messages];
          agent.state.messages = messages;
          messagesSnapshotRef.current = messages;
          thinkingLevelSnapshotRef.current = agent.state.thinkingLevel;
          window.setTimeout(() => {
            panel?.agentInterface?.requestUpdate();
            panel?.requestUpdate();
          }, 0);
        }
      });

      panel = new ChatPanel();
      panelRef.current = panel;
      await panel.setAgent(agent as never, {
        onApiKeyRequired: async () => true,
        onBeforeSend: async () => {
          const nextThinkingLevel = agentRef.current?.state.thinkingLevel;
          const currentSession = sessionRef.current;
          if (!nextThinkingLevel || nextThinkingLevel === currentSession.thinkingLevel) return;
          await updateSession(currentSession.id, { thinkingLevel: nextThinkingLevel });
        },
        onModelSelect: () => setModelDialogOpen(true),
        toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
          const tools = [];
          if (agentConfig.permissions.javascript) {
            const replTool = createJavaScriptReplTool();
            replTool.runtimeProvidersFactory = runtimeProvidersFactory;
            tools.push(replTool);
          }
          if (agentConfig.permissions.documentExtract) tools.push(createExtractDocumentTool());
          return tools;
        },
      });
      hostRef.current.appendChild(panel);
    });

    return () => {
      cancelled = true;
      if (agent) {
        messagesSnapshotRef.current = agent.state.messages;
        thinkingLevelSnapshotRef.current = agent.state.thinkingLevel;
      }
      host.removeEventListener(RETRY_USER_MESSAGE_EVENT, handleRetry);
      host.removeEventListener(EDIT_USER_MESSAGE_EVENT, handleEdit);
      unsubscribe?.();
      agent?.detach();
      agentRef.current = null;
      panelRef.current = null;
      host.replaceChildren();
    };
  }, [
    agentConfig,
    modelRef,
    refreshSession,
    resolvedModel,
    retryFromMessage,
    saveUserMessage,
    session.id,
    updateSession,
    insertCommandText,
  ]);

  useEffect(() => {
    const selectedThinkingLevel = clampThinkingLevel(resolvedModel, session.thinkingLevel);
    if (selectedThinkingLevel === session.thinkingLevel) return;
    const agent = agentRef.current;
    if (agent) agent.state.thinkingLevel = selectedThinkingLevel;
    void updateSession(session.id, { thinkingLevel: selectedThinkingLevel });
  }, [resolvedModel, session.id, session.thinkingLevel, updateSession]);

  const selectModel = async (nextModelRef: ModelRef) => {
    await updateSession(session.id, { modelRefId: nextModelRef.id });
    setModelDialogOpen(false);
  };

  const saveEdit = async (submit: boolean) => {
    if (!editingUserMessage) return;
    const { message, draft } = editingUserMessage;
    setEditingUserMessage(null);
    await saveUserMessage(message, draft, submit);
  };

  return (
    <>
      <div className="relative h-full min-h-0">
        <div ref={hostRef} className="agent-chat-host h-full min-h-0" />
        <div className="absolute right-3 top-3 z-10">
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
                onSelect={() => onSelect(configuredModel)}
              >
                <CheckIcon className={selected ? "opacity-100" : "opacity-0"} />
                <div className="flex min-w-0 flex-col">
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

function isRetryableUserMessage(message: AgentMessage) {
  return message.role === "user" || message.role === "user-with-attachments";
}

function updateUserMessageContent(message: AgentMessage, content: string): AgentMessage {
  if (!isRetryableUserMessage(message)) return message;
  if (typeof message.content === "string") return { ...message, content } as AgentMessage;

  let replacedText = false;
  const nextContent = message.content.map((part) => {
    if (part.type !== "text" || replacedText) return part;
    replacedText = true;
    return { ...part, text: content };
  });

  if (!replacedText) nextContent.unshift({ type: "text", text: content });
  return { ...message, content: nextContent } as AgentMessage;
}

function getUserMessageText(message: AgentMessage) {
  if (!isRetryableUserMessage(message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.find((part) => part.type === "text")?.text ?? "";
}

function findMessageIndex(messages: AgentMessage[], target: AgentMessage) {
  const referenceIndex = messages.indexOf(target);
  if (referenceIndex >= 0) return referenceIndex;

  return messages.findIndex(
    (message) =>
      isRetryableUserMessage(message) &&
      message.role === target.role &&
      message.timestamp === target.timestamp &&
      JSON.stringify(message.content) === JSON.stringify(target.content),
  );
}
