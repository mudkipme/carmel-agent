import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseBrowserInput, parseBrowserOutput } from "./browser-protocol.ts";

test("browser input accepts bounded input but never arbitrary commands or javascript URLs", () => {
  for (const message of [
    { type: "command", args: ["eval", "steal()"] },
    { type: "navigate", url: "javascript:alert(1)" },
    { type: "navigate", url: "file:///etc/passwd" },
    { type: "input_mouse", eventType: "mousePressed", x: -1, y: 20 },
    { type: "input_keyboard", eventType: "char", text: "a".repeat(4097) },
    { type: "tab", id: "--help".repeat(50) },
  ])
    assert.equal(parseBrowserInput(JSON.stringify(message)), undefined);
  assert.equal(parseBrowserInput("{"), undefined);
  assert.deepEqual(parseBrowserInput('{"type":"take_control","controller":"forged"}'), {
    type: "take_control",
  });
  assert.deepEqual(parseBrowserInput('{"type":"navigate","url":"https://example.com/login"}'), {
    type: "navigate",
    url: "https://example.com/login",
  });
  assert.ok(parseBrowserInput('{"type":"input_keyboard","eventType":"char","text":"你好"}'));
});

test("clipboard protocol accepts bounded text and rejects missing payloads and unsolicited operations", () => {
  const requestId = randomUUID();
  const paste = { type: "clipboard", requestId, operation: "paste", text: "你好 🌍\nline two" };
  assert.deepEqual(parseBrowserInput(JSON.stringify(paste)), paste);
  assert.ok(parseBrowserInput(JSON.stringify({ ...paste, text: "\0".repeat(16384) })));
  for (const invalid of [
    { ...paste, text: undefined },
    { ...paste, text: "x".repeat(16385) },
    { ...paste, operation: "read" },
    { ...paste, requestId: "" },
    { ...paste, operation: "copy" },
  ])
    assert.equal(parseBrowserInput(JSON.stringify(invalid)), undefined);
  assert.ok(parseBrowserInput(JSON.stringify({ type: "clipboard", requestId, operation: "copy" })));
  assert.equal(
    parseBrowserOutput({ type: "clipboard_result", requestId, text: "x".repeat(16385) }),
    undefined,
  );
});

test("sandbox output cannot forge ownership or inject unknown messages", () => {
  assert.equal(
    parseBrowserOutput({
      type: "control",
      hasControl: true,
      state: { phase: "human", revision: 1 },
    }),
    undefined,
  );
  assert.equal(parseBrowserOutput({ type: "console", text: "private console message" }), undefined);
  assert.deepEqual(
    parseBrowserOutput({ type: "status", connected: true, secret: "not forwarded" }),
    { type: "status", connected: true },
  );
});
