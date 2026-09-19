import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
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
import { jsonValidator } from "../validation.ts";
import { accountUpdateRequestSchema, loginRequestSchema, setupRequestSchema } from "@carmel-agent/shared";
import { createOidcAuthRoutes } from "./auth-oidc.ts";

const passwordLoginDisabled = { error: "Password sign-in is disabled on this server." };

const maxLoginFailures = 5;
const loginFailureWindowMs = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export function createAuthRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.route("/oidc", createOidcAuthRoutes());

  route.post("/login", jsonValidator(loginRequestSchema), async (c) => {
    if (!isPasswordLoginEnabled()) return c.json(passwordLoginDisabled, 403);
    const body = c.req.valid("json");
    const username = body.username?.trim();
    if (!username || !body.password) return c.json({ error: "Username and password are required." }, 400);

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
    return c.json(readBootstrapPayload(user.id));
  });

  route.post("/logout", (c) => {
    clearAuthSession(c);
    return c.json({ ok: true });
  });

  route.get("/status", (c) => {
    const oidc = readOidcConfig();
    return c.json({
      needsSetup: !hasLoginCapableUser(),
      passwordLogin: isPasswordLoginEnabled(),
      ...(oidc ? { oidc: { providerName: oidc.providerName } } : {}),
    });
  });

  // First-run: create the initial administrator. Only allowed while no account can
  // log in yet, so it cannot be used to mint admins after setup.
  route.post("/setup", jsonValidator(setupRequestSchema), async (c) => {
    if (!isPasswordLoginEnabled()) return c.json(passwordLoginDisabled, 403);
    if (hasLoginCapableUser()) return c.json({ error: "Setup has already been completed." }, 403);

    const username = c.req.valid("json").username.trim();
    const { password, email, name } = c.req.valid("json");
    if (!username || !password) return c.json({ error: "Username and password are required." }, 400);
    if (password.length < 8) return c.json({ error: "Password must be at least 8 characters." }, 400);

    // Claim the seeded placeholder (so its default agent/model become the admin's)
    // when present; otherwise create a fresh account.
    const placeholder = db.select().from(users).all().find((user) => !user.passwordHash);
    const userId = placeholder?.id ?? id("user");
    const timestamp = now();
    db.insert(users)
      .values({
        id: userId,
        username,
        passwordHash: await hashPassword(password),
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
          passwordHash: await hashPassword(password),
          name: name?.trim() || username,
          email: email?.trim() || `${username}@local`,
          role: "admin",
          updatedAt: timestamp,
        },
      })
      .run();

    await createAuthSession(c, userId);
    return c.json(readBootstrapPayload(userId), 201);
  });

  // Update the signed-in account's email, and optionally the password, after
  // confirming the current password. A blank new password leaves it unchanged.
  route.post("/account", jsonValidator(accountUpdateRequestSchema), async (c) => {
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
    return c.json(serializeUser(db.select().from(users).where(eq(users.id, user.id)).get()!));
  });

  return route;
}

function loginAttemptKey(c: Context, username: string) {
  return `${clientIp(c)}:${username.toLowerCase()}`;
}

// Use the TCP source address (which the client cannot spoof). `X-Forwarded-For`
// is only honoured when the connection actually comes from a proxy listed in
// CARMEL_TRUSTED_PROXY, so a direct attacker setting the header is ignored.
function clientIp(c: Context) {
  const socketIp = socketAddress(c);
  if (socketIp && isTrustedProxy(socketIp)) {
    const forwarded = normalizeIp(c.req.header("x-forwarded-for")?.split(",")[0]);
    if (forwarded) return forwarded;
  }
  return socketIp ?? "unknown";
}

function socketAddress(c: Context) {
  try {
    return normalizeIp(getConnInfo(c).remote.address);
  } catch {
    return undefined;
  }
}

function isTrustedProxy(ip: string) {
  return (process.env.CARMEL_TRUSTED_PROXY ?? "")
    .split(",")
    .map((value) => normalizeIp(value))
    .some((value) => value === ip);
}

// Lower-cases and unwraps IPv4-mapped IPv6 addresses (::ffff:192.168.1.3) so
// configured IPs match what the socket reports on dual-stack listeners.
function normalizeIp(value: string | undefined | null) {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
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
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= timestamp) {
    loginFailures.set(key, { count: 1, resetAt: timestamp + loginFailureWindowMs });
    return;
  }
  loginFailures.set(key, { ...current, count: current.count + 1 });
}
