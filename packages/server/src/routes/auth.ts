import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import {
  clearAuthSession,
  createAuthSession,
  hashPassword,
  verifyPassword,
  type AuthVariables,
} from "../auth.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { jsonValidator, loginRequestSchema, passwordRequestSchema } from "../validation.ts";

const maxLoginFailures = 5;
const loginFailureWindowMs = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export function createAuthRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.post("/login", jsonValidator(loginRequestSchema), async (c) => {
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

  route.post("/password", jsonValidator(passwordRequestSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    if (!body.currentPassword || !body.newPassword) {
      return c.json({ error: "Current and new password are required." }, 400);
    }
    if (body.newPassword.length < 8) return c.json({ error: "New password must be at least 8 characters." }, 400);
    if (!user.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return c.json({ error: "Current password is incorrect." }, 400);
    }
    db.update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: now() })
      .where(eq(users.id, user.id))
      .run();
    return c.json({ ok: true });
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
