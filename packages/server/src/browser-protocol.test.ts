import test from "node:test";
import assert from "node:assert/strict";
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
