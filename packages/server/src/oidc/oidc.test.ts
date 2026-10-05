import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { hashPassword, requireAuth, type AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { userIdentities, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createAuthRoutes } from "../routes/auth.ts";
import { createUserRoutes } from "../routes/users.ts";
import { OidcLoginError, resolveOidcUser, type OidcProfile } from "./accounts.ts";
import { setOidcFetchForTests } from "./client.ts";
import { assertOidcConfig, readOidcConfig } from "./config.ts";

initialize();

const issuer = "https://id.example.test";
const baseEnv = {
  CARMEL_OIDC_ISSUER: issuer,
  CARMEL_OIDC_CLIENT_ID: "carmel",
  CARMEL_OIDC_CLIENT_SECRET: "client-secret",
  CARMEL_PUBLIC_URL: "https://carmel.example.test",
  CARMEL_OIDC_PROVIDER_NAME: "Pocket ID",
};

function config(overrides: Record<string, string> = {}) {
  return readOidcConfig({ ...baseEnv, ...overrides })!;
}

function profile(overrides: Partial<OidcProfile> = {}): OidcProfile {
  return {
    issuer,
    subject: randomUUID(),
    emailVerified: true,
    groups: [],
    ...overrides,
  };
}

function insertUser(values: { username?: string; email?: string; password?: string; role?: "admin" | "user" } = {}) {
  const userId = id("user");
  const timestamp = now();
  db.insert(users)
    .values({
      id: userId,
      username: values.username ?? null,
      passwordHash: values.password ?? null,
      name: values.username ?? "Local",
      email: values.email ?? `${userId}@local`,
      role: values.role ?? "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return userId;
}

function refusal(code: string) {
  return (error: unknown) => error instanceof OidcLoginError && error.code === code;
}

// --- configuration ---------------------------------------------------------

test("OIDC is off without an issuer, and on with sensible Pocket ID-friendly defaults", () => {
  assert.equal(readOidcConfig({}), undefined);

  const parsed = config();
  assert.equal(parsed.redirectUri, "https://carmel.example.test/api/auth/oidc/callback");
  assert.deepEqual(parsed.scopes, ["openid", "profile", "email"]);
  assert.deepEqual(parsed.claims, { username: "preferred_username", email: "email", name: "name", groups: "groups" });
  assert.deepEqual(parsed.matchBy, ["email", "username"]);
  assert.equal(parsed.requireVerifiedEmail, true);
  assert.equal(parsed.autoCreate, true);
});

test("group settings request the groups scope unless scopes are set explicitly", () => {
  assert.deepEqual(config({ CARMEL_OIDC_ADMIN_GROUPS: "carmel-admins" }).scopes, ["openid", "profile", "email", "groups"]);
  assert.deepEqual(
    config({ CARMEL_OIDC_ADMIN_GROUPS: "carmel-admins", CARMEL_OIDC_SCOPES: "openid email" }).scopes,
    ["openid", "email"],
  );
});

test("match fields parse in priority order and reject unknown values", () => {
  assert.deepEqual(config({ CARMEL_OIDC_MATCH_BY: "email, username" }).matchBy, ["email", "username"]);
  assert.deepEqual(config({ CARMEL_OIDC_MATCH_BY: "none" }).matchBy, []);
  assert.throws(() => config({ CARMEL_OIDC_MATCH_BY: "sub" }), /CARMEL_OIDC_MATCH_BY/);
});

test("the public URL keeps a path prefix in the redirect URI", () => {
  assert.equal(
    config({ CARMEL_PUBLIC_URL: "https://example.test/carmel" }).redirectUri,
    "https://example.test/carmel/api/auth/oidc/callback",
  );
});

test("misconfiguration names the variable at fault", () => {
  assert.throws(() => readOidcConfig({ CARMEL_OIDC_ISSUER: issuer }), /CARMEL_OIDC_CLIENT_ID/);
  assert.throws(() => readOidcConfig({ ...baseEnv, CARMEL_PUBLIC_URL: "" }), /CARMEL_PUBLIC_URL/);
  assert.throws(() => config({ CARMEL_OIDC_AUTO_CREATE: "maybe" }), /CARMEL_OIDC_AUTO_CREATE/);
  assert.throws(() => config({ CARMEL_OIDC_SCOPES: "profile email" }), /openid/);
  assert.throws(() => assertOidcConfig({ CARMEL_PASSWORD_LOGIN: "false" }), /CARMEL_PASSWORD_LOGIN/);
});

// --- account resolution ----------------------------------------------------
// Order matters in this section: the first test runs against an instance
// nobody can sign in to yet.

test("the first OIDC account on a fresh instance claims the seeded placeholder as admin", () => {
  const placeholderId = insertUser();
  const user = resolveOidcUser(
    config(),
    profile({ username: "first", email: "first@example.test", name: "First Person" }),
  );
  assert.equal(user.id, placeholderId);
  assert.equal(user.role, "admin");
  assert.equal(user.username, "first");
  assert.equal(user.email, "first@example.test");
  assert.equal(user.name, "First Person");
});

test("later accounts are created as ordinary users", () => {
  const user = resolveOidcUser(config(), profile({ username: `later_${randomUUID()}` }));
  assert.equal(user.role, "user");
});

test("a linked identity keeps signing in to its account after the username and email change", () => {
  const cfg = config({ CARMEL_OIDC_MATCH_BY: "username,email" });
  const identity = profile({ username: `stable_${randomUUID()}`, email: "stable@example.test" });
  const created = resolveOidcUser(cfg, identity);

  const renamed = resolveOidcUser(cfg, { ...identity, username: "renamed", email: "renamed@example.test", name: "Renamed" });
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.email, "renamed@example.test");
  assert.equal(renamed.name, "Renamed");
  // Username is not synced: it is also the password login name.
  assert.equal(renamed.username, identity.username);
});

test("username matching links a new identity to the existing local account", async () => {
  const username = `alice_${randomUUID()}`;
  const localId = insertUser({ username, password: await hashPassword("password1") });
  const user = resolveOidcUser(config({ CARMEL_OIDC_MATCH_BY: "username" }), profile({ username }));
  assert.equal(user.id, localId);
  assert.ok(db.select().from(userIdentities).where(eq(userIdentities.userId, localId)).get());
});

test("by default a first sign-in links by verified email, then by username", async () => {
  const username = `ivy_${randomUUID()}`;
  const localId = insertUser({ username, password: await hashPassword("password1") });
  // Pocket ID's default: an unverified email, so the username decides.
  const user = resolveOidcUser(config(), profile({ username, email: `${username}@example.test`, emailVerified: false }));
  assert.equal(user.id, localId);
});

test("username matching ignores case, since Pocket ID only allows lowercase usernames", () => {
  const suffix = randomUUID();
  const localId = insertUser({ username: `Grace_${suffix}` });
  const user = resolveOidcUser(config({ CARMEL_OIDC_MATCH_BY: "username" }), profile({ username: `grace_${suffix}` }));
  assert.equal(user.id, localId);
});

test("without username matching, a same-name account is left alone and the reason is logged", (t) => {
  const username = `henry_${randomUUID()}`;
  const localId = insertUser({ username });
  const warn = t.mock.method(console, "warn", () => {});
  const user = resolveOidcUser(config({ CARMEL_OIDC_MATCH_BY: "none" }), profile({ username }));
  assert.notEqual(user.id, localId);
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes("CARMEL_OIDC_MATCH_BY=username")));
});

