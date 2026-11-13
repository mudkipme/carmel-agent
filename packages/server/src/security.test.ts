import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedCorsOrigin,
  incomingRequestHost,
  incomingRequestUrl,
  isAllowedBrowserOrigin,
  protectJsonSecret,
  protectSecret,
  revealJsonSecret,
  revealSecret,
} from "./security.ts";

test("browser origin policy allows default dev origins", () => {
  const previous = process.env.CARMEL_ALLOWED_ORIGINS;
  delete process.env.CARMEL_ALLOWED_ORIGINS;
  try {
    assert.equal(allowedCorsOrigin("http://localhost:5173"), "http://localhost:5173");
    assert.equal(isAllowedBrowserOrigin("http://127.0.0.1:5173"), true);
  } finally {
    restoreAllowedOrigins(previous);
  }
});

test("browser origin policy allows configured origins", () => {
  const previous = process.env.CARMEL_ALLOWED_ORIGINS;
  process.env.CARMEL_ALLOWED_ORIGINS = "https://app.example.test, https://admin.example.test/";
  try {
    assert.equal(allowedCorsOrigin("https://app.example.test"), "https://app.example.test");
    assert.equal(allowedCorsOrigin("https://admin.example.test"), "https://admin.example.test");
  } finally {
    restoreAllowedOrigins(previous);
  }
});

test("browser origin policy allows same request host", () => {
  assert.equal(
    allowedCorsOrigin("https://api.example.test", "api.example.test"),
    "https://api.example.test",
  );
});

test("browser origin policy rejects unknown or invalid origins", () => {
  const previous = process.env.CARMEL_ALLOWED_ORIGINS;
  process.env.CARMEL_ALLOWED_ORIGINS = "not a url";
  try {
    assert.equal(allowedCorsOrigin("https://evil.example.test"), undefined);
    assert.equal(isAllowedBrowserOrigin("not a url"), false);
  } finally {
    restoreAllowedOrigins(previous);
  }
});

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

test("incomingRequestHost honours x-forwarded-host only from a trusted proxy", () => {
  const previous = process.env.CARMEL_TRUSTED_PROXY;
  process.env.CARMEL_TRUSTED_PROXY = "10.0.0.5";
  try {
    const untrusted = {
      headers: { host: "local.example", "x-forwarded-host": "evil.example" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    assert.equal(incomingRequestHost(untrusted), "local.example");

    const trusted = {
      headers: { host: "127.0.0.1:8797", "x-forwarded-host": "app.example.test" },
      socket: { remoteAddress: "::ffff:10.0.0.5" },
    };
    assert.equal(incomingRequestHost(trusted), "app.example.test");
  } finally {
    if (previous === undefined) delete process.env.CARMEL_TRUSTED_PROXY;
    else process.env.CARMEL_TRUSTED_PROXY = previous;
  }
});

test("incomingRequestUrl returns undefined for malformed URLs", () => {
  assert.equal(incomingRequestUrl({ url: "http://[invalid" }), undefined);
  assert.equal(incomingRequestUrl({ url: "/api/updates?a=1" })?.pathname, "/api/updates");
});

function restoreSecret(value: string | undefined) {
  if (value === undefined) {
    delete process.env.CARMEL_SECRET_KEY;
    return;
  }
  process.env.CARMEL_SECRET_KEY = value;
}

function restoreAllowedOrigins(value: string | undefined) {
  if (value === undefined) {
    delete process.env.CARMEL_ALLOWED_ORIGINS;
    return;
  }
  process.env.CARMEL_ALLOWED_ORIGINS = value;
}
