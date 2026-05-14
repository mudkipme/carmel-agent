import {
  ChatPanel,
  createExtractDocumentTool,
  createJavaScriptReplTool,
} from "@earendil-works/pi-web-ui";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import "@earendil-works/pi-web-ui/app.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import { ensurePiWebUiStorage } from "@/lib/pi-web-ui-memory-storage";
import { RemoteAgent } from "@/lib/remote-agent";
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<ChatPanel | null>(null);
  const agentRef = useRef<RemoteAgent | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const refreshSession = useHarnessStore((state) => state.refreshSession);
  const updateSession = useHarnessStore((state) => state.updateSession);
  const [initialMessages] = useState(() => session.messages);
  const resolvedModel = useMemo(() => resolveModelRef(modelRef), [modelRef]);
  const [initialThinkingLevel] = useState(() => clampThinkingLevel(resolvedModel, session.thinkingLevel));
  const sessionRef = useRef(session);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    host.replaceChildren();

    let agent: RemoteAgent | undefined;
    let panel: ChatPanel | undefined;
    let unsubscribe: (() => void) | undefined;

    void ensurePiWebUiStorage().then(async () => {
      if (cancelled || !hostRef.current) return;

      agent = new RemoteAgent({
        agentId: agentConfig.id,
        sessionId: session.id,
        modelRefId: modelRef.id,
        model: resolvedModel,
        thinkingLevel: initialThinkingLevel,
        messages: initialMessages,
        onRunComplete: () => refreshSession(session.id),
      });
      agentRef.current = agent;

      unsubscribe = agent.subscribe(async (event) => {
        if (!agent) return;
        if (event.type === "message_end") {
          agent.state.messages = [...agent.state.messages];
        }
        if (event.type === "agent_end") {
          const messages = [...agent.state.messages];
          agent.state.messages = messages;
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
      unsubscribe?.();
      agent?.abort();
      agentRef.current = null;
      panelRef.current = null;
      host.replaceChildren();
    };
  }, [
    agentConfig,
    initialMessages,
    initialThinkingLevel,
    modelRef,
    refreshSession,
    resolvedModel,
    session.id,
    updateSession,
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

  const insertCommandText = (text: string) => {
    const panel = panelRef.current ?? (hostRef.current?.querySelector("pi-chat-panel") as ChatPanel | null);
    panel?.agentInterface?.setInput(text);
  };

  return (
    <>
      <div className="relative h-full min-h-0">
        <div ref={hostRef} className="agent-chat-host h-full min-h-0" />
        <div className="absolute right-3 top-3 z-10">
          <AgentCommandPalette agent={agentConfig} userId={activeUserId} onInsert={insertCommandText} />
        </div>
      </div>
      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Select Model</DialogTitle>
            <DialogDescription>Only models configured in settings are available here.</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-1 overflow-auto p-4">
            {modelRefs.map((configuredModel) => {
              const configuredProvider = providerConfigs.find(
                (item) => item.id === configuredModel.providerConfigId,
              );
              const selected = configuredModel.id === session.modelRefId;
              return (
                <button
                  key={configuredModel.id}
                  className="rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => void selectModel(configuredModel)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">{configuredModel.label}</span>
                    {selected ? <Badge variant="secondary">selected</Badge> : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {configuredProvider?.label ?? configuredModel.provider} · {configuredModel.modelId}
                  </p>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