test("email matching is case-insensitive and requires a verified email by default", () => {
  const email = `Bob.${randomUUID()}@Example.test`;
  const localId = insertUser({ email });
  const cfg = config({ CARMEL_OIDC_MATCH_BY: "email", CARMEL_OIDC_AUTO_CREATE: "false" });

  assert.throws(() => resolveOidcUser(cfg, profile({ email: email.toLowerCase(), emailVerified: false })), refusal("not_linked"));
  assert.equal(resolveOidcUser(cfg, profile({ email: email.toLowerCase() })).id, localId);

  const trusting = config({ CARMEL_OIDC_MATCH_BY: "email", CARMEL_OIDC_REQUIRE_VERIFIED_EMAIL: "false" });
  const otherEmail = `carol.${randomUUID()}@example.test`;
  const otherId = insertUser({ email: otherEmail });
  assert.equal(resolveOidcUser(trusting, profile({ email: otherEmail, emailVerified: false })).id, otherId);
});

test("match fields are tried in order", () => {
  const username = `dave_${randomUUID()}`;
  const email = `dave.${randomUUID()}@example.test`;
  const byUsername = insertUser({ username });
  const byEmail = insertUser({ email });
  const identity = profile({ username, email });
  assert.equal(resolveOidcUser(config({ CARMEL_OIDC_MATCH_BY: "email,username" }), identity).id, byEmail);
  assert.equal(resolveOidcUser(config({ CARMEL_OIDC_MATCH_BY: "username,email" }), { ...identity, subject: randomUUID() }).id, byUsername);
});

