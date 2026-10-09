import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt, isNotNull, lte } from "drizzle-orm";
import { db } from "./db/index.ts";
import { authSessions, userIdentities, users } from "./db/schema.ts";
import { id, now } from "./db/seed.ts";

const scrypt = promisify(scryptCallback);
const cookieName = "carmel_session";
const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;

export type AuthVariables = {
  user: typeof users.$inferSelect;
};

/**
 * Whether anyone can sign in yet, by password or by a linked OIDC identity.
 *
 * "Needs setup" is the negation. A fresh database seeds a passwordless
 * placeholder user that owns the default agent/model, so this keys off the
 * credentials rather than the presence of any row.
 */
export function hasLoginCapableUser() {
  return Boolean(
    db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).get() ??
    db.select({ userId: userIdentities.userId }).from(userIdentities).get(),
  );
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, hash] = storedHash.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createAuthSession(c: Context<{ Variables: AuthVariables }>, userId: string) {
  pruneExpiredAuthSessions();
  const token = randomBytes(32).toString("base64url");
  const timestamp = now();
  const expiresAt = timestamp + sessionDurationMs;
  db.insert(authSessions)
    .values({
      id: id("auth_session"),
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: timestamp,
    })
    .run();
  setCookie(c, cookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(sessionDurationMs / 1000),
  });
}

export function clearAuthSession(c: Context) {
  const token = getCookie(c, cookieName);
  if (token)
    db.delete(authSessions)
      .where(eq(authSessions.tokenHash, hashToken(token)))
      .run();
  deleteCookie(c, cookieName, { path: "/" });
}

export function pruneExpiredAuthSessions(timestamp = now()) {
  db.delete(authSessions).where(lte(authSessions.expiresAt, timestamp)).run();
}

/**
 * Resolve a session cookie to its user, dropping the session if it is stale.
 *
 * Shared by the HTTP middleware and the terminal WebSocket upgrade, which
 * happens below hono and so has no context to read the cookie from. One
 * implementation on purpose: an authentication check that exists twice is an
 * authentication check that will eventually disagree with itself.
 */
export function readAuthenticatedUser(token: string | undefined) {
  if (!token) return undefined;

  const session = db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, now())))
    .get();
  if (!session) return undefined;

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user) {
    db.delete(authSessions).where(eq(authSessions.id, session.id)).run();
    return undefined;
  }
  return user;
}

/** Read the session cookie out of a raw `Cookie` header. */
export function readSessionCookie(header: string | undefined) {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === cookieName) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (isPublicApiPath(c.req.path)) {
    await next();
    return;
  }

  const token = getCookie(c, cookieName);
  if (!token) return c.json({ error: "Authentication required." }, 401);

  const user = readAuthenticatedUser(token);
  if (!user) {
    deleteCookie(c, cookieName, { path: "/" });
    return c.json({ error: "Authentication required." }, 401);
  }

  c.set("user", user);
  await next();
};

export const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (c.get("user").role !== "admin")
    return c.json({ error: "Administrator access required." }, 403);
  await next();
};

function isPublicApiPath(path: string) {
  return (
    path === "/api/health" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    path === "/api/auth/status" ||
    path === "/api/auth/setup" ||
    path === "/api/auth/oidc/login" ||
    path === "/api/auth/oidc/callback"
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
