import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const encryptedPrefix = "enc:v1:";
const encryptedJsonKey = "__carmel_encrypted_v1";
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function protectSecret(value: string | null | undefined) {
  if (!value) return value ?? null;
  if (value.startsWith(encryptedPrefix)) return value;

  const key = secretKey();
  if (!key) return value;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${encryptedPrefix}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function revealSecret(value: string | null | undefined) {
  if (!value?.startsWith(encryptedPrefix)) return value ?? undefined;

  const key = secretKey();
  if (!key) throw new Error("CARMEL_SECRET_KEY is required to read encrypted provider secrets.");

  const payload = Buffer.from(value.slice(encryptedPrefix.length), "base64url");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function protectJsonSecret<T>(value: T | null | undefined): T | null {
  if (!value) return null;
  if (isEncryptedJson(value)) return value;
  const protectedValue = protectSecret(JSON.stringify(value));
  if (!protectedValue?.startsWith(encryptedPrefix)) return value;
  return { [encryptedJsonKey]: protectedValue } as T;
}

export function revealJsonSecret<T>(value: T | null | undefined): T | undefined {
  if (!isEncryptedJson(value)) return value ?? undefined;
  return JSON.parse(revealSecret(value[encryptedJsonKey]) ?? "null") as T;
}

export const rejectCrossOriginMutations: MiddlewareHandler = async (c, next) => {
  if (safeMethods.has(c.req.method)) {
    await next();
    return;
  }

  const origin = c.req.header("origin");
  if (!origin || isAllowedOrigin(origin, c.req.header("x-forwarded-host") ?? c.req.header("host"))) {
    await next();
    return;
  }

  return c.json({ error: "Cross-origin API requests are not allowed." }, 403);
};

function isAllowedOrigin(origin: string, requestHost?: string) {
  try {
    const originUrl = new URL(origin);
    if (requestHost && originUrl.host === requestHost) return true;

    const configured = (process.env.CARMEL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://porygon-z.lan:5173", ...configured]).has(originUrl.origin);
  } catch {
    return false;
  }
}

function secretKey() {
  const secret = process.env.CARMEL_SECRET_KEY;
  return secret ? createHash("sha256").update(secret).digest() : undefined;
}

function isEncryptedJson<T>(value: T | null | undefined): value is T & Record<typeof encryptedJsonKey, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      encryptedJsonKey in value &&
      typeof (value as Record<string, unknown>)[encryptedJsonKey] === "string",
  );
}