test("an account already linked to another identity is never handed to a new one", () => {
  const username = `erin_${randomUUID()}`;
  const cfg = config({ CARMEL_OIDC_MATCH_BY: "username" });
  resolveOidcUser(cfg, profile({ username }));
  assert.throws(() => resolveOidcUser(cfg, profile({ username })), refusal("already_linked"));
});

test("an email copied onto a linked account neither wins the match nor blocks it", () => {
  const email = `victim.${randomUUID()}@example.test`;
  const cfg = config({ CARMEL_OIDC_MATCH_BY: "email" });
  // Someone else's account picks up the address through an unverified sync.
  const copycat = resolveOidcUser(cfg, profile({ email: "copycat@example.test" }));
  resolveOidcUser(cfg, profile({ subject: db.select().from(userIdentities).where(eq(userIdentities.userId, copycat.id)).get()!.subject, email, emailVerified: false }));
  assert.equal(db.select().from(users).where(eq(users.id, copycat.id)).get()!.email, email);

  const victimId = insertUser({ email });
  assert.equal(resolveOidcUser(cfg, profile({ email })).id, victimId);
});

test("an email shared by several accounts refuses rather than guessing", () => {
  const email = `shared.${randomUUID()}@example.test`;
  insertUser({ email });
  insertUser({ email });
  assert.throws(
    () => resolveOidcUser(config({ CARMEL_OIDC_MATCH_BY: "email" }), profile({ email })),
    refusal("ambiguous_account"),
  );
});

test("without a match and with auto-create off, sign-in is refused", () => {
  assert.throws(
    () => resolveOidcUser(config({ CARMEL_OIDC_AUTO_CREATE: "false" }), profile({ username: `nobody_${randomUUID()}` })),
    refusal("not_linked"),
  );
});

test("a new account whose username is taken locally is created without one", () => {
  const username = `frank_${randomUUID()}`;
  const localId = insertUser({ username });
  const user = resolveOidcUser(config({ CARMEL_OIDC_MATCH_BY: "none" }), profile({ username }));
  assert.notEqual(user.id, localId);
  assert.equal(user.username, null);
});

test("allowed groups gate sign-in, and admin groups set the role on every sign-in", () => {
  const cfg = config({ CARMEL_OIDC_ALLOWED_GROUPS: "carmel", CARMEL_OIDC_ADMIN_GROUPS: "carmel-admins" });
  assert.throws(() => resolveOidcUser(cfg, profile({ groups: ["other"] })), refusal("not_allowed"));

  const identity = profile({ groups: ["carmel", "carmel-admins"] });
  assert.equal(resolveOidcUser(cfg, identity).role, "admin");
  assert.equal(resolveOidcUser(cfg, { ...identity, groups: ["carmel"] }).role, "user");
});

// --- the HTTP flow, against a fake provider ----------------------------------

/** Either client_secret_post or client_secret_basic (form-decoded, as RFC 6749 says). */
function clientAuthenticated(authorization: string | undefined, form: URLSearchParams) {
  if (authorization?.startsWith("Basic ")) {
    const [clientId, secret] = Buffer.from(authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent);
    return clientId === "carmel" && secret === "client-secret";
  }
  return form.get("client_id") === "carmel" && form.get("client_secret") === "client-secret";
}

type Grant = { nonce: string; challenge: string; redirectUri: string; claims: Record<string, unknown> };

