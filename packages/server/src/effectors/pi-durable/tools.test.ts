import { executeNativeTool } from "../testing/tools.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createSession } from "../../test-support.ts";
import { initialize } from "../../db/index.ts";
import { fauxHarnessModels, openTestHarness } from "../testing/pi-harness.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT, withAbortSignal, type ExecutionEnv } from "./index.ts";
import { createBashTool } from "./tools.ts";
import { executeNativeCodemode } from "../testing/codemode.ts";

initialize();

// Only shell transport is replaced; the native bash tool and Durable task machinery execute normally.
function shell(chunks: string[], exitCode = 0): ExecutionEnv {
  return {
    cwd: "/tmp",
    async exec(_command, options, context) {
      for (const chunk of chunks)
        options?.onOutput?.(chunk, context, { stream: "stdout", skipped: undefined });
      return { ok: true, value: { exitCode, spillPath: "/tmp/bash-full-output.txt" } };
    },
  } as ExecutionEnv;
}

test("nonzero nested bash returns structured shell output, its spill path, and exit code", async () => {
  const result = await executeNativeCodemode(
    [createBashTool()],
    "const result = await tools.bash({command: 'test'}); text(result);",
    {
      env: shell(["test suite started\n", "FAIL: expected 42, got 0\n"], 1),
    },
  );
  const text = JSON.stringify(result.content);
  assert.match(text, /test suite started/);
  assert.match(text, /FAIL: expected 42, got 0/);
  assert.match(text, /bash-full-output.txt/);
  assert.match(text, /exitCode.*1/);
});

test("native bash exposes its retained output and exit status as structured content", async () => {
  for (const exitCode of [0, 1]) {
    const result = await executeNativeTool(
      createBashTool(),
      { command: "test" },
      shell(["command output\n"], exitCode),
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(result.structuredOutput, {
      output: "command output\n",
      truncated: false,
      fullOutputPath: "/tmp/bash-full-output.txt",
      exitCode,
    });
    assert.equal(result.isError ?? false, exitCode !== 0);
    if (exitCode !== 0)
      assert.ok(result.diagnostics?.some((diagnostic) => diagnostic.code === "exit_code"));
  }
});

test("Durable receives explicit native output and validates structured values", async () => {
  const { sessionId } = createSession();
  const { faux, ...models } = fauxHarnessModels();
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("answer", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Done"),
  ]);
  const pi = await openTestHarness(sessionId, {
    ...models,
    tools: [
      {
        name: "answer",
        description: "Return a structured answer",
        parameters: { type: "object", properties: {} },
        structuredOutputSchema: {
          type: "object",
          properties: { answer: { type: "integer" } },
          required: ["answer"],
        },
        async execute() {
          return {
            output: [{ type: "text", text: "The answer is 42" }],
            structuredOutput: { answer: 42 },
          };
        },
      },
    ],
  });
  try {
    await pi.lane.prompt("Answer", undefined, pi.context);
    const results = (await pi.branch()).flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.content, [{ type: "text", text: "The answer is 42" }]);
    assert.equal(results[0]!.isError, false);
    const native = await pi.session.conversation.entries({}, 100, undefined, pi.context);
    const result = native.items.find((entry) => entry.kind === "pi.tool-result");
    assert.ok(result);
    assert.deepEqual((result.data as { diagnostics?: unknown }).diagnostics, []);
  } finally {
    await pi.close();
  }
});

test("nested bash preserves chunk boundaries and UTF-8 while bounding the tail by bytes and lines", async () => {
  const cases = [
    { chunks: ["🙂", "\nnext\n"], expected: "🙂\nnext\n" },
    { chunks: ["🙂".repeat(20_000), "\nlast\n"], suffix: "last\n" },
    {
      chunks: Array.from({ length: 3_000 }, (_, i) => `line ${i}\n`),
      suffix: "line 2998\nline 2999\n",
    },
  ];
  for (const { chunks, expected, suffix } of cases) {
    const result = await executeNativeTool(
      createBashTool(),
      { command: "test" },
      shell(chunks),
      BACKGROUND_CONTEXT,
    );
    const output = result.output?.[0];
    assert.ok(output?.type === "text");
    assert.ok(Buffer.byteLength(output.text) <= DEFAULT_MAX_BYTES);
    assert.ok(output.text.trimEnd().split("\n").length <= DEFAULT_MAX_LINES);
    assert.ok(!output.text.includes("�"));
    if (expected) assert.equal(output.text, expected);
    if (suffix) {
      assert.ok(output.text.endsWith(suffix));
      assert.match(JSON.stringify(result.output), /Output truncated/);
    }
  }
});

test("nested bash cancellation propagates rather than becoming an ordinary tool error", async () => {
  const controller = new AbortController();
  const context = shell([]);
  context.exec = async () => {
    controller.abort(new Error("Stopped by user"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    () =>
      executeNativeTool(
        createBashTool(),
        { command: "test" },
        context,
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      ),
    /Stopped by user/,
  );
});
