import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type ImageContent } from "@earendil-works/pi-ai";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import { AgentAvatar } from "@/components/harness/shell/AgentAvatar";
import { ChatInput, type ChatInputHandle } from "@/components/chat/ChatInput";
import { ModelCommandDialog } from "@/components/chat/ModelCommandDialog";
import { errorMessage, showError } from "@/lib/errors";
import { setPendingPrompt } from "@/lib/pending-prompts";
import type { PromptOutcome } from "@/lib/remote-agent";
import { useHarnessStore } from "@/store/harness-store";
import {
  resolveModelRef,
  type AgentConfig,
  type ModelRef,
  type ProviderConfig,
} from "@carmel-agent/shared";

type NewSessionViewProps = {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
};

/* An agent's landing page. Nothing exists on the server until the first message
   is sent: submitting creates the session, then the session's own chat sends the
   message, so an abandoned composer never leaves an empty session behind. */
export function NewSessionView({ agent, modelRefs, providerConfigs }: NewSessionViewProps) {
  const navigate = useNavigate();
  const createSession = useHarnessStore((state) => state.createSession);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const creatingRef = useRef(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [selectedModelRefId, setSelectedModelRefId] = useState(agent.defaultModelRefId);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    agent.defaultThinkingLevel ?? "off",
  );
  const modelRef =
    modelRefs.find((model) => model.id === selectedModelRefId) ??
    modelRefs.find((model) => model.id === agent.defaultModelRefId) ??
    modelRefs[0];
  const model = useMemo(() => (modelRef ? resolveModelRef(modelRef) : undefined), [modelRef]);

  if (!modelRef || !model) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Add a model in Settings to start chatting.
      </div>
    );
  }

  const send = async (text: string, images?: ImageContent[]): Promise<PromptOutcome> => {
    if (creatingRef.current)
      return { status: "rejected", error: "A session is already being created." };
    creatingRef.current = true;
    try {
      const session = await createSession({
        agentId: agent.id,
        modelRefId: modelRef.id,
        thinkingLevel: clampThinkingLevel(model, thinkingLevel),
      });
      setPendingPrompt(session.id, { text, images });
      navigate(`/agents/${session.agentId}/sessions/${session.id}`);
      return { status: "accepted" };
    } catch (error) {
      creatingRef.current = false;
      showError("Unable to create session", error);
      return { status: "rejected", error: errorMessage(error) };
    }
  };

  return (
    <>
      <div className="agent-chat-host flex h-full min-h-0 flex-col overflow-y-auto bg-background px-3 pb-[calc(0.75rem+var(--safe-bottom))] text-foreground">
        {/* Margins rather than justify-center, so a composer taller than the
            viewport scrolls instead of being clipped at the top. */}
        <div className="mx-auto my-auto flex w-full max-w-[var(--line-width)] min-w-0 flex-col gap-6 py-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <AgentAvatar agent={agent} className="size-12 rounded-xl text-base" />
            <h1 className="text-xl font-medium">What can {agent.name} help with?</h1>
          </div>
          <ChatInput
            ref={chatInputRef}
            autoFocus
            textareaClassName="min-h-32"
            leadingActions={
              <AgentCommandPalette
                agent={agent}
                onInsert={(text) => chatInputRef.current?.insertText(text)}
              />
            }
            currentModel={model}
            thinkingLevel={thinkingLevel}
            isStreaming={false}
            onThinkingLevelChange={setThinkingLevel}
            onSend={send}
            onAbort={() => {}}
            onModelSelect={() => setModelDialogOpen(true)}
          />
        </div>
      </div>
      <ModelCommandDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        modelRefs={modelRefs}
        providerConfigs={providerConfigs}
        selectedModelRefId={modelRef.id}
        onSelect={(nextModelRef) => {
          setModelDialogOpen(false);
          setSelectedModelRefId(nextModelRef.id);
        }}
      />
    </>
  );
}
