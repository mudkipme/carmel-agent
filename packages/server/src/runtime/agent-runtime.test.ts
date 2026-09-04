import test from "node:test";
import assert from "node:assert/strict";
import { parseSlashCommand, skillCommandName, slashCommandText } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { db, migrate } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { attachTestHarness, fauxHarnessModels } from "../effectors/testing/pi-harness.ts";
import { loadSession, replaceSessionMessages } from "../services/session-store.ts";
import { createSession, userMessage } from "../test-support.ts";
import {
  commitSessionRunState,
  commitSessionRunTitle,
  HarnessAbortGate,
  prepareAgentRunPrompt,
  RetryBranch,
} from "./agent-runtime.ts";

migrate();

test("run finalization compare-and-swap cannot overwrite a newer session revision", () => {
  const fixture = createSession();
  db.update(sessions)
    .set({ title: "newer mutation", revision: 1 })
    .where(eq(sessions.id, fixture.sessionId))
    .run();

  const committed = commitSessionRunState(fixture.sessionId, 0, {
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    updatedAt: 123,
  });

  assert.equal(committed, undefined);
  const stored = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get();
  assert.equal(stored?.title, "newer mutation");
  assert.equal(stored?.revision, 1);
  assert.notEqual(stored?.updatedAt, 123);
});

test("run state and generated title commits advance the leased revision", () => {
  const fixture = createSession();

  const runRevision = commitSessionRunState(fixture.sessionId, 0, {
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    updatedAt: 123,
  });
  assert.equal(runRevision, 1);
  assert.equal(commitSessionRunTitle(fixture.sessionId, 0, "stale title"), undefined);
  assert.equal(commitSessionRunTitle(fixture.sessionId, runRevision!, "generated title"), 2);

  const stored = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get();
  assert.equal(stored?.title, "generated title");
  assert.equal(stored?.revision, 2);
});

test("every formatted palette command parses back to the resource it names", () => {
  // The invariant that keeps routes/agents.ts and runHarnessPrompt in step: the
  // text the command endpoint hands the composer must resolve to the same skill
  // or template when it comes back through the run path.
  for (const skillName of ["inspect", "pdf-report", "a.b"]) {
    const parsed = parseSlashCommand(slashCommandText(skillCommandName(skillName)).trimEnd());
    assert.equal(parsed?.skillName, skillName);
  }
  for (const templateName of ["review", "plan-2"]) {
    const parsed = parseSlashCommand(slashCommandText(templateName).trimEnd());
    assert.equal(parsed?.name, templateName);
    assert.equal(parsed?.skillName, undefined);
  }
});

test("slash command parsing separates the command token from its arguments", () => {
  assert.equal(parseSlashCommand("just a message"), undefined);
  assert.equal(parseSlashCommand(""), undefined);
  // A bare slash is not a command token.
  assert.equal(parseSlashCommand("/"), undefined);

  assert.deepEqual(parseSlashCommand('/review "some file"'), {
    name: "review",
    skillName: undefined,
    args: '"some file"',
  });
  assert.deepEqual(parseSlashCommand("/skill:inspect focus on safety"), {
    name: "skill:inspect",
    skillName: "inspect",
    args: "focus on safety",
  });
  // No arguments, and multi-line arguments.
  assert.equal(parseSlashCommand("/review")?.args, "");
  assert.equal(parseSlashCommand("/review first\nsecond")?.args, "first\nsecond");
});

test("an unarmed retry branch is never abandoned and restores nothing", async () => {
  const retry = new RetryBranch();
  retry.arm(undefined);
  assert.equal(retry.isAbandoned, false);
  // No session call at all, so a plain prompt cannot move the branch.
  await retry.restore({ moveTo: () => assert.fail("unarmed restore moved the branch") } as never);
});

test("an armed retry branch is abandoned until its replacement user message lands", async () => {
  const retry = new RetryBranch();
  retry.arm("entry_original_leaf");
  assert.equal(retry.isAbandoned, true);

  // Only a persisted *user* message clears it; assistant traffic must not.
  retry.observe({ type: "message_end", message: { role: "assistant", content: [] } } as never);
  assert.equal(retry.isAbandoned, true);
  retry.observe({ type: "message_start", message: { role: "user", content: "x" } } as never);
  assert.equal(retry.isAbandoned, true);

  retry.observe({ type: "message_end", message: { role: "user", content: "x" } } as never);
  assert.equal(retry.isAbandoned, false);
});

test("restoring an abandoned retry returns the session to the original leaf", async () => {
  const { sessionId } = createSession();
  await replaceSessionMessages(sessionId, [userMessage("kept"), userMessage("retried")]);
  const before = await loadSession(sessionId);
  const originalLeafId = before!.messageEntryIds.at(-1)!;

  const piSession = await openPiSession(sessionId);
  // `prepareAgentRunPrompt` and `RetryBranch` both work through the session log
  // now: 0.85 has no `session.moveTo`, and rewinding is a branch-tip write.
  const pi = await attachTestHarness(piSession, fauxHarnessModels());
  try {
    // Reproduce a retry that rewound the branch but never persisted a replacement.
    const prepared = await prepareAgentRunPrompt(pi.log);
    const retry = new RetryBranch();
    retry.arm(prepared.retryOriginalLeafId);
    assert.equal(retry.isAbandoned, true);
    assert.deepEqual((await pi.branch()).filter((e) => e.type === "message").length, 1);

    await retry.restore(pi.log);
  } finally {
    await pi.close();
  }

  const after = await loadSession(sessionId);
  assert.deepEqual(after!.messageEntryIds, before!.messageEntryIds);
  assert.equal(after!.messageEntryIds.at(-1), originalLeafId);
});

test("abort requested before the harness exists still aborts it once attached", async () => {
  const gate = new HarnessAbortGate();
  let aborts = 0;
  const harness = { abort: async () => void aborts++ };

  // Abort landing first must not throw, and must stay latched for the run body.
  gate.request();
  assert.equal(gate.requested, true);
  assert.equal(aborts, 0);

  gate.attach(harness as never);
  // The run body is what acts on the latched flag; attaching alone does not.
  assert.equal(aborts, 0);

  gate.request();
  assert.equal(aborts, 1);
  gate.release();
  gate.request();
  assert.equal(aborts, 1, "a released gate no longer reaches the finished harness");
});
