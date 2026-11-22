import { createRoute } from "@hono/zod-openapi";
import { createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import { BootstrapPayloadSchema, OidcExchangeRequestSchema } from "../openapi/schemas.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OidcLoginErrorCode } from "@carmel-agent/shared";
import { type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AuthorizationResponseError } from "openid-client";
import { createAuthSession, type AuthVariables } from "../auth.ts";
import { OidcLoginError, readOidcProfile, resolveOidcUser } from "../oidc/accounts.ts";
import {
  buildOidcAuthorizationUrl,
  completeOidcLogin,
  discoveredIssuer,
  type PendingOidcLogin,
} from "../oidc/client.ts";
import { readOidcConfig } from "../oidc/config.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";

const flowCookieName = "carmel_oidc";
const flowCookiePath = "/api/auth/oidc";
const flowTtlMs = 10 * 60 * 1000;
const nativeCallbackUrl = "carmel-agent://auth/callback";
const nativeCodeTtlMs = 2 * 60 * 1000;
const codeChallengePattern = /^[A-Za-z0-9_-]{43,128}$/;
// The login endpoint is unauthenticated, so the pending table needs a ceiling
// or anyone could grow it without bound.
const maxPendingFlows = 1000;

/**
 * Sign-ins that have left for the provider and not yet come back.
 *
 * In memory on purpose: an entry lives for minutes, and the price of a restart
 * mid-sign-in is one "try again". The browser holds only an opaque id in a
 * cookie, which is what ties the callback to the browser that started it --
 * without that, an attacker could complete their own sign-in in your browser.
 */
const pendingFlows = new Map<
  string,
  PendingOidcLogin & { nativeChallenge?: string; expiresAt: number }
>();

const pendingNativeCodes = new Map<
  string,
  { userId: string; codeChallenge: string; expiresAt: number }
>();

export function createOidcAuthRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "get",
      path: "/login",
      operationId: "startOidcLogin",
      tags: ["Auth"],
      security: [],
      description:
        "Browser navigation only. Redirects to the configured OpenID Connect provider and sets a short-lived flow cookie. Pass code_challenge for a native app callback handoff.",
      parameters: [{ name: "code_challenge", in: "query", schema: { type: "string" } }],
      responses: { 302: { description: "Redirect to the provider" }, 400: error, 404: error },
    }),
    async (c) => {
      const config = readOidcConfig();
      if (!config) return c.json({ error: "Single sign-on is not configured." }, 404);

      const codeChallenge = c.req.query("code_challenge");
      if (codeChallenge !== undefined && !codeChallengePattern.test(codeChallenge)) {
        return c.json({ error: "Invalid code challenge." }, 400);
      }
      const native = Boolean(codeChallenge);

      let authorization: Awaited<ReturnType<typeof buildOidcAuthorizationUrl>>;
      try {
        authorization = await buildOidcAuthorizationUrl(config);
      } catch (error) {
        console.error(`OIDC: could not start sign-in with ${config.providerName}:`, error);
        return redirectWithError(c, "failed", native);
      }

      const flowId = randomBytes(32).toString("base64url");
      rememberFlow(flowId, authorization.login, codeChallenge);
      setCookie(c, flowCookieName, flowId, {
        httpOnly: true,
        // Lax, not Strict: the callback is a cross-site top-level navigation from
        // the provider, and Strict would withhold the cookie on exactly that hop.
        sameSite: "Lax",
        secure: process.env.NODE_ENV === "production",
        path: flowCookiePath,
        maxAge: Math.floor(flowTtlMs / 1000),
      });
      return c.redirect(authorization.url.href, 302);
    },
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/callback",
      operationId: "completeOidcLogin",
      tags: ["Auth"],
      security: [],
      description:
        "Provider redirect target. Signs the browser in and redirects to /, or redirects to the native app with a single-use exchange code.",
      parameters: [
        { name: "code", in: "query", schema: { type: "string" } },
        { name: "state", in: "query", schema: { type: "string" } },
      ],
      responses: { 302: { description: "Redirect into the app" }, 404: error },
    }),
    async (c) => {
      const config = readOidcConfig();
      if (!config) return c.json({ error: "Single sign-on is not configured." }, 404);

      const flowId = getCookie(c, flowCookieName);
      deleteCookie(c, flowCookieName, { path: flowCookiePath });
      const login = flowId ? takeFlow(flowId) : undefined;
      if (!login) return redirectWithError(c, "expired", false);
      const native = Boolean(login.nativeChallenge);

      try {
        const claims = await completeOidcLogin(config, new URL(c.req.url).search, login);
        const profile = readOidcProfile(config, await discoveredIssuer(config), claims);
        const user = resolveOidcUser(config, profile);
        if (login.nativeChallenge) {
          const code = randomBytes(32).toString("base64url");
          rememberNativeCode(code, user.id, login.nativeChallenge);
          return c.redirect(`${nativeCallbackUrl}?code=${encodeURIComponent(code)}`, 302);
        }
        await createAuthSession(c, user.id);
        return c.redirect("/", 302);
      } catch (error) {
        if (error instanceof OidcLoginError) {
          console.warn(`OIDC: refused sign-in: ${error.message}`);
          return redirectWithError(c, error.code, native);
        }
        if (error instanceof AuthorizationResponseError) {
          // The provider sent the person back with error=... (cancelled, denied).
          console.warn(
            `OIDC: ${config.providerName} returned ${error.error}: ${error.error_description ?? ""}`,
          );
          return redirectWithError(
            c,
            error.error === "access_denied" ? "denied" : "failed",
            native,
          );
        }
        console.error(`OIDC: sign-in with ${config.providerName} failed:`, error);
        return redirectWithError(c, "failed", native);
      }
    },
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/exchange",
      operationId: "exchangeOidcCode",
      tags: ["Auth"],
      security: [],
      description:
        "Exchange a single-use native OIDC callback code and PKCE verifier for a session cookie.",
      request: { body: jsonBody(OidcExchangeRequestSchema) },
      responses: {
        200: json(BootstrapPayloadSchema, "Signed-in bootstrap"),
        400: error,
        401: error,
        404: error,
      },
    }),
    async (c) => {
      if (!readOidcConfig()) return c.json({ error: "Single sign-on is not configured." }, 404);
      const { code, codeVerifier } = c.req.valid("json");
      const pending = takeNativeCode(code);
      if (!pending || !matchesCodeChallenge(codeVerifier, pending.codeChallenge)) {
        return c.json({ error: "Sign-in code is invalid or expired. Please try again." }, 401);
      }
      await createAuthSession(c, pending.userId);
      return c.json(readBootstrapPayload(pending.userId), 200);
    },
  );

  return route;
}

