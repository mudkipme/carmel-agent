import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCutPoint,
  describeCutPointRejection,
  inspectBranchIntegrity,
  type BranchMessage,
} from "./branch-integrity.ts";
import type { SessionMessage } from "./contracts/messages.ts";

test("a branch with no tools is intact", () => {
  assert.deepEqual(inspectBranchIntegrity([user("e1", "hi"), assistant("e2", "hello")]), []);
});

test("a call answered by its result is intact", () => {
  assert.deepEqual(inspectBranchIntegrity(FULL_TURN), []);
});

test("a call with no result is reported against the entry that made it", () => {
  assert.deepEqual(inspectBranchIntegrity(FULL_TURN.slice(0, 2)), [
    { kind: "unanswered_tool_call", entryId: "e2", toolCallId: "call-1", toolName: "bash" },
  ]);
});

test("a result with no call is reported too", () => {
  // Not reachable by cutting a branch short -- a prefix cannot drop a call and
  // keep its result -- but rewriting history can, so the inspector covers it.
  assert.deepEqual(inspectBranchIntegrity([user("e1", "hi"), toolResult("e3", "call-1", "bash")]), [
    { kind: "orphan_tool_result", entryId: "e3", toolCallId: "call-1", toolName: "bash" },
  ]);
});

test("one assistant message with several calls reports each unanswered one", () => {
  const branch = [
    user("e1", "hi"),
    assistantWithCalls("e2", [
      { id: "call-1", name: "bash" },
      { id: "call-2", name: "read" },
    ]),
    toolResult("e3", "call-1", "bash"),
  ];
  assert.deepEqual(inspectBranchIntegrity(branch), [
    { kind: "unanswered_tool_call", entryId: "e2", toolCallId: "call-2", toolName: "read" },
  ]);
});

test("cutting at a user message is always allowed", () => {
  assert.deepEqual(checkCutPoint(FULL_TURN, "e1"), { ok: true });
});

test("cutting at a plain assistant message is allowed", () => {
  assert.deepEqual(checkCutPoint(FULL_TURN, "e4"), { ok: true });
});

test("cutting at the tool result that closes the call is allowed", () => {
  assert.deepEqual(checkCutPoint(FULL_TURN, "e3"), { ok: true });
});

test("cutting between a call and its result is rejected, and names where to cut instead", () => {
  const check = checkCutPoint(FULL_TURN, "e2");
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.deepEqual(check.unanswered, [{ entryId: "e2", toolCallId: "call-1", toolName: "bash" }]);
  assert.equal(check.safeEntryId, "e3");
  assert.match(describeCutPointRejection(check), /unanswered tool call \(bash\)/);
});

test("a call the branch never answers offers no safe entry", () => {
  const check = checkCutPoint(FULL_TURN.slice(0, 2), "e2");
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.safeEntryId, null);
  assert.match(describeCutPointRejection(check), /No later entry/);
});

test("the safe entry skips past a second call opened before the first closes", () => {
  // Parallel tool calls: the first result does not make the branch valid.
  const branch = [
    user("e1", "hi"),
    assistantWithCalls("e2", [
      { id: "call-1", name: "bash" },
      { id: "call-2", name: "read" },
    ]),
    toolResult("e3", "call-1", "bash"),
    toolResult("e4", "call-2", "read"),
  ];
  const check = checkCutPoint(branch, "e2");
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.safeEntryId, "e4");
});

test("an unknown entry is not this check's business", () => {
  // The routes already 404 on an unknown id; failing closed here would turn
  // that into a confusing 409.
  assert.deepEqual(checkCutPoint(FULL_TURN, "nope"), { ok: true });
});

const FULL_TURN: BranchMessage[] = [
  user("e1", "run ls"),
  assistantWithCalls("e2", [{ id: "call-1", name: "bash" }]),
  toolResult("e3", "call-1", "bash"),
  assistant("e4", "here are the files"),
];

function user(entryId: string, text: string): BranchMessage {
  return { entryId, message: { role: "user", content: text } as SessionMessage };
}

function assistant(entryId: string, text: string): BranchMessage {
  return { entryId, message: { role: "assistant", content: [{ type: "text", text }] } as SessionMessage };
}

function assistantWithCalls(entryId: string, calls: { id: string; name: string }[]): BranchMessage {
  return {
    entryId,
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
    } as SessionMessage,
  };
}

function toolResult(entryId: string, toolCallId: string, toolName: string): BranchMessage {
  return {
    entryId,
    message: { role: "toolResult", toolCallId, toolName, content: [], isError: false } as unknown as SessionMessage,
  };
}
