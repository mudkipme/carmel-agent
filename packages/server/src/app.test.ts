import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.ts";
import { migrate } from "./db/index.ts";

migrate();

test("responses carry the CSP and content-type-options security headers", async () => {
  const res = await createApp().request("/api/health");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  // CORP is intentionally disabled so the cross-origin web client is not blocked.
  assert.equal(res.headers.get("cross-origin-resource-policy"), null);
});

test("cross-origin mutating requests are rejected", async () => {
  const res = await createApp().request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.test" },
    body: JSON.stringify({ username: "x", password: "y" }),
  });
  assert.equal(res.status, 403);
});

test("same-origin and configured-origin mutating requests are allowed through", async () => {
  // No Origin header (same-origin / non-browser) is allowed; the request reaches
  // the handler and fails auth instead of being blocked as cross-origin.
  const res = await createApp().request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "missing", password: "missing" }),
  });
  assert.equal(res.status, 401);
});
