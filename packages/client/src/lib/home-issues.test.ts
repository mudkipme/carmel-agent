import test from "node:test";
import assert from "node:assert/strict";
import { homeIssueUpdate } from "@carmel-agent/shared";

test("saved legacy issue reports become compact updates without their evidence", () => {
  const text =
    "[Check cluster health](/agents/agent_one/tasks/issue_one?from=home) — needs_input\n\nMissing kubectl.\n\nChecks, artifacts, and uncertainty: full diagnostics.";
  assert.deepEqual(homeIssueUpdate({ text }), {
    id: "issue_one",
    agentId: "agent_one",
    title: "Check cluster health",
    status: "needs_input",
  });
  assert.equal(homeIssueUpdate({ text: "New context" }), undefined);
  assert.equal(
    homeIssueUpdate({ text: "[A reference](https://example.test) — needs_input" }),
    undefined,
  );
});
