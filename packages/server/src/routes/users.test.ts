import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { createAuthRoutes } from "./auth.ts";
import { createUserRoutes } from "./users.ts";

migrate();

function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/api/*", requireAuth);
  app.route("/api/auth", createAuthRoutes());
  app.route("/api", createUserRoutes());
  app.get("/api/me", (c) => c.json({ id: c.get("user").id, role: c.get("user").role }));
  return app;
}

const json = { "content-type": "application/json" };
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

test("first-run setup claims the seeded placeholder as admin and then blocks re-setup", async () => {
  const app = buildApp();
  const timestamp = now();
  // Seed a passwordless placeholder, as a fresh database does.
  db.insert(users)
    .values({ id: "user_self", name: "Local User", email: "user@local", role: "user", createdAt: timestamp, updatedAt: timestamp })
    .run();

  assert.deepEqual(await (await app.request("/api/auth/status")).json(), { needsSetup: true });

  const setup = await app.request("/api/auth/setup", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "admin", password: "adminpass1", email: "admin@example.test" }),
  });
  assert.equal(setup.status, 201);

  // The placeholder row was claimed (same id), now an admin with a password.
  const claimed = db.select().from(users).where(eq(users.id, "user_self")).get();
  assert.equal(claimed?.username, "admin");
  assert.equal(claimed?.role, "admin");
  assert.ok(claimed?.passwordHash);

  assert.deepEqual(await (await app.request("/api/auth/status")).json(), { needsSetup: false });

  const again = await app.request("/api/auth/setup", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "intruder", password: "intruderpw" }),
  });
  assert.equal(again.status, 403);
});

test("admin can list and create users; non-admins are forbidden", async () => {
  const app = buildApp();
  const adminCookie = cookieOf(
    await app.request("/api/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "admin", password: "adminpass1" }),
    }),
  );

  const list = await app.request("/api/users", { headers: { cookie: adminCookie } });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).some((user: { username?: string }) => user.username === "admin"));

  const created = await app.request("/api/users", {
    method: "POST",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ username: "bob", email: "bob@example.test", password: "bobpassword", role: "user" }),
  });
  assert.equal(created.status, 201);

  const bobCookie = cookieOf(
    await app.request("/api/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "bob", password: "bobpassword" }),
    }),
  );

  assert.equal((await app.request("/api/users", { headers: { cookie: bobCookie } })).status, 403);
  assert.equal(
    (
      await app.request("/api/users", {
        method: "POST",
        headers: { ...json, cookie: bobCookie },
        body: JSON.stringify({ username: "eve", email: "eve@x.test", password: "evepassword" }),
      })
    ).status,
    403,
  );
});

test("a user can change their own email but cannot escalate their own role", async () => {
  const app = buildApp();
  const bobCookie = cookieOf(
    await app.request("/api/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "bob", password: "bobpassword" }),
    }),
  );
  const me = await (await app.request("/api/me", { headers: { cookie: bobCookie } })).json();

  const updated = await app.request(`/api/users/${me.id}`, {
    method: "PUT",
    headers: { ...json, cookie: bobCookie },
    body: JSON.stringify({ id: me.id, name: "Bob", email: "bob2@example.test", role: "admin" }),
  });
  assert.equal(updated.status, 200);
  const body = await updated.json();
  assert.equal(body.email, "bob2@example.test");
  assert.equal(body.role, "user"); // role from the payload is ignored
});
