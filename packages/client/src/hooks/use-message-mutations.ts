import { useLingui } from "@lingui/react";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  findMessageIndex,
  getEditableUserImages,
  getMessageText,
} from "@/components/chat/chat-utils";
import type { MessageEditState } from "@/components/chat/MessageEditDialog";
import type { RemoteAgent } from "@/lib/remote-agent";
import { showError } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";
import {
  isEditableAssistantMessage,
  isUserMessage,
  updateAssistantMessageContent,
  updateUserMessageContent,
  type Session,
  type UserMessageEditOptions,
} from "@carmel-agent/shared";

export function useMessageMutations(
  agentRef: React.RefObject<RemoteAgent | null>,
  sessionRef: React.RefObject<Session>,
) {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const truncateSessionMessages = useHarnessStore((state) => state.truncateSessionMessages);
  const editSessionMessage = useHarnessStore((state) => state.editSessionMessage);
  const forkSession = useHarnessStore((state) => state.forkSession);
  const [editingMessage, setEditingMessage] = useState<MessageEditState | null>(null);

  const applyOptimisticMessages = useCallback(
    async (
      activeAgent: RemoteAgent,
      nextMessages: AgentMessage[],
      commit: () => Promise<Session>,
      options?: { afterCommit?: () => Promise<void>; errorMessage?: string },
    ): Promise<boolean> => {
      const previousMessages = activeAgent.getSnapshot().messages;
      const previousEntryIds = activeAgent.getMessageEntryIds();
      activeAgent.setMessages(nextMessages);
      let saved: Session;
      try {
        saved = await commit();
      } catch (error) {
        // The commit failed, so nothing was changed on the server: restore both
        // the messages and the entry ids that address them.
        activeAgent.setMessages(previousMessages, previousEntryIds);
        showError(options?.errorMessage ?? i18n._("Unable to update messages"), error);
        return false;
      }
      sessionRef.current = saved;
      activeAgent.setMessages(saved.messages, saved.messageEntryIds);
      // Committed already: a failure while continuing must not roll the edit back.
      try {
        await options?.afterCommit?.();
      } catch (error) {
        showError(i18n._("Unable to continue the conversation"), error);
      }
      return true;
    },
    [sessionRef, i18n],
  );

  const retryFromMessage = useCallback(
    async (message: AgentMessage) => {
      const activeAgent = agentRef.current;
      const snapshot = activeAgent?.getSnapshot();
      if (!activeAgent || !snapshot || snapshot.isStreaming || !isUserMessage(message))
        return false;
      const currentMessages = [...snapshot.messages];
      const index = findMessageIndex(currentMessages, message);
      const entryId = index >= 0 ? sessionRef.current.messageEntryIds[index] : undefined;
      if (!entryId) return;
      await applyOptimisticMessages(
        activeAgent,
        currentMessages.slice(0, index + 1),
        () =>
          truncateSessionMessages(
            sessionRef.current.id,
            entryId,
            activeAgent.getSnapshot().thinkingLevel,
          ),
        // The resend's own outcome reaches the user through the chat's error
        // notice, which reports rejected submissions as well as failed runs.
        {
          afterCommit: async () => void (await activeAgent.continue()),
          errorMessage: i18n._("Unable to retry message"),
        },
      );
    },
    [agentRef, applyOptimisticMessages, sessionRef, truncateSessionMessages, i18n],
  );

  const saveUserMessage = useCallback(
    async (
      message: AgentMessage,
      content: string,
      submit: boolean,
      removals?: UserMessageEditOptions,
    ) => {
      const activeAgent = agentRef.current;
      const snapshot = activeAgent?.getSnapshot();
      if (!activeAgent || !snapshot || snapshot.isStreaming || !isUserMessage(message))
        return false;
      const currentMessages = [...snapshot.messages];
      const index = findMessageIndex(currentMessages, message);
      const entryId = index >= 0 ? sessionRef.current.messageEntryIds[index] : undefined;
      if (!entryId) return false;
      const editedMessage = updateUserMessageContent(currentMessages[index]!, content, removals);
      const nextMessages = submit
        ? [...currentMessages.slice(0, index), editedMessage]
        : currentMessages.map((item, itemIndex) => (itemIndex === index ? editedMessage : item));
      return applyOptimisticMessages(
        activeAgent,
        nextMessages,
        () =>
          editSessionMessage(sessionRef.current.id, entryId, content, {
            truncate: submit,
            thinkingLevel: activeAgent.getSnapshot().thinkingLevel,
            ...removals,
          }),
        {
          afterCommit: submit ? async () => void (await activeAgent.continue()) : undefined,
          errorMessage: i18n._("Unable to save message"),
        },
      );
    },
    [agentRef, applyOptimisticMessages, editSessionMessage, sessionRef, i18n],
  );

  const saveAssistantMessage = useCallback(
    async (message: AgentMessage, content: string) => {
      const activeAgent = agentRef.current;
      const snapshot = activeAgent?.getSnapshot();
      if (!activeAgent || !snapshot || snapshot.isStreaming || !isEditableAssistantMessage(message))
        return false;
      const currentMessages = [...snapshot.messages];
      const index = findMessageIndex(currentMessages, message);
      const entryId = index >= 0 ? sessionRef.current.messageEntryIds[index] : undefined;
      if (!entryId) return false;
      const editedMessage = updateAssistantMessageContent(currentMessages[index]!, content);
      return applyOptimisticMessages(
        activeAgent,
        currentMessages.map((item, itemIndex) => (itemIndex === index ? editedMessage : item)),
        () => editSessionMessage(sessionRef.current.id, entryId, content, { truncate: false }),
        { errorMessage: i18n._("Unable to save assistant message") },
      );
    },
    [agentRef, applyOptimisticMessages, editSessionMessage, sessionRef, i18n],
  );

  const forkFromMessage = useCallback(
    async (message: AgentMessage) => {
      const activeAgent = agentRef.current;
      const snapshot = activeAgent?.getSnapshot();
      if (!activeAgent || !snapshot || snapshot.isStreaming) return;
      const index = findMessageIndex([...snapshot.messages], message);
      const entryId = index >= 0 ? sessionRef.current.messageEntryIds[index] : undefined;
      if (!entryId) return;
      try {
        const fork = await forkSession(sessionRef.current.id, entryId);
        navigate(`/agents/${fork.agentId}/sessions/${fork.id}`);
      } catch (error) {
        showError(i18n._("Unable to fork session"), error);
      }
    },
    [agentRef, forkSession, navigate, sessionRef, i18n],
  );

  const editMessage = useCallback((message: AgentMessage) => {
    const assistant = message.role === "assistant";
    setEditingMessage({
      message,
      draft: getMessageText(message),
      kind: assistant ? "assistant" : "user",
      images: assistant ? [] : getEditableUserImages(message),
      removedKeys: new Set(),
    });
  }, []);

  return {
    editingMessage,
    editMessage,
    forkFromMessage,
    retryFromMessage,
    saveAssistantMessage,
    saveUserMessage,
    setEditingMessage,
  };
}
