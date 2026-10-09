import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openTestHarness } from "../effectors/testing/pi-harness.ts";
import type { AgentHarnessTool, ExecutionToolContext } from "../effectors/pi-durable/index.ts";
import { createCodemodeTool } from "./codemode-tool.ts";
import { projectRunEvent } from "./run-events.ts";
import type { AgentRunEvent } from "@carmel-agent/shared";
import type { LiveState } from "@earendil-works/pi-durable";

initialize();
const parameters = { type: "object", properties: {}, additionalProperties: false };
const content = [{ type: "text" as const, text: "done" }];

test("SQLite restart resumes a codemode checkpoint without repeating nested side effects or user input", async () => {
  const { sessionId } = createSession();
  let effects = 0;
  let progress!: () => void;
  const committed = new Promise<void>((resolve) => {
    progress = resolve;
  });
  const nested: AgentHarnessTool<ExecutionToolContext>[] = [
    {
      name: "effect",
      label: "Effect",
      description: "An external effect",
      parameters,
      async execute() {
        effects++;
        return { content };
      },
    },
    {
      name: "wait",
      label: "Wait",
      description: "Wait until shutdown",
      parameters,
      async execute(_id, _args, _update, _tools, _invocation, context) {
        await new Promise((_, reject) =>
          context.abortSignal!.addEventListener(
            "abort",
            () => reject(context.abortSignal!.reason),
            { once: true },
          ),
        );
        return { content };
      },
    },
  ];
  const faux = fauxProvider({
    provider: `faux-restart-${crypto.randomUUID()}`,
    tokensPerSecond: 100_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("codemode", {
          code: "await tools.effect({}); await tools.wait({}); text('finished');",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Recovered without repeating the effect."),
  ]);
  const options = {
    models,
    model: faux.getModel(),
    tools: [createCodemodeTool(nested)],
    toolContext: {} as ExecutionToolContext,
  };
  const first = await openTestHarness(sessionId, options);
  first.observe((event) => {
    if (
      event.type === "tool_update" &&
      (event.partialResult.details as { codemodeCalls?: unknown[] })?.codemodeCalls?.length === 2
    )
      progress();
  });
  await first.session.conversation.submit(
    { type: "input", content: "Run the batch", whenBusy: "reject" },
    first.context,
  );
  await committed;
  assert.equal(effects, 1);
  // Close joins cancelled invocations while retaining their last committed checkpoints.
  await first.close();
  const reopened = await openTestHarness(sessionId, options);
  try {
    assert.equal(await reopened.lane.hasPending(reopened.context), true);
    await reopened.lane.resume(reopened.context);
    assert.equal(effects, 1);
    const messages = (await reopened.branch()).flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
    assert.equal(messages.filter((message) => message.role === "user").length, 1);
    const result = messages.find((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult" && result.isError);
    assert.match(JSON.stringify(result.content), /interrupted/);
    assert.equal((result.details as { codemodeCalls: unknown[] }).codemodeCalls.length, 2);
    assert.match(JSON.stringify(messages.at(-1)), /Recovered without repeating/);
    assert.equal(await reopened.lane.hasPending(reopened.context), false);
  } finally {
    await reopened.close();
  }
});

test("SQLite restart can replay a tool explicitly declared safe", async () => {
  const { sessionId } = createSession();
  let executions = 0;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const safe: AgentHarnessTool<ExecutionToolContext> = {
    name: "safe_read",
    label: "Read",
    description: "Read-only lookup",
    parameters,
    replay: "safe",
    async execute(_id, _args, _update, _tools, _invocation, context) {
      executions++;
      if (executions === 1) {
        started();
        await new Promise((_, reject) =>
          context.abortSignal!.addEventListener(
            "abort",
            () => reject(context.abortSignal!.reason),
            { once: true },
          ),
        );
      }
      return { content };
    },
  };
  const faux = fauxProvider({
    provider: `faux-safe-restart-${crypto.randomUUID()}`,
    tokensPerSecond: 100_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(safe.name, {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Read recovered."),
  ]);
  const options = { models, model: faux.getModel(), tools: [safe] };
  const first = await openTestHarness(sessionId, options);
  await first.session.conversation.submit(
    { type: "input", content: "Read", whenBusy: "reject" },
    first.context,
  );
  await entered;
  await first.close();
  const reopened = await openTestHarness(sessionId, options);
  try {
    await reopened.lane.resume(reopened.context);
    assert.equal(executions, 2);
    const result = (await reopened.branch()).find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    assert.ok(
      result?.type === "message" && result.message.role === "toolResult" && !result.message.isError,
    );
  } finally {
    await reopened.close();
  }
});

test(
  "a slow observer recovers a complete transcript when Durable replaces its backlog with a snapshot",
  { timeout: 10_000 },
  async () => {
    const { sessionId } = createSession();
    const faux = fauxProvider({
      provider: `faux-backlog-${crypto.randomUUID()}`,
      tokensPerSecond: 100_000,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      ...Array.from({ length: 40 }, () =>
        fauxAssistantMessage([fauxToolCall("lookup", {})], { stopReason: "toolUse" }),
      ),
      fauxAssistantMessage("All lookups complete."),
    ]);
    const lookup: AgentHarnessTool<ExecutionToolContext> = {
      name: "lookup",
      label: "Lookup",
      description: "Lookup",
      parameters,
      async execute() {
        return { content };
      },
    };
    const pi = await openTestHarness(sessionId, {
      models,
      model: faux.getModel(),
      tools: [lookup],
    });
    let release!: () => void, blocked!: () => void;
    const waiting = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wire: AgentRunEvent[] = [];
    pi.observe(async (event) => {
      if (event.type === "message_start" && event.message.role === "user") {
        blocked();
        await gate;
      }
      const projected = projectRunEvent(event);
      if (projected) wire.push(projected);
    });
    try {
      const prompt = pi.lane.prompt("Look up forty items", undefined, pi.context);
      await waiting;
      await pi.session.conversation.waitForIdle(pi.context);
      release();
      await prompt;
      const expected = (await pi.branch()).flatMap((entry) =>
        entry.type === "message" ? [entry.message] : [],
      );
      const received = wire.flatMap((event) =>
        event.type === "message_end" ? [event.message] : [],
      );
      assert.deepEqual(received, expected);
      assert.equal(wire.filter((event) => event.type === "tool_execution_end").length, 40);
      assert.equal(wire.at(-1)?.type, "agent_end");
    } finally {
      release();
      await pi.close();
    }
  },
);

test(
  "repeated backlog snapshots restore live codemode progress without duplicate tool starts",
  { timeout: 15_000 },
  async () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const observerGate = deferred(),
      progressGate = deferred(),
      toolGate = deferred();
    const committed = deferred(),
      restored = deferred(),
      restoredAgain = deferred();
    const { sessionId } = createSession();
    const faux = fauxProvider({
      provider: `faux-live-backlog-${crypto.randomUUID()}`,
      tokensPerSecond: 100_000,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("codemode", { code: "await tools.wait({}); text('finished');" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished."),
    ]);
    const wait: AgentHarnessTool<ExecutionToolContext> = {
      name: "wait",
      label: "Wait",
      description: "Wait",
      parameters,
      async execute() {
        await toolGate.promise;
        return { content };
      },
    };
    const pi = await openTestHarness(sessionId, {
      models,
      model: faux.getModel(),
      tools: [createCodemodeTool([wait])],
      toolContext: {} as ExecutionToolContext,
    });
    const unsubscribe = pi.session.native.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.record.kind !== "pi.live" || !change.value)
          continue;
        const live = change.value as LiveState;
        if (
          live.tools?.some(
            (slot) => (slot.details as { codemodeCalls?: unknown[] })?.codemodeCalls?.length === 1,
          )
        )
          committed.resolve();
      }
    });
    const wire: AgentRunEvent[] = [];
    let progressCount = 0;
    pi.observe(async (event) => {
      if (event.type === "message_start" && event.message.role === "user")
        await observerGate.promise;
      const projected = projectRunEvent(event);
      if (projected) wire.push(projected);
      if (
        event.type === "tool_update" &&
        (event.partialResult.details as { codemodeCalls?: unknown[] })?.codemodeCalls?.length === 1
      ) {
        if (++progressCount === 1) {
          restored.resolve();
          await progressGate.promise;
        } else restoredAgain.resolve();
      }
    });
    async function overflow() {
      for (let i = 0; i < 110; i++)
        await pi.lane.configure({ thinkingLevel: i % 2 ? "high" : "medium" }, pi.context);
    }
    try {
      const prompt = pi.lane.prompt("Wait", undefined, pi.context);
      await committed.promise;
      await overflow();
      observerGate.resolve();
      await restored.promise;
      assert.equal(wire.filter((event) => event.type === "tool_execution_start").length, 1);
      assert.equal(wire.filter((event) => event.type === "tool_execution_update").length, 1);
      await overflow();
      progressGate.resolve();
      await restoredAgain.promise;
      assert.equal(wire.filter((event) => event.type === "tool_execution_start").length, 1);
      toolGate.resolve();
      await prompt;
      assert.equal(wire.filter((event) => event.type === "tool_execution_end").length, 1);
      assert.equal(wire.at(-1)?.type, "agent_end");
    } finally {
      observerGate.resolve();
      progressGate.resolve();
      toolGate.resolve();
      unsubscribe();
      await pi.close();
    }
  },
);
