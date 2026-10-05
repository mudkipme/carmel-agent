import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { agents, modelRefs, sessions, users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { createAgent, createModelRef, createSession } from "../test-support.ts";
import { createAuthRoutes } from "./auth.ts";
import { createProviderConfigRoutes } from "./provider-configs.ts";
import { createUserRoutes } from "./users.ts";

initialize();

function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/api/*", requireAuth);
  app.route("/api/auth", createAuthRoutes());
  app.route("/api", createUserRoutes());
  app.route("/api", createProviderConfigRoutes());
  app.get("/api/me", (c) => c.json({ id: c.get("user").id, role: c.get("user").role }));
  return app;
}

async function loginCookie(app: ReturnType<typeof buildApp>, username: string, password: string) {
  return cookieOf(
    await app.request("/api/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username, password }),
    }),
  );
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

  assert.deepEqual(await (await app.request("/api/auth/status")).json(), { needsSetup: true, passwordLogin: true });

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

  assert.deepEqual(await (await app.request("/api/auth/status")).json(), { needsSetup: false, passwordLogin: true });

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

test("self profile update rejects server-owned fields and accepts its narrow command DTO", async () => {
  const app = buildApp();
  const bobCookie = await loginCookie(app, "bob", "bobpassword");
  const me = await (await app.request("/api/me", { headers: { cookie: bobCookie } })).json();

  const invalid = await app.request(`/api/users/${me.id}`, {
    method: "PUT",
    headers: { ...json, cookie: bobCookie },
    body: JSON.stringify({ id: me.id, name: "Bob", email: "bob-via-put@example.test", role: "admin" }),
  });
  assert.equal(invalid.status, 400);

  const updated = await app.request(`/api/users/${me.id}`, {
    method: "PUT",
    headers: { ...json, cookie: bobCookie },
    body: JSON.stringify({ name: "Bob" }),
  });
  assert.equal(updated.status, 200);
  const body = await updated.json();
  assert.equal(body.email, "bob@example.test"); // email unchanged: PUT does not touch it
  assert.equal(body.role, "user"); // role from the payload is ignored
});

test("account update requires the current password to change email; new password is optional", async () => {
  const app = buildApp();
  const adminCookie = await loginCookie(app, "admin", "adminpass1");
  await app.request("/api/users", {
    method: "POST",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ username: "dave", email: "dave@example.test", password: "davepassword" }),
  });
  const daveCookie = await loginCookie(app, "dave", "davepassword");

  // Wrong current password is rejected.
  const wrong = await app.request("/api/auth/account", {
    method: "POST",
    headers: { ...json, cookie: daveCookie },
    body: JSON.stringify({ currentPassword: "nope", email: "dave2@example.test" }),
  });
  assert.equal(wrong.status, 400);

  // Correct password, email only: email changes and the password still works.
  const emailOnly = await app.request("/api/auth/account", {
    method: "POST",
    headers: { ...json, cookie: daveCookie },
    body: JSON.stringify({ currentPassword: "davepassword", email: "dave2@example.test" }),
  });
  assert.equal(emailOnly.status, 200);
  assert.equal((await emailOnly.json()).email, "dave2@example.test");
  assert.match(await loginCookie(app, "dave", "davepassword"), /^carmel_session=/);

  // Email plus a new password: the new password works afterward.
  const both = await app.request("/api/auth/account", {
    method: "POST",
    headers: { ...json, cookie: daveCookie },
    body: JSON.stringify({ currentPassword: "davepassword", email: "dave3@example.test", newPassword: "dave-new-pw" }),
  });
  assert.equal(both.status, 200);
  assert.match(await loginCookie(app, "dave", "dave-new-pw"), /^carmel_session=/);
});

test("admin can change another user's role but not their own", async () => {
  const app = buildApp();
  const adminCookie = await loginCookie(app, "admin", "adminpass1");
  const adminId = (await (await app.request("/api/me", { headers: { cookie: adminCookie } })).json()).id;
  const bobId = (db.select().from(users).where(eq(users.username, "bob")).get())!.id;

  const promote = await app.request(`/api/users/${bobId}`, {
    method: "PATCH",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promote.status, 200);
  assert.equal((await promote.json()).role, "admin");

  // demote back, then verify self-change is blocked
  await app.request(`/api/users/${bobId}`, {
    method: "PATCH",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ role: "user" }),
  });
  const ownRole = await app.request(`/api/users/${adminId}`, {
    method: "PATCH",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ role: "user" }),
  });
  assert.equal(ownRole.status, 400);
});

test("admin can delete another user; their agents/models transfer and sessions are removed", async () => {
  const app = buildApp();
  const adminCookie = await loginCookie(app, "admin", "adminpass1");
  const adminId = (await (await app.request("/api/me", { headers: { cookie: adminCookie } })).json()).id;

  // A user that owns an agent, a model, and a session.
  const created = await app.request("/api/users", {
    method: "POST",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ username: "carol", email: "carol@example.test", password: "carolpassword" }),
  });
  const carolId = (await created.json()).id;
  const { sessionId, modelRefId, agentId } = createSession({ userId: carolId });
  const ownedModel = createModelRef({ ownerUserId: carolId });
  const ownedAgent = createAgent({ ownerUserId: carolId, defaultModelRefId: modelRefId });

  const cannotDeleteSelf = await app.request(`/api/users/${adminId}`, { method: "DELETE", headers: { cookie: adminCookie } });
  assert.equal(cannotDeleteSelf.status, 400);

  const deleted = await app.request(`/api/users/${carolId}`, { method: "DELETE", headers: { cookie: adminCookie } });
  assert.equal(deleted.status, 200);

  assert.equal(db.select().from(users).where(eq(users.id, carolId)).get(), undefined);
  assert.equal(db.select().from(sessions).where(eq(sessions.id, sessionId)).get(), undefined);
  assert.equal(db.select().from(agents).where(eq(agents.id, agentId)).get()?.ownerUserId, adminId);
  assert.equal(db.select().from(agents).where(eq(agents.id, ownedAgent)).get()?.ownerUserId, adminId);
  assert.equal(db.select().from(modelRefs).where(eq(modelRefs.id, ownedModel)).get()?.ownerUserId, adminId);
});

test("provider configs are admin-managed: non-admins cannot create or delete them", async () => {
  const app = buildApp();
  const adminCookie = await loginCookie(app, "admin", "adminpass1");
  const bobCookie = await loginCookie(app, "bob", "bobpassword");
  const providerBody = JSON.stringify({
    label: "OpenAI",
    provider: "openai",
    authType: "api_key",
    apiKey: "sk-test",
  });

  assert.equal(
    (await app.request("/api/provider-configs/p_admin", { method: "PUT", headers: { ...json, cookie: adminCookie }, body: providerBody })).status,
    200,
  );
  assert.equal(
    (await app.request("/api/provider-configs/p_bob", { method: "PUT", headers: { ...json, cookie: bobCookie }, body: providerBody })).status,
    403,
  );
  assert.equal(
    (await app.request("/api/provider-configs/p_admin", { method: "DELETE", headers: { cookie: bobCookie } })).status,
    403,
  );
});

test("admin can reset another user's password; non-admins cannot, and the new password works", async () => {
  const app = buildApp();
  const adminCookie = await loginCookie(app, "admin", "adminpass1");
  const bobCookie = await loginCookie(app, "bob", "bobpassword");
  const bobId = (db.select().from(users).where(eq(users.username, "bob")).get())!.id;

  // A non-admin cannot reset passwords.
  assert.equal(
    (
      await app.request(`/api/users/${bobId}/password`, {
        method: "POST",
        headers: { ...json, cookie: bobCookie },
        body: JSON.stringify({ password: "hijacked-pw" }),
      })
    ).status,
    403,
  );

  // The admin resets bob's password; the new password works, the old one does not.
  const reset = await app.request(`/api/users/${bobId}/password`, {
    method: "POST",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ password: "bob-new-password" }),
  });
  assert.equal(reset.status, 200);
  assert.match(await loginCookie(app, "bob", "bob-new-password"), /^carmel_session=/);
  assert.equal(await loginCookie(app, "bob", "bobpassword"), "");
});
