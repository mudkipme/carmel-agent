import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  hashPassword,
  readSessionCookie,
  requireAuth,
  verifyPassword,
  type AuthVariables,
} from "./auth.ts";
import { db, initialize } from "./db/index.ts";
import { users } from "./db/schema.ts";
import { id, now } from "./db/seed.ts";
import { createAuthRoutes } from "./routes/auth.ts";

initialize();

// A minimal app that mounts the real auth route plus an authenticated probe.
// (We avoid createApp() because its transitive imports use TS parameter
// properties that Node's strip-only test loader rejects.)
function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/api/*", requireAuth);
  app.route("/api/auth", createAuthRoutes());
  app.get("/api/me", (c) => c.json({ id: c.get("user").id }));
  return app;
}

test("verifyPassword accepts the correct password and rejects wrong or malformed hashes", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
  assert.equal(await verifyPassword("anything", "scrypt$onlytwoparts"), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("hashPassword salts: the same password hashes differently but both verify", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

test("login issues a session cookie that authorizes protected routes; otherwise 401", async () => {
  const username = `tester_${id("u")}`;
  const userId = id("user");
  const timestamp = now();
  db.insert(users)
    .values({
      id: userId,
      username,
      name: "Tester",
      email: `${userId}@test.local`,
      passwordHash: await hashPassword("s3cret-pw"),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  const app = buildApp();
  const jsonHeaders = { "content-type": "application/json" };

  // Wrong password is rejected.
  const denied = await app.request("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ username, password: "nope" }),
  });
  assert.equal(denied.status, 401);

  // Correct password issues a session cookie.
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ username, password: "s3cret-pw" }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^carmel_session=/);

  // The cookie authorizes a protected route; absent/invalid cookies do not.
  const authed = await app.request("/api/me", { headers: { cookie } });
  assert.equal(authed.status, 200);
  assert.deepEqual(await authed.json(), { id: userId });

  assert.equal((await app.request("/api/me")).status, 401);
  assert.equal(
    (await app.request("/api/me", { headers: { cookie: "carmel_session=bogus" } })).status,
    401,
  );
});

test("readSessionCookie finds the session in a raw Cookie header", () => {
  // The terminal WebSocket upgrade happens below hono, so it parses the header
  // itself rather than going through hono's cookie helper.
  assert.equal(readSessionCookie("carmel_session=abc123"), "abc123");
  assert.equal(readSessionCookie("theme=dark; carmel_session=abc123; other=1"), "abc123");
  assert.equal(readSessionCookie("  carmel_session = abc123 "), "abc123");
  assert.equal(readSessionCookie("carmel_session=a%2Fb"), "a/b");
});

test("readSessionCookie ignores absent, empty, and lookalike cookie names", () => {
  assert.equal(readSessionCookie(undefined), undefined);
  assert.equal(readSessionCookie(""), undefined);
  assert.equal(readSessionCookie("theme=dark"), undefined);
  // A prefix match here would authenticate the wrong cookie.
  assert.equal(readSessionCookie("xcarmel_session=abc123"), undefined);
  assert.equal(readSessionCookie("carmel_session_backup=abc123"), undefined);
});
