import assert from "node:assert/strict";
import test from "node:test";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import {
  fauxHarnessModels,
  openTestHarness,
  type TestHarness,
} from "../effectors/testing/pi-harness.ts";
import type { ToolRegistration } from "../effectors/pi-durable/index.ts";
import { createCarmelCodemode } from "./codemode-tool.ts";

initialize();
const parameters = { type: "object", properties: {}, additionalProperties: false };
const content = [{ type: "text" as const, text: "done" }];

test(
  "native Codemode replays its journal, resumes a safe nested call, and continues with new effects",
  { timeout: 10_000 },
  async () => {
    const { sessionId } = createSession();
    const { faux, ...models } = fauxHarnessModels();
    let effects = 0,
      reads = 0,
      admissions = 0;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const tools: ToolRegistration[] = [
      {
        name: "effect",
        description: "External effect",
        parameters,
        async execute() {
          effects++;
          return { output: content };
        },
      },
      {
        name: "read",
        description: "Replay-safe lookup",
        parameters,
        replay: "safe",
        async execute(_args, _api, context) {
          if (++reads === 1) {
            entered();
            await new Promise((_, reject) =>
              context.abortSignal!.addEventListener(
                "abort",
                () => reject(context.abortSignal!.reason),
                { once: true },
              ),
            );
          }
          return { output: content };
        },
      },
    ];
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: "const first = await tools.effect({}); await tools.read({}); await tools.effect({}); text(first + ':continued');",
            }),
          ],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("Recovered."),
    ]);
    const codemode = createCarmelCodemode({
      beforeCall() {
        admissions++;
      },
    });
    const options = { ...models, tools: [...tools, ...codemode.tools!], extensions: [codemode] };
    const first = await openTestHarness(sessionId, options);
    await first.session.conversation.submit({ type: "input", content: "Run" }, first.context);
    await waiting;
    assert.equal(effects, 1);
    assert.equal(admissions, 2);
    const pending = await first.session.native.inspect(first.context);
    assert.ok(
      pending.tasks.some(
        (task) =>
          task.record.kind === "pi.tool" &&
          (task.record.input as { kind?: string }).kind === "nested",
      ),
    );
    await first.close();
    const resumed = await openTestHarness(sessionId, options);
    try {
      await resumed.lane.resume(resumed.context);
      assert.equal(effects, 2, "the finished effect is reused; only the later effect runs");
      assert.equal(reads, 2, "only the interrupted safe read reruns");
      assert.equal(admissions, 3, "reattaching native calls does not consume admission again");
      const messages = (await resumed.branch()).flatMap((entry) =>
        entry.type === "message" ? [entry.message] : [],
      );
      assert.equal(messages.filter((message) => message.role === "user").length, 1);
      const results = messages.filter((message) => message.role === "toolResult");
      assert.equal(results.length, 1, "nested results stay out of the transcript");
      assert.equal(results[0]!.isError, false);
      assert.match(JSON.stringify(results[0]!.content), /done:continued/);
      assert.equal(await resumed.lane.hasPending(resumed.context), false);
    } finally {
      await resumed.close();
    }
  },
);

test("native Codemode store survives calls and reopen, commits only successful writes, and forks as of the selected entry", async () => {
  const { sessionId } = createSession();
  const { faux, ...models } = fauxHarnessModels();
  const options = { ...models, tools: [...createCarmelCodemode().tools!] };
  let pi = await openTestHarness(sessionId, options);
  async function run(harness: TestHarness, code: string) {
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Done."),
    ]);
    await harness.lane.prompt("Run", undefined, harness.context);
  }
  try {
    await run(pi, "store('value', { count: 1 }); text(load('value')); ");
    const forkPoint = (await pi.branch()).at(-1)!.id;
    await run(pi, "store('value', { count: 2 });");
    await pi.close();
    pi = await openTestHarness(sessionId, options);
    assert.deepEqual(
      (await pi.session.native.snapshot(CodemodeStoreDoc, pi.session.conversation.id, pi.context))
        ?.values,
      { value: { count: 2 } },
    );
    await run(pi, "store('value', { count: 3 }); throw new Error('failed write');");
    assert.deepEqual(
      (await pi.session.native.snapshot(CodemodeStoreDoc, pi.session.conversation.id, pi.context))
        ?.values,
      { value: { count: 2 } },
    );
    await pi.lane.navigateTree(forkPoint, { summarize: false }, pi.context);
    await run(pi, "text(load('value')); ");
    const results = (await pi.branch()).flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    assert.deepEqual(results.at(-1)!.content.at(-1), { type: "text", text: '{"count":1}' });
    assert.deepEqual(
      (await pi.session.native.snapshot(CodemodeStoreDoc, pi.session.conversation.id, pi.context))
        ?.values,
      { value: { count: 1 } },
    );
  } finally {
    await pi.close();
  }
});

test(
  "native Codemode preserves its original deadline across a restart and admits no later effect",
  { timeout: 10_000 },
  async (t) => {
    const { sessionId } = createSession();
    const { faux, ...models } = fauxHarnessModels();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let effects = 0,
      reads = 0;
    const tools: ToolRegistration[] = [
      {
        name: "effect",
        description: "External effect",
        parameters,
        async execute() {
          effects++;
          return { output: content };
        },
      },
      {
        name: "read",
        description: "Replay-safe lookup",
        parameters,
        replay: "safe",
        async execute(_args, _api, context) {
          if (++reads === 1) {
            entered();
            await new Promise((_, reject) =>
              context.abortSignal!.addEventListener(
                "abort",
                () => reject(context.abortSignal!.reason),
                { once: true },
              ),
            );
          }
          return { output: content };
        },
      },
    ];
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("codemode", { code: "await tools.read({}); await tools.effect({});" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("Deadline handled."),
    ]);
    const codemode = createCarmelCodemode({ timeoutMs: 1_000 });
    const options = { ...models, tools: [...tools, ...codemode.tools!], extensions: [codemode] };
    const first = await openTestHarness(sessionId, options);
    await first.session.conversation.submit({ type: "input", content: "Run" }, first.context);
    await waiting;
    await first.close();
    const expired = Date.now() + 5_000;
    t.mock.method(Date, "now", () => expired);
    const resumed = await openTestHarness(sessionId, options);
    try {
      await resumed.lane.resume(resumed.context);
      assert.equal(effects, 0);
      const results = (await resumed.branch()).flatMap((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
      );
      assert.equal(results[0]!.isError, true);
      assert.match(JSON.stringify(results[0]!.content), /deadline passed/);
    } finally {
      await resumed.close();
    }
  },
);
