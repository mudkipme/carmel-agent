import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

const encryptedPrefix = "enc:v1:";
const encryptedJsonKey = "__carmel_encrypted_v1";
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
// The Vite dev server is a trusted credential-bearing origin only in development.
const defaultAllowedBrowserOrigins =
  process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"];

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

/** Untrusted submitted credentials are always encrypted, including values starting with enc:v1:. */
export function encryptSubmittedSecret(value: string): string {
  const key = secretKey();
  if (!key) throw new Error("Configure CARMEL_SECRET_KEY before storing session credentials.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${encryptedPrefix}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
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
  if (!origin || isAllowedBrowserOrigin(origin, requestHost(c))) {
    await next();
    return;
  }

  return c.json({ error: "Cross-origin API requests are not allowed." }, 403);
};

/**
 * The host the browser used, for the same-origin check.
 *
 * `X-Forwarded-Host` is client-controlled, so it is only honoured when the TCP
 * peer is a configured trusted proxy. Otherwise a foreign `Origin` could name
 * itself in the header and be treated as same-origin.
 */
export function requestHost(c: Context) {
  return trustedForwardedHeader(c, "x-forwarded-host") ?? c.req.header("host");
}

/** Node `IncomingMessage` equivalent of `requestHost` for WebSocket upgrades. */
export function incomingRequestHost(
  request: Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string } },
) {
  const peer = normalizeIp(request.socket?.remoteAddress);
  if (peer && isTrustedProxy(peer)) {
    const forwarded = firstHeaderValue(request.headers["x-forwarded-host"]);
    if (forwarded) return forwarded;
  }
  return firstHeaderValue(request.headers.host);
}

/** Parse a Node upgrade request target without trusting `Host` or throwing on malformed URLs. */
export function incomingRequestUrl(request: Pick<IncomingMessage, "url">) {
  try {
    return new URL(request.url ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

function firstHeaderValue(value: IncomingHttpHeaders[string]) {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

/** The client IP, honouring `X-Forwarded-For` only from a trusted proxy. */
export function connectionIp(c: Context) {
  const forwarded = trustedForwardedHeader(c, "x-forwarded-for");
  return (forwarded ? normalizeIp(forwarded.split(",")[0]) : undefined) ?? socketIp(c) ?? "unknown";
}

function trustedForwardedHeader(c: Context, header: string) {
  const peer = socketIp(c);
  if (!peer || !isTrustedProxy(peer)) return undefined;
  return c.req.header(header);
}

function socketIp(c: Context) {
  try {
    return normalizeIp(getConnInfo(c).remote.address);
  } catch {
    // No raw Node socket (tests, in-process requests): fall back to peer headers.
    return undefined;
  }
}

function isTrustedProxy(ip: string) {
  return (process.env.CARMEL_TRUSTED_PROXY ?? "")
    .split(",")
    .map((value) => normalizeIp(value))
    .some((value) => value === ip);
}

/** Lower-cases and unwraps IPv4-mapped IPv6 addresses so configured IPs match. */
function normalizeIp(value: string | undefined | null) {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

export function allowedCorsOrigin(origin: string, requestHost?: string) {
  const originUrl = parseUrl(origin);
  if (!originUrl) return undefined;
  if (requestHost && originUrl.host === requestHost) return originUrl.origin;
  return allowedBrowserOrigins().includes(originUrl.origin) ? originUrl.origin : undefined;
}

export function isAllowedBrowserOrigin(origin: string, requestHost?: string) {
  return Boolean(allowedCorsOrigin(origin, requestHost));
}

function allowedBrowserOrigins() {
  return [...defaultAllowedBrowserOrigins, ...configuredBrowserOrigins()];
}

function configuredBrowserOrigins() {
  return (process.env.CARMEL_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => parseUrl(item.trim())?.origin)
    .filter((origin): origin is string => Boolean(origin));
}

function parseUrl(value: string) {
  try {
    return value ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

function secretKey() {
  const secret = process.env.CARMEL_SECRET_KEY;
  return secret ? createHash("sha256").update(secret).digest() : undefined;
}

function isEncryptedJson<T>(
  value: T | null | undefined,
): value is T & Record<typeof encryptedJsonKey, string> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    encryptedJsonKey in value &&
    typeof (value as Record<string, unknown>)[encryptedJsonKey] === "string",
  );
}