function redirectWithError(c: Context, code: OidcLoginErrorCode, native: boolean) {
  return c.redirect(
    native ? `${nativeCallbackUrl}?auth_error=${code}` : `/?auth_error=${code}`,
    302,
  );
}

function rememberFlow(
  flowId: string,
  login: PendingOidcLogin,
  nativeChallenge?: string,
  timestamp = Date.now(),
) {
  for (const [key, flow] of pendingFlows) {
    if (flow.expiresAt <= timestamp) pendingFlows.delete(key);
  }
  // Maps iterate in insertion order, so the first key is the oldest flow.
  while (pendingFlows.size >= maxPendingFlows) {
    pendingFlows.delete(pendingFlows.keys().next().value!);
  }
  pendingFlows.set(flowId, { ...login, nativeChallenge, expiresAt: timestamp + flowTtlMs });
}

/** Single use: a flow is consumed by its first callback, successful or not. */
function takeFlow(flowId: string, timestamp = Date.now()) {
  const flow = pendingFlows.get(flowId);
  pendingFlows.delete(flowId);
  return flow && flow.expiresAt > timestamp ? flow : undefined;
}

function rememberNativeCode(
  code: string,
  userId: string,
  codeChallenge: string,
  timestamp = Date.now(),
) {
  for (const [key, entry] of pendingNativeCodes) {
    if (entry.expiresAt <= timestamp) pendingNativeCodes.delete(key);
  }
  while (pendingNativeCodes.size >= maxPendingFlows) {
    pendingNativeCodes.delete(pendingNativeCodes.keys().next().value!);
  }
  pendingNativeCodes.set(code, { userId, codeChallenge, expiresAt: timestamp + nativeCodeTtlMs });
}

function takeNativeCode(code: string, timestamp = Date.now()) {
  const entry = pendingNativeCodes.get(code);
  pendingNativeCodes.delete(code);
  return entry && entry.expiresAt > timestamp ? entry : undefined;
}

function matchesCodeChallenge(codeVerifier: string, expectedChallenge: string) {
  const actual = Buffer.from(createHash("sha256").update(codeVerifier).digest("base64url"));
  const expected = Buffer.from(expectedChallenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
