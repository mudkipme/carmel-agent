import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { createCodemodeTool } from "../../runtime/codemode-tool.ts";
import { BACKGROUND_CONTEXT, withAbortSignal, type ExecutionToolContext } from "./index.ts";
import { createBashTool } from "./tools.ts";

const invocation = { invocationId: "call", operationId: "operation", turnId: "turn" };

// Only shell transport is replaced; the native bash tool and both adapters execute normally.
function shell(chunks: string[], exitCode = 0): ExecutionToolContext {
  return {
    env: {
      cwd: "/tmp",
      async exec(_command, options, context) {
        for (const chunk of chunks)
          options?.onOutput?.(chunk, context, { stream: "stdout", skipped: undefined });
        return { ok: true, value: { exitCode, spillPath: "/tmp/bash-full-output.txt" } };
      },
    } as ExecutionToolContext["env"],
  };
}

test("failed nested bash retains shell output, its spill diagnostic, and the exit error", async () => {
  const tool = createCodemodeTool([createBashTool()]);
  const result = await tool.execute(
    "codemode",
    { code: "try { await tools.bash({command: 'test'}); } catch (error) { text(error.message); }" },
    () => {},
    shell(["test suite started\n", "FAIL: expected 42, got 0\n"], 1),
    invocation,
    BACKGROUND_CONTEXT,
  );
  const text = JSON.stringify(result.content);
  assert.match(text, /test suite started/);
  assert.match(text, /FAIL: expected 42, got 0/);
  assert.match(text, /Full output: \/tmp\/bash-full-output.txt/);
  assert.match(text, /Command exited with code 1/);
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
    const result = await createBashTool().execute(
      "bash",
      { command: "test" },
      () => {},
      shell(chunks),
      invocation,
      BACKGROUND_CONTEXT,
    );
    const output = result.content[0];
    assert.ok(output?.type === "text");
    assert.ok(Buffer.byteLength(output.text) <= DEFAULT_MAX_BYTES);
    assert.ok(output.text.trimEnd().split("\n").length <= DEFAULT_MAX_LINES);
    assert.ok(!output.text.includes("�"));
    if (expected) assert.equal(output.text, expected);
    if (suffix) {
      assert.ok(output.text.endsWith(suffix));
      assert.match(JSON.stringify(result.content), /Output truncated/);
    }
  }
});

test("nested bash cancellation propagates rather than becoming an ordinary tool error", async () => {
  const controller = new AbortController();
  const context = shell([]);
  context.env.exec = async () => {
    controller.abort(new Error("Stopped by user"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    () =>
      createBashTool().execute(
        "bash",
        { command: "test" },
        () => {},
        context,
        invocation,
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      ),
    /Stopped by user/,
  );
});
