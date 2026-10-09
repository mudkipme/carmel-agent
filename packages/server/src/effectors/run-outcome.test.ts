import test from "node:test";
import assert from "node:assert/strict";
import { INTERRUPTED_DETAIL, RunOutcome } from "./run-outcome.ts";

test("a run whose last turn ended cleanly succeeded", () => {
  const outcome = new RunOutcome();
  outcome.recordTurnEnd({ stopReason: "stop" });
  assert.deepEqual(outcome.result(), { outcome: "succeeded" });
});

test("a provider rejection fails the run even though nothing threw", () => {
  const outcome = new RunOutcome();
  outcome.recordTurnEnd({ stopReason: "error", detail: "The provider rejected the API key." });
  assert.deepEqual(outcome.result(), {
    outcome: "failed",
    detail: "The provider rejected the API key.",
  });
});

test("only the last turn counts, so a recovered failure is a success", () => {
  const outcome = new RunOutcome();
  outcome.recordTurnEnd({ stopReason: "error", detail: "Context overflow." });
  outcome.recordTurnEnd({ stopReason: "stop" });
  assert.equal(outcome.result().outcome, "succeeded");
});

test("an error thrown out of the run body fails it", () => {
  const outcome = new RunOutcome();
  outcome.recordTurnEnd({ stopReason: "stop" });
  outcome.recordThrown("Cannot retry an empty user message.");
  assert.deepEqual(outcome.result(), {
    outcome: "failed",
    detail: "Cannot retry an empty user message.",
  });
});

test("the abort reason decides a stopped run", () => {
  const stopped = () => {
    const outcome = new RunOutcome();
    outcome.recordTurnEnd({ stopReason: "aborted", detail: "Aborted." });
    return outcome;
  };
  assert.deepEqual(stopped().result("user"), { outcome: "cancelled" });
  assert.deepEqual(stopped().result("shutdown"), {
    outcome: "interrupted",
    detail: INTERRUPTED_DETAIL,
  });

  const guarded = stopped();
  guarded.recordThrown("This run was stopped after 4 tool calls.");
  assert.deepEqual(guarded.result("guard"), {
    outcome: "failed",
    detail: "This run was stopped after 4 tool calls.",
  });
  // A guard stop that landed before the prompt never threw, and still needs a reason.
  assert.equal(stopped().result("guard").outcome, "failed");
});

test("an abort nothing asked for is a failure, not a cancellation", () => {
  const outcome = new RunOutcome();
  outcome.recordTurnEnd({ stopReason: "aborted" });
  assert.equal(outcome.result().outcome, "failed");
});

test("a result that could not be saved fails a run that otherwise worked", () => {
  const succeeded = new RunOutcome();
  succeeded.recordTurnEnd({ stopReason: "stop" });
  succeeded.recordPersistenceFailure("disk I/O error");
  assert.deepEqual(succeeded.result(), {
    outcome: "failed",
    detail: "The run's result could not be saved: disk I/O error",
  });

  const cancelled = new RunOutcome();
  cancelled.recordPersistenceFailure("disk I/O error");
  assert.equal(cancelled.result("user").outcome, "failed");
});

test("a run that already failed keeps its original reason when saving also fails", () => {
  const outcome = new RunOutcome();
  outcome.recordTurnEnd({ stopReason: "error", detail: "Rate limited." });
  outcome.recordPersistenceFailure("disk I/O error");
  assert.deepEqual(outcome.result(), { outcome: "failed", detail: "Rate limited." });
});
