import { useRef, useState } from "react";
import { AgentCommandPalette } from "@/components/harness/AgentCommandPalette";
import type { ChatInputHandle } from "@/components/chat/ChatInput";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { MessageEditDialog } from "@/components/chat/MessageEditDialog";
import { ModelCommandDialog } from "@/components/chat/ModelCommandDialog";
import { useMessageMutations } from "@/hooks/use-message-mutations";
import { useModelSelection } from "@/hooks/use-model-selection";
import { useSessionAgent } from "@/hooks/use-session-agent";
import type { AgentConfig, ModelRef, ProviderConfig, Session } from "@carmel-agent/shared";

type PiChatProps = {
  agentConfig: AgentConfig;
  session: Session;
  modelRef: ModelRef;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
};

export function PiChat({ agentConfig, session, modelRef, modelRefs, providerConfigs }: PiChatProps) {
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const inputDraftRef = useRef("");
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const { agent, agentRef, resolvedModel, sendMessage, sessionRef, snapshot } = useSessionAgent(agentConfig, session, modelRef);
  const mutations = useMessageMutations(agentRef, sessionRef);
  const modelSelection = useModelSelection({ agent, agentRef, modelRef, resolvedModel, session, snapshot });

  const insertCommandText = (text: string) => {
    inputDraftRef.current = text;
    chatInputRef.current?.insertText(text);
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
            inputRef={chatInputRef}
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
    </>
  );
}
