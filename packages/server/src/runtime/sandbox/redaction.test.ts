import test from "node:test";
import assert from "node:assert/strict";
import { createSecretRedactor } from "./redaction.ts";

const drain = (secrets: Array<{ name: string; value: string }>, chunks: string[]) => {
  const redactor = createSecretRedactor(secrets);
  return chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.flush();
};

test("a secret contained in one chunk is replaced by its placeholder", () => {
  const output = drain(
    [{ name: "GITHUB_TOKEN", value: "ghp_supersecretvalue" }],
    ["GITHUB_TOKEN=ghp_supersecretvalue\n"],
  );
  assert.equal(output, "GITHUB_TOKEN=[redacted:GITHUB_TOKEN]\n");
});

test("a secret split across chunk boundaries is still replaced", () => {
  const secret = "ghp_supersecretvalue";
  const chunks = [...`prefix ${secret} suffix`].map((character) => character);
  assert.equal(
    drain([{ name: "GITHUB_TOKEN", value: secret }], chunks),
    "prefix [redacted:GITHUB_TOKEN] suffix",
  );
});

test("output is released rather than held indefinitely", () => {
  const redactor = createSecretRedactor([{ name: "TOKEN", value: "abcd" }]);
  // Only `value.length - 1` characters may be withheld against a future match.
  assert.equal(redactor.push("0123456789"), "0123456");
  assert.equal(redactor.flush(), "789");
});

test("the longest secret wins when one value contains another", () => {
  const output = drain(
    [
      { name: "SHORT", value: "secretvalue" },
      { name: "LONG", value: "secretvalue-extended" },
    ],
    ["token=secretvalue-extended\n"],
  );
  assert.equal(output, "token=[redacted:LONG]\n");
});

test("values too short to redact safely are left alone", () => {
  const output = drain([{ name: "TINY", value: "ab" }], ["a table of absolute values\n"]);
  assert.equal(output, "a table of absolute values\n");
});

test("with no redactable secrets nothing is buffered", () => {
  const redactor = createSecretRedactor([]);
  assert.equal(redactor.push("streamed immediately"), "streamed immediately");
  assert.equal(redactor.flush(), "");
});

test("stdout and stderr redactors do not share held-back text", () => {
  const secrets = [{ name: "TOKEN", value: "ghp_secretvalue" }];
  const stdout = createSecretRedactor(secrets);
  const stderr = createSecretRedactor(secrets);
  stdout.push("out ghp_secret");
  stderr.push("err ghp_secret");
  assert.equal(stdout.push("value\n") + stdout.flush(), "out [redacted:TOKEN]\n");
  assert.equal(stderr.push("value\n") + stderr.flush(), "err [redacted:TOKEN]\n");
});
