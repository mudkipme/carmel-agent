import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type ImageContent } from "@earendil-works/pi-ai";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { AgentRequestArea } from "@/components/chat/AgentRequestCard";
import { useNavigate } from "react-router-dom";
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import { ChatWelcome } from "@/components/chat/ChatWelcome";
import { ChatInput, type ChatInputHandle } from "@/components/chat/ChatInput";
import { ModelCommandDialog } from "@/components/chat/ModelCommandDialog";
import { errorMessage, showError } from "@/lib/errors";
import { setPendingPrompt } from "@/lib/pending-prompts";
import type { PromptOutcome } from "@/lib/remote-agent";
import { useHarnessStore } from "@/store/harness-store";
import { draftStorageKey } from "@/lib/session-draft";
import { cn } from "@/lib/utils";
import {
  resolveModelRef,
  type AgentConfig,
  type ModelRef,
  type ProviderConfig,
  type MessageReference,
} from "@carmel-agent/shared";

type NewSessionViewProps = {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  onOpenSession?: (sessionId: string) => void;
  browserRequest?: ReactNode;
  inline?: boolean;
};

/* An agent's landing page. Nothing exists on the server until the first message
   is sent: submitting creates the session, then the session's own chat sends the
   message, so an abandoned composer never leaves an empty session behind. */
export function NewSessionView({
  agent,
  modelRefs,
  providerConfigs,
  onOpenSession,
  browserRequest,
  inline = false,
}: NewSessionViewProps) {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const createSession = useHarnessStore((state) => state.createSession);
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const draftKey = activeUserId
    ? draftStorageKey(activeUserId, "new-session", agent.id)
    : undefined;
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
      <div
        className={cn(
          "p-8 text-sm text-muted-foreground",
          !inline && "flex h-full items-center justify-center",
        )}
      >
        <Trans>Add a model in Settings to start chatting.</Trans>
      </div>
    );
  }

  const send = async (
    text: string,
    images?: ImageContent[],
    references?: MessageReference[],
  ): Promise<PromptOutcome> => {
    if (creatingRef.current)
      return { status: "rejected", error: i18n._("A session is already being created.") };
    creatingRef.current = true;
    try {
      const session = await createSession({
        agentId: agent.id,
        modelRefId: modelRef.id,
        thinkingLevel: clampThinkingLevel(model, thinkingLevel),
      });
      setPendingPrompt(session.id, { text, images, references });
      if (onOpenSession) onOpenSession(session.id);
      else navigate(`/agents/${session.agentId}/sessions/${session.id}`);
      return { status: "accepted" };
    } catch (error) {
      creatingRef.current = false;
      showError(i18n._("Unable to create session"), error);
      return { status: "rejected", error: errorMessage(error) };
    }
  };

  return (
    <>
      <div
        className={cn(
          "agent-chat-host",
          !inline &&
            "flex h-full min-h-0 flex-col overflow-y-auto bg-background px-3 pb-[calc(0.75rem+var(--safe-bottom))] text-foreground",
        )}
      >
        {/* Margins rather than justify-center, so a composer taller than the
            viewport scrolls instead of being clipped at the top. */}
        <div
          className={cn(
            "flex min-w-0 flex-col gap-5",
            !inline && "mx-auto my-auto w-full max-w-[var(--line-width)] px-1 py-6 sm:px-5",
          )}
        >
          {!inline ? <ChatWelcome agent={agent} /> : null}
          {browserRequest ? <AgentRequestArea>{browserRequest}</AgentRequestArea> : null}
          <ChatInput
            draftKey={draftKey}
            agentId={agent.id}
            canReadFiles={agent.permissions.read}
            canWriteFiles={agent.permissions.write}
            ref={chatInputRef}
            autoFocus={!inline}
            textareaClassName={inline ? undefined : "min-h-20"}
            placeholder={inline ? i18n._("New session in {name}", { name: agent.name }) : undefined}
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
