import { createRoute } from "@hono/zod-openapi";
import { createRouter, error, json, jsonBody, success } from "../openapi/routes.ts";
import {
  AccountRequestSchema,
  BootstrapPayloadSchema,
  LoginRequestSchema,
  SetupRequestSchema,
  SetupStatusSchema,
  UserSchema,
} from "../openapi/schemas.ts";
import { eq } from "drizzle-orm";
import {
  clearAuthSession,
  createAuthSession,
  hasLoginCapableUser,
  hashPassword,
  verifyPassword,
  type AuthVariables,
} from "../auth.ts";
import { db } from "../db/index.ts";
import { isPasswordLoginEnabled, readOidcConfig } from "../oidc/config.ts";
import { users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { serializeUser } from "../serializers.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { connectionIp } from "../security.ts";
import { createOidcAuthRoutes } from "./auth-oidc.ts";

const passwordLoginDisabled = { error: "Password sign-in is disabled on this server." };

const maxLoginFailures = 5;
const loginFailureWindowMs = 15 * 60 * 1000;
/** Bounds the map when an attacker sprays usernames that never log in successfully. */
const maxTrackedLoginFailures = 10_000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export function createAuthRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.route("/oidc", createOidcAuthRoutes());

  route.openapi(
    createRoute({
      method: "post",
      path: "/login",
      operationId: "login",
      tags: ["Auth"],
      security: [],
      request: { body: jsonBody(LoginRequestSchema) },
      responses: {
        403: error,
        400: error,
        200: json(BootstrapPayloadSchema, "Signed-in bootstrap"),
        401: error,
        429: error,
      },
    }),
    async (c) => {
      if (!isPasswordLoginEnabled()) return c.json(passwordLoginDisabled, 403);
      const body = c.req.valid("json");
      const username = body.username?.trim();
      if (!username || !body.password)
        return c.json({ error: "Username and password are required." }, 400);

      const attemptKey = loginAttemptKey(c, username);
      if (isLoginRateLimited(attemptKey)) {
        return c.json({ error: "Too many failed login attempts. Try again later." }, 429);
      }

      const user = db.select().from(users).where(eq(users.username, username)).get();
      if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
        recordFailedLogin(attemptKey);
        return c.json({ error: "Invalid username or password." }, 401);
      }

      loginFailures.delete(attemptKey);
      await createAuthSession(c, user.id);
      return c.json(readBootstrapPayload(user.id), 200);
    },
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/logout",
      operationId: "logout",
      tags: ["Auth"],
      security: [],
      responses: { 200: success },
    }),
    (c) => {
      clearAuthSession(c);
      return c.json({ ok: true }, 200);
    },
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/status",
      operationId: "getAuthStatus",
      tags: ["Auth"],
      security: [],
      responses: { 200: json(SetupStatusSchema, "Setup state") },
    }),
    (c) => {
      const oidc = readOidcConfig();
      return c.json(
        {
          needsSetup: !hasLoginCapableUser(),
          passwordLogin: isPasswordLoginEnabled(),
          ...(oidc ? { oidc: { providerName: oidc.providerName } } : {}),
        },
        200,
      );
    },
  );

  // First-run: create the initial administrator. Only allowed while no account can
  // log in yet, so it cannot be used to mint admins after setup.
  route.openapi(
    createRoute({
      method: "post",
      path: "/setup",
      operationId: "setup",
      tags: ["Auth"],
      security: [],
      request: { body: jsonBody(SetupRequestSchema) },
      responses: { 403: error, 201: json(BootstrapPayloadSchema, "Initial bootstrap"), 400: error },
    }),
    async (c) => {
      if (!isPasswordLoginEnabled()) return c.json(passwordLoginDisabled, 403);
      if (hasLoginCapableUser()) return c.json({ error: "Setup has already been completed." }, 403);

      const username = c.req.valid("json").username.trim();
      const { password, email, name } = c.req.valid("json");
      if (!username || !password)
        return c.json({ error: "Username and password are required." }, 400);
      if (password.length < 8)
        return c.json({ error: "Password must be at least 8 characters." }, 400);

      // Claim the seeded placeholder (so its default agent/model become the admin's)
      // when present; otherwise create a fresh account.
      const placeholder = db
        .select()
        .from(users)
        .all()
        .find((user) => !user.passwordHash);
      const userId = placeholder?.id ?? id("user");
      const timestamp = now();
      const passwordHash = await hashPassword(password);
      db.insert(users)
        .values({
          id: userId,
          username,
          passwordHash,
          name: name?.trim() || username,
          email: email?.trim() || `${username}@local`,
          role: "admin",
          createdAt: placeholder?.createdAt ?? timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            username,
            passwordHash,
            name: name?.trim() || username,
            email: email?.trim() || `${username}@local`,
            role: "admin",
            updatedAt: timestamp,
          },
        })
        .run();

      await createAuthSession(c, userId);
      return c.json(readBootstrapPayload(userId), 201);
    },
  );

  // Update the signed-in account's email, and optionally the password, after
  // confirming the current password. A blank new password leaves it unchanged.
  route.openapi(
    createRoute({
      method: "post",
      path: "/account",
      operationId: "updateAccount",
      tags: ["Auth"],
      request: { body: jsonBody(AccountRequestSchema) },
      responses: { 200: json(UserSchema, "User"), 400: error },
    }),
    async (c) => {
      const user = c.get("user");
      const body = c.req.valid("json");
      const email = body.email.trim();
      if (!body.currentPassword) return c.json({ error: "Current password is required." }, 400);
      if (!email) return c.json({ error: "Email is required." }, 400);
      if (!user.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
        return c.json({ error: "Current password is incorrect." }, 400);
      }
      const newPassword = body.newPassword?.trim();
      if (newPassword && newPassword.length < 8) {
        return c.json({ error: "New password must be at least 8 characters." }, 400);
      }
      db.update(users)
        .set({
          email,
          ...(newPassword ? { passwordHash: await hashPassword(newPassword) } : {}),
          updatedAt: now(),
        })
        .where(eq(users.id, user.id))
        .run();
      return c.json(
        serializeUser(db.select().from(users).where(eq(users.id, user.id)).get()!),
        200,
      );
    },
  );

  return route;
}

function loginAttemptKey(c: Parameters<typeof connectionIp>[0], username: string) {
  return `${connectionIp(c)}:${username.toLowerCase()}`;
}

function isLoginRateLimited(key: string, timestamp = Date.now()) {
  const current = loginFailures.get(key);
  if (!current) return false;
  if (current.resetAt <= timestamp) {
    loginFailures.delete(key);
    return false;
  }
  return current.count >= maxLoginFailures;
}

function recordFailedLogin(key: string, timestamp = Date.now()) {
  if (loginFailures.size >= maxTrackedLoginFailures) pruneLoginFailures(timestamp);
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= timestamp) {
    loginFailures.set(key, { count: 1, resetAt: timestamp + loginFailureWindowMs });
    return;
  }
  loginFailures.set(key, { ...current, count: current.count + 1 });
}

/**
 * Drop expired entries, then the oldest ones if the map is still full.
 *
 * Only failed logins add entries, and a successful login for the same key
 * removes one, so without this a spray of distinct usernames would grow the map
 * for the lifetime of the process.
 */
function pruneLoginFailures(timestamp: number) {
  for (const [key, entry] of loginFailures) {
    if (entry.resetAt <= timestamp) loginFailures.delete(key);
  }
  while (loginFailures.size >= maxTrackedLoginFailures) {
    const oldest = loginFailures.keys().next().value;
    if (oldest === undefined) return;
    loginFailures.delete(oldest);
  }
}
