import { useEffect } from "react";
import type {
  AgentConfig,
  IssueNote,
  ModelRef,
  Session,
} from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { api } from "@/lib/api";
import { useHarnessStore } from "@/store/harness-store";
import { useSessionAgent } from "@/hooks/use-session-agent";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { ResourceError, ResourceLoading } from "../ResourceFeedback";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ContextPressureNotice } from "@/components/chat/ContextPressureNotice";

export function IssueConversation({
  agent,
  sessionId,
  notes,
  running,
}: {
  agent: AgentConfig;
  sessionId: string;
  notes: IssueNote[];
  running: boolean;
}) {
  const modelRefs = useHarnessStore((s) => s.modelRefs);
  const {
    data: connection,
    error,
    refresh,
  } = useRemoteResource({
    key: `conversation:${sessionId}`,
    load: (signal) => api.getSessionConnection(sessionId, signal),
  });
  const session = connection?.session;
  const modelRef = modelRefs.find((m) => m.id === session?.modelRefId);
  if (!session)
    return error ? (
      <ResourceError
        error={error}
        title="Unable to load conversation"
        onRetry={refresh}
      />
    ) : (
      <ResourceLoading label="Connecting to conversation" />
    );
  if (!modelRef)
    return (
      <ChatMessages
        messages={withNotes(session.messages, notes)}
        pendingToolCalls={new Set()}
        isStreaming={false}
      />
    );
  return (
    <ConnectedConversation
      agent={agent}
      session={session}
      modelRef={modelRef}
      notes={notes}
      running={running}
    />
  );
}

function ConnectedConversation({
  agent: config,
  session,
  modelRef,
  notes,
  running,
}: {
  agent: AgentConfig;
  session: Session;
  modelRef: ModelRef;
  notes: IssueNote[];
  running: boolean;
}) {
  const { agent, snapshot } = useSessionAgent(config, session, modelRef);
  const connection = useRemoteResource({
    key: `live-conversation:${session.id}`,
    enabled: Boolean(agent) && !snapshot.isStreaming,
    load: (signal) => api.getSessionConnection(session.id, signal),
    pollInterval: running ? 2_000 : 30_000,
    refreshKey: running,
  });
  useEffect(() => {
    if (!agent || !connection.data || agent.getSnapshot().isStreaming) return;
    const { activeRun, session: saved } = connection.data;
    if (activeRun)
      void agent.attachToRun(
        activeRun.runId,
        saved.messages,
        activeRun.eventCursor,
      );
    else agent.setMessages(saved.messages);
  }, [agent, connection.data]);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {connection.error && !snapshot.isStreaming ? (
        <ResourceError
          error={connection.error}
          title="Unable to refresh conversation"
          onRetry={connection.refresh}
        />
      ) : null}
      {snapshot.contextPressure ? (
        <ContextPressureNotice pressure={snapshot.contextPressure} />
      ) : null}
      <ChatMessages
        messages={withNotes(snapshot.messages, notes)}
        streamingMessage={snapshot.streamingMessage}
        pendingToolCalls={snapshot.pendingToolCalls}
        codemodeCalls={snapshot.codemodeCalls}
        isStreaming={snapshot.isStreaming}
      />
    </div>
  );
}

function withNotes(
  messages: AgentMessage[],
  notes: IssueNote[],
): AgentMessage[] {
  const merged = messages.map((message) => {
    if (message.role !== "user") return message;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (
      !text.startsWith("# ") ||
      !text.includes("## Recent activity") ||
      !text.includes("## Previous attempts")
    )
      return message;
    // Old runs embedded the app's full brief and event log in a user message.
    // The brief and exact run input remain available in the issue's history.
    const instructions = text
      .split(/## Instructions for (?:this attempt|this run)/)[1]
      ?.trim();
    return {
      ...message,
      content:
        instructions && instructions !== "Carry out the brief."
          ? instructions
          : "Work on this issue.",
    };
  });
  for (const note of notes.filter(
    (n) => n.kind === "note" && n.delivery !== "delivered",
  )) {
    const label =
      note.delivery === "queued"
        ? "Update queued"
        : note.delivery === "not_delivered"
          ? "Update saved · Not delivered"
          : "Saved note";
    const message: AgentMessage = {
      role: "user",
      content: `${label}\n\n${note.body}`,
      timestamp: note.createdAt,
    };
    const index = merged.findIndex(
      (m) =>
        "timestamp" in m &&
        typeof m.timestamp === "number" &&
        m.timestamp > note.createdAt,
    );
    merged.splice(index < 0 ? merged.length : index, 0, message);
  }
  return merged;
}
