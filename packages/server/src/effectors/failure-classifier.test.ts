import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTurnFailure,
  formatTurnFailure,
  type FailureCategory,
} from "./failure-classifier.ts";

/**
 * Wording taken from what the providers actually return.
 *
 * No overflow cases: this unit does not detect one. `overflowHint` carries Pi's
 * verdict, and that the hint still fires on real provider wording is asserted
 * against Pi itself in `runtime/run-events.test.ts`.
 */
const REAL_MESSAGES: readonly { category: FailureCategory; message: string }[] = [
  {
    category: "auth",
    message:
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  },
  { category: "auth", message: "OAuth token has expired. Please re-authenticate." },
  {
    category: "quota",
    message:
      "429 You exceeded your current quota, please check your plan and billing details. code: insufficient_quota",
  },
  { category: "quota", message: "Your credit balance is too low to access the Anthropic API." },
  {
    category: "tool_history",
    message:
      "400 messages.6: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01A. Each `tool_use` block must have a corresponding `tool_result`.",
  },
  {
    category: "tool_history",
    message:
      "400 Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'.",
  },
  {
    category: "model_unavailable",
    message: "404 The model `gpt-5.6-sol` does not exist or you do not have access to it.",
  },
  { category: "transient", message: '529 {"type":"overloaded_error","message":"Overloaded"}' },
  { category: "transient", message: "fetch failed: ECONNRESET" },
];

for (const { category, message } of REAL_MESSAGES) {
  test(`classifies as ${category}: ${message.slice(0, 48)}…`, () => {
    assert.equal(classifyTurnFailure({ message }).category, category);
  });
}

test("the overflow hint decides the category outright", () => {
  // Authoritative, not a tie-breaker: Pi's detector has already excluded the
  // throttling texts that read like an overflow, and it sees silent overflows
  // that carry no error text for a pattern to match in the first place.
  const failure = classifyTurnFailure({ message: "", overflowHint: true });
  assert.equal(failure.category, "context_overflow");
  assert.equal(failure.retryable, false);
  assert.ok(failure.remedy);
});

test("a quota refusal that mentions 429 is not treated as retryable", () => {
  // Pi reads any 429 as transient. Retrying an exhausted quota just burns the
  // turn, so a specific match has to win over the hint.
  const failure = classifyTurnFailure({
    message: "429 You exceeded your current quota. code: insufficient_quota",
    transientHint: true,
  });
  assert.equal(failure.category, "quota");
  assert.equal(failure.retryable, false);
});

test("the transient hint only promotes an otherwise unrecognised failure", () => {
  assert.equal(
    classifyTurnFailure({ message: "something odd", transientHint: true }).category,
    "transient",
  );
  assert.equal(classifyTurnFailure({ message: "something odd" }).category, "unknown");
});

test("only transient failures are marked retryable", () => {
  assert.equal(classifyTurnFailure({ message: "Overloaded" }).retryable, true);
  assert.equal(classifyTurnFailure({ message: "invalid x-api-key" }).retryable, false);
  assert.equal(classifyTurnFailure({ message: "prompt is too long" }).retryable, false);
});

test("an abort is not a provider failure and gets no remedy", () => {
  const failure = classifyTurnFailure({ message: "Operation aborted", aborted: true });
  assert.equal(failure.category, "aborted");
  assert.equal(failure.remedy, undefined);
});

test("a classified failure is rendered as cause, remedy, then the provider's words", () => {
  const rendered = formatTurnFailure(classifyTurnFailure({ message: "401 invalid x-api-key" }));
  assert.match(rendered, /rejected the request as unauthorized/);
  assert.match(rendered, /Settings → Providers/);
  assert.match(rendered, /\(401 invalid x-api-key\)/);
});

test("a tool-history failure points at the fork and truncate remedy", () => {
  // The same condition `branch-integrity.ts` refuses to create -- but a session
  // can still arrive here through an import or an older branch.
  const rendered = formatTurnFailure(
    classifyTurnFailure({ message: "`tool_use` ids were found without `tool_result` blocks" }),
  );
  assert.match(rendered, /Fork or truncate at the last complete exchange/);
});

test("an unclassified failure keeps the provider's text instead of a useless summary", () => {
  assert.equal(
    formatTurnFailure(classifyTurnFailure({ message: "weird gateway hiccup" })),
    "weird gateway hiccup",
  );
});

test("long provider detail is collapsed and truncated, not dumped", () => {
  const rendered = formatTurnFailure(
    classifyTurnFailure({ message: `invalid x-api-key\n${"x".repeat(900)}` }),
  );
  assert.ok(rendered.length < 600, `rendered ${rendered.length} chars`);
  assert.match(rendered, /…\)$/);
});
