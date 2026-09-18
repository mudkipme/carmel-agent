import { useEffect, useRef, useState } from "react";
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import type { ChatInputHandle } from "@/components/chat/ChatInput";
import { ChatErrorNotice } from "@/components/chat/ChatErrorNotice";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ContextPressureNotice } from "@/components/chat/ContextPressureNotice";
import { WorkspaceFileLinkAgentContext } from "@/components/chat/workspace-file-links";
import { MessageEditDialog } from "@/components/chat/MessageEditDialog";
import { ModelCommandDialog } from "@/components/chat/ModelCommandDialog";
import { useMessageMutations } from "@/hooks/use-message-mutations";
import { useModelSelection } from "@/hooks/use-model-selection";
import { useSessionAgent } from "@/hooks/use-session-agent";
import { takePendingPrompt } from "@/lib/pending-prompts";
import type { AgentConfig, ModelRef, ProviderConfig, Session } from "@carmel-agent/shared";

type PiChatProps = {
  agentConfig: AgentConfig;
  session: Session;
  modelRef: ModelRef;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  /** See `ChatMessages`: folds each run's working away behind a row of its own. */
  collapseRunDetails?: boolean;
  /** Told when a run starts or ends, for views that show run state outside the chat. */
  onStreamingChange?: (streaming: boolean) => void;
};

export function PiChat({
  agentConfig,
  session,
  modelRef,
  modelRefs,
  providerConfigs,
  collapseRunDetails,
  onStreamingChange,
}: PiChatProps) {
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const inputDraftRef = useRef("");
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const { agent, agentRef, resolvedModel, sendMessage, sessionRef, snapshot } = useSessionAgent(agentConfig, session, modelRef);
  const mutations = useMessageMutations(agentRef, sessionRef);
  const modelSelection = useModelSelection({ agent, agentRef, modelRef, resolvedModel, session, snapshot });

  /* A session made from the new-session composer arrives with its first
     message still to send. A rejection puts the text back in the composer, as
     a failed send from the composer itself would. */
  useEffect(() => {
    if (!agent) return;
    const pending = takePendingPrompt(session.id);
    if (!pending) return;
    void sendMessage(pending.text, pending.images).then((outcome) => {
      if (outcome.status !== "rejected" || inputDraftRef.current.length > 0) return;
      inputDraftRef.current = pending.text;
      chatInputRef.current?.insertText(pending.text);
    });
  }, [agent, sendMessage, session.id]);

  useEffect(() => {
    onStreamingChange?.(snapshot.isStreaming);
  }, [onStreamingChange, snapshot.isStreaming]);

  const insertCommandText = (text: string) => {
    inputDraftRef.current = text;
    chatInputRef.current?.insertText(text);
  };

  return (
    <WorkspaceFileLinkAgentContext value={agentConfig.id}>
      <div className="relative flex h-full min-h-0 flex-col">
        {snapshot.errorMessage ? (
          <ChatErrorNotice message={snapshot.errorMessage} onDismiss={() => agent?.dismissError()} />
        ) : null}
        {snapshot.contextPressure ? <ContextPressureNotice pressure={snapshot.contextPressure} /> : null}
        {/* ChatPanel is `h-full`, so the notice takes its height from a sibling
            row rather than overlaying or squeezing the chat. */}
        <div className="min-h-0 flex-1">
        {agent ? (
          <ChatPanel
            scrollResetKey={session.id}
            messages={snapshot.messages}
            streamingMessage={snapshot.streamingMessage}
            pendingToolCalls={snapshot.pendingToolCalls}
            isStreaming={snapshot.isStreaming}
            collapseRunDetails={collapseRunDetails}
            currentModel={snapshot.model}
            thinkingLevel={snapshot.thinkingLevel}
            inputRef={chatInputRef}
            inputLeadingActions={<AgentCommandPalette agent={agentConfig} onInsert={insertCommandText} />}
            initialInput={inputDraftRef.current}
            onInputDraftChange={(value) => { inputDraftRef.current = value; }}
            onThinkingLevelChange={modelSelection.setThinkingLevel}
            onSend={sendMessage}
            onAbort={() => void agent.abort()}
            onModelSelect={() => setModelDialogOpen(true)}
            onEditMessage={mutations.editMessage}
            onRetryMessage={mutations.retryFromMessage}
            onForkMessage={mutations.forkFromMessage}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading chat...</div>
        )}
        </div>
      </div>
      <ModelCommandDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        modelRefs={modelRefs}
        providerConfigs={providerConfigs}
        selectedModelRefId={session.modelRefId}
        onSelect={(nextModelRef) => {
          setModelDialogOpen(false);
          void modelSelection.selectModel(nextModelRef);
        }}
      />
      <MessageEditDialog
        value={mutations.editingMessage}
        onChange={mutations.setEditingMessage}
        onSave={async (edit, submit, removals) => {
          if (edit.kind === "assistant") await mutations.saveAssistantMessage(edit.message, edit.draft);
          else await mutations.saveUserMessage(edit.message, edit.draft, submit, removals);
        }}
      />
    </WorkspaceFileLinkAgentContext>
  );
}
