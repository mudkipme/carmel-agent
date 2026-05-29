import test from "node:test";
import assert from "node:assert/strict";
import { protectJsonSecret, protectSecret, revealJsonSecret, revealSecret } from "./security.ts";

test("secrets pass through when CARMEL_SECRET_KEY is not configured", () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  delete process.env.CARMEL_SECRET_KEY;
  try {
    assert.equal(protectSecret("plain"), "plain");
    assert.equal(revealSecret("plain"), "plain");
  } finally {
    restoreSecret(previous);
  }
});

test("secrets encrypt and decrypt when CARMEL_SECRET_KEY is configured", () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "test-secret";
  try {
    const encrypted = protectSecret("secret-value");
    assert.notEqual(encrypted, "secret-value");
    assert.match(encrypted ?? "", /^enc:v1:/);
    assert.equal(revealSecret(encrypted), "secret-value");
  } finally {
    restoreSecret(previous);
  }
});

test("json secrets encrypt and decrypt when CARMEL_SECRET_KEY is configured", () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "test-secret";
  try {
    const encrypted = protectJsonSecret({ type: "api_key", key: "secret-value" });
    assert.deepEqual(revealJsonSecret(encrypted), { type: "api_key", key: "secret-value" });
  } finally {
    restoreSecret(previous);
  }
});

function restoreSecret(value: string | undefined) {
  if (value === undefined) {
    delete process.env.CARMEL_SECRET_KEY;
    return;
  }
  process.env.CARMEL_SECRET_KEY = value;
}
