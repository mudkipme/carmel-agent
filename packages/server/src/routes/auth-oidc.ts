import { randomBytes } from "node:crypto";
import type { OidcLoginErrorCode } from "@carmel-agent/shared";
import { Hono, type Context } from "hono";
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

const flowCookieName = "carmel_oidc";
const flowCookiePath = "/api/auth/oidc";
const flowTtlMs = 10 * 60 * 1000;
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
const pendingFlows = new Map<string, PendingOidcLogin & { expiresAt: number }>();

export function createOidcAuthRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/login", async (c) => {
    const config = readOidcConfig();
    if (!config) return c.json({ error: "Single sign-on is not configured." }, 404);

    let authorization: Awaited<ReturnType<typeof buildOidcAuthorizationUrl>>;
    try {
      authorization = await buildOidcAuthorizationUrl(config);
    } catch (error) {
      console.error(`OIDC: could not start sign-in with ${config.providerName}:`, error);
      return redirectWithError(c, "failed");
    }

    const flowId = randomBytes(32).toString("base64url");
    rememberFlow(flowId, authorization.login);
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
  });

  route.get("/callback", async (c) => {
    const config = readOidcConfig();
    if (!config) return c.json({ error: "Single sign-on is not configured." }, 404);

    const flowId = getCookie(c, flowCookieName);
    deleteCookie(c, flowCookieName, { path: flowCookiePath });
    const login = flowId ? takeFlow(flowId) : undefined;
    if (!login) return redirectWithError(c, "expired");

    try {
      const claims = await completeOidcLogin(config, new URL(c.req.url).search, login);
      const profile = readOidcProfile(config, await discoveredIssuer(config), claims);
      const user = resolveOidcUser(config, profile);
      await createAuthSession(c, user.id);
      return c.redirect("/", 302);
    } catch (error) {
      if (error instanceof OidcLoginError) {
        console.warn(`OIDC: refused sign-in: ${error.message}`);
        return redirectWithError(c, error.code);
      }
      if (error instanceof AuthorizationResponseError) {
        // The provider sent the person back with error=... (cancelled, denied).
        console.warn(
          `OIDC: ${config.providerName} returned ${error.error}: ${error.error_description ?? ""}`,
        );
        return redirectWithError(c, error.error === "access_denied" ? "denied" : "failed");
      }
      console.error(`OIDC: sign-in with ${config.providerName} failed:`, error);
      return redirectWithError(c, "failed");
    }
  });

  return route;
}

function redirectWithError(c: Context, code: OidcLoginErrorCode) {
  return c.redirect(`/?auth_error=${code}`, 302);
}

function rememberFlow(flowId: string, login: PendingOidcLogin, timestamp = Date.now()) {
  for (const [key, flow] of pendingFlows) {
    if (flow.expiresAt <= timestamp) pendingFlows.delete(key);
  }
  // Maps iterate in insertion order, so the first key is the oldest flow.
  while (pendingFlows.size >= maxPendingFlows) {
    pendingFlows.delete(pendingFlows.keys().next().value!);
  }
  pendingFlows.set(flowId, { ...login, expiresAt: timestamp + flowTtlMs });
}

/** Single use: a flow is consumed by its first callback, successful or not. */
function takeFlow(flowId: string, timestamp = Date.now()) {
  const flow = pendingFlows.get(flowId);
  pendingFlows.delete(flowId);
  return flow && flow.expiresAt > timestamp ? flow : undefined;
}
