import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt, lte } from "drizzle-orm";
import { db } from "./db/index.ts";
import { authSessions, users } from "./db/schema.ts";
import { id, now } from "./db/seed.ts";

const scrypt = promisify(scryptCallback);
const cookieName = "carmel_session";
const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;

export type AuthVariables = {
  user: typeof users.$inferSelect;
};

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
  if (token) db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token))).run();
  deleteCookie(c, cookieName, { path: "/" });
}

export function pruneExpiredAuthSessions(timestamp = now()) {
  db.delete(authSessions).where(lte(authSessions.expiresAt, timestamp)).run();
}

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (isPublicApiPath(c.req.path)) {
    await next();
    return;
  }

  const token = getCookie(c, cookieName);
  if (!token) return c.json({ error: "Authentication required." }, 401);

  const session = db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, now())))
    .get();
  if (!session) {
    deleteCookie(c, cookieName, { path: "/" });
    return c.json({ error: "Authentication required." }, 401);
  }

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user) {
    db.delete(authSessions).where(eq(authSessions.id, session.id)).run();
    deleteCookie(c, cookieName, { path: "/" });
    return c.json({ error: "Authentication required." }, 401);
  }

  c.set("user", user);
  await next();
};

function isPublicApiPath(path: string) {
  return path === "/api/health" || path === "/api/auth/login" || path === "/api/auth/logout";
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
