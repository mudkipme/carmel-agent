/**
 * OpenID Connect sign-in, configured entirely from the environment.
 *
 * Read on every call rather than once at import: tests flip these variables,
 * and parsing a dozen strings is not worth a cache that can go stale.
 * `assertOidcConfig` runs at startup so a typo fails the boot instead of the
 * first person who clicks the button.
 */

export type OidcMatchField = "username" | "email";

export type OidcConfig = {
  issuer: URL;
  clientId: string;
  /** Absent for a public client, which authenticates with PKCE alone. */
  clientSecret?: string;
  redirectUri: string;
  providerName: string;
  scopes: string[];
  claims: { username: string; email: string; name: string; groups: string };
  /** Existing accounts a first-time identity may be linked to, in priority order. */
  matchBy: OidcMatchField[];
  requireVerifiedEmail: boolean;
  autoCreate: boolean;
  allowedGroups: string[];
  adminGroups: string[];
};

type Env = Record<string, string | undefined>;

// Relative, so a public URL with a path prefix (a proxy that strips it) keeps it.
const callbackPath = "api/auth/oidc/callback";

export class OidcConfigError extends Error {}

export function readOidcConfig(env: Env = process.env): OidcConfig | undefined {
  const issuer = value(env.CARMEL_OIDC_ISSUER);
  if (!issuer) return undefined;

  const clientId = value(env.CARMEL_OIDC_CLIENT_ID);
  if (!clientId)
    throw new OidcConfigError("CARMEL_OIDC_CLIENT_ID is required when CARMEL_OIDC_ISSUER is set.");

  const publicUrl = value(env.CARMEL_PUBLIC_URL);
  if (!publicUrl) {
    throw new OidcConfigError(
      "CARMEL_PUBLIC_URL is required when CARMEL_OIDC_ISSUER is set; it builds the redirect URI registered with the provider.",
    );
  }

  const allowedGroups = list(env.CARMEL_OIDC_ALLOWED_GROUPS);
  const adminGroups = list(env.CARMEL_OIDC_ADMIN_GROUPS);
  // Pocket ID (and most providers) only emit the groups claim when asked for it.
  const defaultScopes = [
    "openid",
    "profile",
    "email",
    ...(allowedGroups.length || adminGroups.length ? ["groups"] : []),
  ];
  const scopes =
    env.CARMEL_OIDC_SCOPES === undefined ? defaultScopes : list(env.CARMEL_OIDC_SCOPES, /[\s,]+/);
  if (!scopes.includes("openid"))
    throw new OidcConfigError("CARMEL_OIDC_SCOPES must include openid.");

  return {
    issuer: parseHttpUrl("CARMEL_OIDC_ISSUER", issuer),
    clientId,
    clientSecret: value(env.CARMEL_OIDC_CLIENT_SECRET),
    redirectUri: new URL(
      callbackPath,
      withTrailingSlash(parseHttpUrl("CARMEL_PUBLIC_URL", publicUrl)),
    ).toString(),
    providerName: value(env.CARMEL_OIDC_PROVIDER_NAME) ?? "SSO",
    scopes,
    claims: {
      username: value(env.CARMEL_OIDC_USERNAME_CLAIM) ?? "preferred_username",
      email: value(env.CARMEL_OIDC_EMAIL_CLAIM) ?? "email",
      name: value(env.CARMEL_OIDC_NAME_CLAIM) ?? "name",
      groups: value(env.CARMEL_OIDC_GROUPS_CLAIM) ?? "groups",
    },
    matchBy: parseMatchBy(env.CARMEL_OIDC_MATCH_BY),
    requireVerifiedEmail: parseBoolean(
      "CARMEL_OIDC_REQUIRE_VERIFIED_EMAIL",
      env.CARMEL_OIDC_REQUIRE_VERIFIED_EMAIL,
      true,
    ),
    autoCreate: parseBoolean("CARMEL_OIDC_AUTO_CREATE", env.CARMEL_OIDC_AUTO_CREATE, true),
    allowedGroups,
    adminGroups,
  };
}

/** Password sign-in and first-run setup. On unless explicitly turned off. */
export function isPasswordLoginEnabled(env: Env = process.env) {
  return parseBoolean("CARMEL_PASSWORD_LOGIN", env.CARMEL_PASSWORD_LOGIN, true);
}

/** Validate at startup. Throws with a message naming the offending variable. */
export function assertOidcConfig(env: Env = process.env) {
  const config = readOidcConfig(env);
  if (!config && !isPasswordLoginEnabled(env)) {
    throw new OidcConfigError(
      "CARMEL_PASSWORD_LOGIN=false requires OIDC to be configured, or nobody could sign in.",
    );
  }
  return config;
}

// Email first because it is only ever trusted when the provider verified it;
// username catches providers, Pocket ID among them, that leave it unverified.
const defaultMatchBy: OidcMatchField[] = ["email", "username"];

function parseMatchBy(raw: string | undefined): OidcMatchField[] {
  const fields = list(raw).map((item) => item.toLowerCase());
  if (!fields.length) return defaultMatchBy;
  if (fields.length === 1 && fields[0] === "none") return [];
  for (const field of fields) {
    if (field !== "username" && field !== "email") {
      throw new OidcConfigError(
        `CARMEL_OIDC_MATCH_BY accepts "username", "email", or "none"; got "${field}".`,
      );
    }
  }
  return [...new Set(fields as OidcMatchField[])];
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean) {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new OidcConfigError(`${name} must be true or false; got "${raw}".`);
}

function parseHttpUrl(name: string, raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcConfigError(`${name} must be an absolute URL; got "${raw}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OidcConfigError(`${name} must be an http(s) URL; got "${raw}".`);
  }
  return url;
}

function withTrailingSlash(url: URL) {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname += "/";
  return copy;
}

function value(raw: string | undefined) {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function list(raw: string | undefined, separator: RegExp = /,/) {
  return (raw ?? "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}
