import test from "node:test";
import assert from "node:assert/strict";
import { collaborationReply } from "@carmel-agent/shared";

test("collaboration replies retain structured metadata and recognize saved legacy notices", () => {
  const reply = {
    id: "collaboration_one",
    agentId: "agent_one",
    agentName: "Researcher",
    answer: "Verified the deployment.",
    sessionId: "session_one",
  };
  assert.equal(collaborationReply({ text: "Researcher replied", collaboration: reply }), reply);
  assert.deepEqual(
    collaborationReply({
      text: "Agent agent_one replied to collaboration collaboration_one:\nVerified the deployment.\nTask: /agents/agent_one/tasks/issue_one. Reported results still require human acceptance.",
    }),
    {
      id: "collaboration_one",
      agentId: "agent_one",
      answer: "Verified the deployment.",
      taskId: "issue_one",
    },
  );
  assert.equal(collaborationReply({ text: "An ordinary notice" }), undefined);
});

test("collaboration activity belongs to its creating tool result in the visible branch", async () => {
  const { collaborationOriginIndex } = await import("../components/chat/chat-utils.ts");
  const { fauxAssistantMessage, fauxToolCall } =
    await import("@earendil-works/pi-ai/providers/faux");
  const user = { role: "user" as const, content: "Ask the peer", timestamp: 100 };
  const call = fauxAssistantMessage(
    fauxToolCall(
      "ask_agent",
      { agentId: "agent_peer", question: "Find facts" },
      { id: "ask_original" },
    ),
  );
  const result = {
    role: "toolResult" as const,
    toolCallId: "ask_original",
    toolName: "ask_agent",
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ id: "collaboration_original", waiting: true }),
      },
    ],
    isError: false,
    timestamp: 200,
  };
  const messages = [user, call, result, fauxAssistantMessage("Original answer")];
  assert.equal(collaborationOriginIndex(messages, "collaboration_original"), 1);
  assert.equal(collaborationOriginIndex([user], "collaboration_original"), -1);
  assert.equal(
    collaborationOriginIndex(
      [{ ...user, timestamp: 500 }, fauxAssistantMessage("Retried answer")],
      "collaboration_original",
    ),
    -1,
  );
  const read = fauxAssistantMessage(
    fauxToolCall(
      "read_collaboration",
      { collaborationId: "collaboration_original" },
      { id: "read_saved" },
    ),
  );
  assert.equal(
    collaborationOriginIndex(
      [user, read, { ...result, toolName: "read_collaboration", toolCallId: "read_saved" }],
      "collaboration_original",
    ),
    -1,
  );
  const script = fauxAssistantMessage(
    fauxToolCall(
      "codemode",
      { code: "return await tools.ask_agent({agentId: 'agent_peer', question: 'Find facts'})" },
      { id: "ask_script" },
    ),
  );
  assert.equal(
    collaborationOriginIndex(
      [user, script, { ...result, toolName: "codemode", toolCallId: "ask_script" }],
      "collaboration_original",
    ),
    1,
  );
});
