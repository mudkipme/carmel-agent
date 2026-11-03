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
