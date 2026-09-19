import { createHash, randomBytes } from "node:crypto";
import type { ApiKey, ApiKeyCreated } from "@carmel-agent/shared";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { apiKeys, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";

type ApiKeyRecord = typeof apiKeys.$inferSelect;

/** Recognisable in a leaked-secret scan, and distinct from any provider's own key format. */
const KEY_PREFIX = "carmel-";
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 6;
/** `lastUsedAt` is informational; writing it on every request would make each call a DB write. */
const LAST_USED_RESOLUTION_MS = 60_000;

export function readApiKeys(userId: string): ApiKey[] {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(asc(apiKeys.createdAt))
    .all()
    .map(serializeApiKey);
}

export function createApiKey(userId: string, name: string): ApiKeyCreated {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const record: ApiKeyRecord = {
    id: id("api_key"),
    userId,
    name: name.trim(),
    prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
    keyHash: hashApiKey(key),
    lastUsedAt: null,
    createdAt: now(),
  };
  db.insert(apiKeys).values(record).run();
  return { ...serializeApiKey(record), key };
}

/** False when the key does not exist or belongs to someone else; the route reports both as 404. */
export function deleteApiKey(userId: string, apiKeyId: string) {
  return db.delete(apiKeys).where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.userId, userId))).run().changes > 0;
}

/** The user an `Authorization: Bearer` key belongs to, or undefined. */
export function authenticateApiKey(key: string | undefined) {
  if (!key?.startsWith(KEY_PREFIX)) return undefined;
  const record = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(key))).get();
  if (!record) return undefined;
  const user = db.select().from(users).where(eq(users.id, record.userId)).get();
  if (!user) return undefined;

  const timestamp = now();
  if (!record.lastUsedAt || timestamp - record.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
    db.update(apiKeys).set({ lastUsedAt: timestamp }).where(eq(apiKeys.id, record.id)).run();
  }
  return user;
}

function serializeApiKey(record: ApiKeyRecord): ApiKey {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    lastUsedAt: record.lastUsedAt ?? undefined,
    createdAt: record.createdAt,
  };
}

function hashApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}
