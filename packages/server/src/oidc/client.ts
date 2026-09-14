import * as oidc from "openid-client";
import type { OidcConfig } from "./config.ts";

/**
 * The provider-facing half of OIDC sign-in: discovery, the authorization
 * redirect, and the code exchange. Token and ID-token validation (signature,
 * issuer, audience, nonce, PKCE) is left entirely to openid-client.
 */

export type OidcClaims = Record<string, unknown> & { sub: string };

export type PendingOidcLogin = {
  state: string;
  nonce: string;
  codeVerifier: string;
};

const requestTimeoutSeconds = 15;

let discovered: { key: string; configuration: Promise<oidc.Configuration> } | undefined;
let fetchOverride: oidc.CustomFetch | undefined;

/** Route provider HTTP through `fetch` instead of the network. Tests only. */
export function setOidcFetchForTests(fetch: oidc.CustomFetch | undefined) {
  fetchOverride = fetch;
  discovered = undefined;
}

/** The canonical issuer, as the provider's discovery document spells it. */
export async function discoveredIssuer(config: OidcConfig) {
  return (await discover(config)).serverMetadata().issuer;
}

export async function buildOidcAuthorizationUrl(config: OidcConfig) {
  const configuration = await discover(config);
  const login: PendingOidcLogin = {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    codeVerifier: oidc.randomPKCECodeVerifier(),
  };
  const url = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state: login.state,
    nonce: login.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(login.codeVerifier),
    code_challenge_method: "S256",
  });
  return { url, login };
}

/**
 * Exchange the callback's code and return the person's claims.
 *
 * `callbackSearch` is the query string of the request that reached us. It is
 * grafted onto the configured redirect URI rather than taken from the request
 * URL, because behind a proxy the request URL is the internal one, and the
 * token endpoint insists on the exact redirect URI that was sent.
 */
export async function completeOidcLogin(config: OidcConfig, callbackSearch: string, login: PendingOidcLogin) {
  const configuration = await discover(config);
  const currentUrl = new URL(config.redirectUri);
  currentUrl.search = callbackSearch;

  const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
    expectedState: login.state,
    expectedNonce: login.nonce,
    pkceCodeVerifier: login.codeVerifier,
    idTokenExpected: true,
  });
  const idClaims = tokens.claims();
  if (!idClaims) throw new Error("The provider did not return an ID token.");

  // Providers differ on which claims ride in the ID token and which only come
  // from userinfo; ask for both when we can. The ID token wins on conflict
  // because it is the signed one.
  let userInfo: Record<string, unknown> = {};
  if (configuration.serverMetadata().userinfo_endpoint && tokens.access_token) {
    userInfo = await oidc.fetchUserInfo(configuration, tokens.access_token, idClaims.sub);
  }
  return { ...userInfo, ...idClaims } as OidcClaims;
}

function discover(config: OidcConfig) {
  const key = JSON.stringify([config.issuer.href, config.clientId, config.clientSecret ?? null]);
  if (discovered?.key === key) return discovered.configuration;

  const configuration = discoverNow(config);
  const entry = { key, configuration };
  discovered = entry;
  // Never cache a failure: the provider being down at one sign-in must not
  // break every later one.
  configuration.catch(() => {
    if (discovered === entry) discovered = undefined;
  });
  return configuration;
}

async function discoverNow(config: OidcConfig) {
  const insecure = config.issuer.protocol === "http:";
  const execute = insecure ? [oidc.allowInsecureRequests] : [];
  const metadata = await oidc.discovery(config.issuer, config.clientId, undefined, oidc.None(), {
    execute,
    timeout: requestTimeoutSeconds,
    ...(fetchOverride ? { [oidc.customFetch]: fetchOverride } : {}),
  });

  // Discovery only reads a public document; the client authentication method
  // is picked afterwards from what the provider says its token endpoint takes.
  const server = metadata.serverMetadata();
  const configuration = new oidc.Configuration(server, config.clientId, undefined, clientAuthentication(config, server));
  configuration.timeout = requestTimeoutSeconds;
  if (fetchOverride) configuration[oidc.customFetch] = fetchOverride;
  for (const extension of execute) extension(configuration);
  return configuration;
}

function clientAuthentication(config: OidcConfig, server: oidc.ServerMetadata) {
  if (!config.clientSecret) return oidc.None();
  // Prefer client_secret_post when offered. openid-client form-encodes Basic
  // credentials as RFC 6749 requires, but plenty of providers skip the
  // decode, so a secret containing "-" or "." would fail there and only there.
  // Basic remains the spec default for providers that list nothing.
  const supported = server.token_endpoint_auth_methods_supported;
  if (supported?.includes("client_secret_post")) return oidc.ClientSecretPost(config.clientSecret);
  return oidc.ClientSecretBasic(config.clientSecret);
}