function createFakeProvider(claimsFor: () => Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, Record<string, unknown>>();
  const provider = new Hono();

  const signJwt = (payload: Record<string, unknown>) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(payload)}`;
    return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
  };

  // The document shape Pocket ID serves.
  provider.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/api/oidc/token`,
      userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email", "groups"],
    }),
  );
  provider.get("/.well-known/jwks.json", (c) =>
    c.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] }),
  );
  provider.post("/api/oidc/token", async (c) => {
    const form = new URLSearchParams(await c.req.text());
    if (!clientAuthenticated(c.req.header("authorization"), form)) return c.json({ error: "invalid_client" }, 401);
    const grant = grants.get(form.get("code") ?? "");
    grants.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    if (
      !grant ||
      grant.redirectUri !== form.get("redirect_uri") ||
      createHash("sha256").update(verifier).digest("base64url") !== grant.challenge
    ) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const accessToken = randomUUID();
    accessTokens.set(accessToken, grant.claims);
    const timestamp = Math.floor(Date.now() / 1000);
    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: signJwt({
        iss: issuer,
        aud: "carmel",
        sub: grant.claims.sub,
        iat: timestamp,
        exp: timestamp + 3600,
        nonce: grant.nonce,
        // Keep profile claims out of the ID token so userinfo has to supply them.
      }),
    });
  });
  provider.get("/api/oidc/userinfo", (c) => {
    const claims = accessTokens.get((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    return claims ? c.json(claims) : c.json({ error: "invalid_token" }, 401);
  });

  return {
    fetch: (url: string, options: { method: string; headers: Record<string, string>; body?: unknown }) =>
      provider.request(url, { method: options.method, headers: options.headers, body: options.body as BodyInit }),
    /** What the provider's login page would do: approve and redirect back with a code. */
    authorize(authorizationUrl: URL) {
      const code = randomUUID();
      grants.set(code, {
        nonce: authorizationUrl.searchParams.get("nonce")!,
        challenge: authorizationUrl.searchParams.get("code_challenge")!,
        redirectUri: authorizationUrl.searchParams.get("redirect_uri")!,
        claims: claimsFor(),
      });
      return `?code=${code}&state=${authorizationUrl.searchParams.get("state")}`;
    },
  };
}

function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/api/*", requireAuth);
  app.route("/api/auth", createAuthRoutes());
  app.route("/api", createUserRoutes());
  app.get("/api/me", (c) => c.json({ id: c.get("user").id, username: c.get("user").username }));
  return app;
}

function withOidcEnv(overrides: Record<string, string>, run: () => Promise<void>) {
  return async () => {
    const env = { ...baseEnv, ...overrides };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      await run();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      setOidcFetchForTests(undefined);
    }
  };
}

const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).find((cookie) => cookie.startsWith(`${name}=`));

test(
  "the login redirect and callback sign the browser in with a Pocket ID-shaped provider",
  withOidcEnv({ CARMEL_OIDC_MATCH_BY: "username" }, async () => {
    const username = `pocket_${randomUUID()}`;
    const subject = randomUUID();
    const provider = createFakeProvider(() => ({
      sub: subject,
      preferred_username: username,
      email: `${username}@example.test`,
      email_verified: true,
      name: "Pocket Person",
      groups: ["carmel"],
    }));
    setOidcFetchForTests(provider.fetch as never);
    const app = buildApp();

    const status = await (await app.request("/api/auth/status")).json();
    assert.deepEqual(status.oidc, { providerName: "Pocket ID" });

    const start = await app.request("/api/auth/oidc/login");
    assert.equal(start.status, 302);
    const authorizationUrl = new URL(start.headers.get("location")!);
    assert.equal(authorizationUrl.origin + authorizationUrl.pathname, `${issuer}/authorize`);
    assert.equal(authorizationUrl.searchParams.get("client_id"), "carmel");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://carmel.example.test/api/auth/oidc/callback");
    const flowCookie = cookieValue(start, "carmel_oidc");
    assert.ok(flowCookie);

    const callbackQuery = provider.authorize(authorizationUrl);
    const callback = await app.request(`/api/auth/oidc/callback${callbackQuery}`, { headers: { cookie: flowCookie } });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/");
    const session = cookieValue(callback, "carmel_session");
    assert.ok(session);

    const me = await (await app.request("/api/me", { headers: { cookie: session } })).json();
    assert.equal(me.username, username);
    const stored = db.select().from(users).where(eq(users.id, me.id)).get()!;
    assert.equal(stored.name, "Pocket Person");

    // The flow is single use: replaying the callback does not sign in again.
    const replay = await app.request(`/api/auth/oidc/callback${callbackQuery}`, { headers: { cookie: flowCookie } });
    assert.equal(replay.headers.get("location"), "/?auth_error=expired");
    assert.equal(cookieValue(replay, "carmel_session"), undefined);
  }),
);

test(
  "a callback from a different browser, or with a forged state, is refused",
  withOidcEnv({}, async () => {
    const provider = createFakeProvider(() => ({ sub: randomUUID() }));
    setOidcFetchForTests(provider.fetch as never);
    const app = buildApp();

    const start = await app.request("/api/auth/oidc/login");
    const authorizationUrl = new URL(start.headers.get("location")!);
    const callbackQuery = provider.authorize(authorizationUrl);

    const noCookie = await app.request(`/api/auth/oidc/callback${callbackQuery}`);
    assert.equal(noCookie.headers.get("location"), "/?auth_error=expired");

    const second = await app.request("/api/auth/oidc/login");
    const forged = callbackQuery.replace(/state=[^&]+/, "state=forged");
    const refused = await app.request(`/api/auth/oidc/callback${forged}`, {
      headers: { cookie: cookieValue(second, "carmel_oidc")! },
    });
    assert.equal(refused.headers.get("location"), "/?auth_error=failed");
    assert.equal(cookieValue(refused, "carmel_session"), undefined);
  }),
);

test(
  "a person who cancels at the provider comes back with a denied error",
  withOidcEnv({}, async () => {
    setOidcFetchForTests(createFakeProvider(() => ({ sub: randomUUID() })).fetch as never);
    const app = buildApp();
    const start = await app.request("/api/auth/oidc/login");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const denied = await app.request(`/api/auth/oidc/callback?error=access_denied&state=${state}`, {
      headers: { cookie: cookieValue(start, "carmel_oidc")! },
    });
    assert.equal(denied.headers.get("location"), "/?auth_error=denied");
  }),
);

test(
  "an unreachable provider sends the browser back with an error instead of a 500",
  withOidcEnv({}, async () => {
    setOidcFetchForTests((() => Promise.reject(new Error("connect ECONNREFUSED"))) as never);
    const start = await buildApp().request("/api/auth/oidc/login");
    assert.equal(start.status, 302);
    assert.equal(start.headers.get("location"), "/?auth_error=failed");
  }),
);

test(
  "with password login disabled, the password endpoints refuse and status says so",
  withOidcEnv({ CARMEL_PASSWORD_LOGIN: "false" }, async () => {
    const app = buildApp();
    const json = { "content-type": "application/json" };
    const status = await (await app.request("/api/auth/status")).json();
    assert.equal(status.passwordLogin, false);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "first", password: "whatever1" }),
    });
    assert.equal(login.status, 403);
    const setup = await app.request("/api/auth/setup", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "x", password: "whatever1" }),
    });
    assert.equal(setup.status, 403);
  }),
);

test("OIDC endpoints are absent when OIDC is not configured", async () => {
  const app = buildApp();
  assert.equal((await app.request("/api/auth/oidc/login")).status, 404);
  assert.equal((await (await app.request("/api/auth/status")).json()).oidc, undefined);
});

test("deleting a user removes their linked identities", async () => {
  const admin = insertUser({ username: `admin_${randomUUID()}`, password: await hashPassword("adminpass1"), role: "admin" });
  const linked = resolveOidcUser(config(), profile());
  const app = buildApp();
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: db.select().from(users).where(eq(users.id, admin)).get()!.username, password: "adminpass1" }),
  });
  const cookie = cookieValue(login, "carmel_session")!;
  const removed = await app.request(`/api/users/${linked.id}`, { method: "DELETE", headers: { cookie } });
  assert.equal(removed.status, 200);
  assert.equal(db.select().from(userIdentities).where(eq(userIdentities.userId, linked.id)).get(), undefined);
});
