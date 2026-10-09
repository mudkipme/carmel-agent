import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { browserBridgeScript } from "./browser-bridge.ts";

async function startupFailure(
  error: { code?: string; killed?: boolean } | null,
  stdout: string,
  stderr = "",
) {
  const messages: Array<{ type: string; message?: string }> = [];
  await new Promise<void>((resolve) => {
    runInNewContext(browserBridgeScript, {
      require(name: string) {
        if (name === "node:readline") return { createInterface: () => ({ on() {} }) };
        if (name === "node:child_process")
          return {
            execFile: (
              _binary: string,
              _args: string[],
              _options: unknown,
              callback: (...args: unknown[]) => void,
            ) => {
              queueMicrotask(() => callback(error, stdout, stderr));
              return { kill() {} };
            },
          };
        throw new Error(`Unexpected import: ${name}`);
      },
      process: {
        stdin: { on() {} },
        stdout: {
          on() {},
          write(line: string) {
            messages.push(JSON.parse(line));
          },
        },
        on() {},
        exit: resolve,
      },
      clearInterval,
    });
  });
  return messages.find((message) => message.type === "error")?.message ?? "";
}

test("profile locks have an actionable startup error instead of an upgrade recommendation", async () => {
  const message = await startupFailure(
    {},
    JSON.stringify({
      success: false,
      error:
        "The profile appears to be in use by another Chromium process (63) on another computer (old-container). private page data",
    }),
  );
  assert.match(message, /profile is locked/);
  assert.doesNotMatch(message, /Rebuild|private page data|old-container/);
});

test("missing binaries, timeouts, and other startup failures have distinct safe errors", async () => {
  assert.match(await startupFailure({ code: "ENOENT" }, ""), /missing compatible browser tooling/);
  assert.match(await startupFailure({ killed: true }, ""), /timed out \(stream status\)/);
  const message = await startupFailure({}, "", "confidential stderr");
  assert.match(message, /command failed \(stream status\)/);
  assert.doesNotMatch(message, /confidential|Rebuild/);
});
