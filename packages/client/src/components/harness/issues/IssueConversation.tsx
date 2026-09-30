import { useEffect, useState } from "react";
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
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ContextPressureNotice } from "@/components/chat/ContextPressureNotice";

export function IssueConversation({
  agent,
  sessionId,
  notes,
}: {
  agent: AgentConfig;
  sessionId: string;
  notes: IssueNote[];
}) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState(false);
  const modelRefs = useHarnessStore((s) => s.modelRefs);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .getSessionConnection(sessionId, controller.signal)
      .then((connection) => setSession(connection.session))
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [sessionId]);
  const modelRef = modelRefs.find((m) => m.id === session?.modelRefId);
  if (!session)
    return (
      <p
        role={error ? "alert" : "status"}
        className="text-sm text-muted-foreground"
      >
        {error
          ? "Unable to load the conversation. Reopen this issue to retry."
          : "Connecting to the conversation…"}
      </p>
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
    />
  );
}

function ConnectedConversation({
  agent: config,
  session,
  modelRef,
  notes,
}: {
  agent: AgentConfig;
  session: Session;
  modelRef: ModelRef;
  notes: IssueNote[];
}) {
  const { agent, snapshot } = useSessionAgent(config, session, modelRef);
  useEffect(() => {
    if (!agent) return;
    let disposed = false;
    let attaching = false;
    async function refresh() {
      if (disposed || attaching || agent!.getSnapshot().isStreaming) return;
      attaching = true;
      try {
        const connection = await api.getSessionConnection(session.id);
        if (disposed) return;
        if (connection.activeRun)
          void agent!.attachToRun(
            connection.activeRun.runId,
            connection.session.messages,
            connection.activeRun.eventCursor,
          );
        else agent!.setMessages(connection.session.messages);
      } finally {
        attaching = false;
      }
    }
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      2000,
    );
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [agent, session.id]);
  return (
    <div className="flex min-w-0 flex-col gap-4">
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
