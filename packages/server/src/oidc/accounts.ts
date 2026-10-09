import { and, eq, isNull, sql } from "drizzle-orm";
import type { OidcLoginErrorCode, UserRole } from "@carmel-agent/shared";
import { hasLoginCapableUser } from "../auth.ts";
import { db } from "../db/index.ts";
import { userIdentities, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import type { OidcClaims } from "./client.ts";
import type { OidcConfig } from "./config.ts";

/**
 * A sign-in refusal. The browser only ever receives `code`, never the message:
 * the error travels back through a redirect URL, and a free-text parameter
 * there is an invitation to put someone else's words on the login page.
 */
export class OidcLoginError extends Error {
  readonly code: OidcLoginErrorCode;

  constructor(code: OidcLoginErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type OidcProfile = {
  issuer: string;
  subject: string;
  username?: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  groups: string[];
};

type UserRow = typeof users.$inferSelect;

export function readOidcProfile(
  config: OidcConfig,
  issuer: string,
  claims: OidcClaims,
): OidcProfile {
  return {
    issuer,
    subject: claims.sub,
    username: stringClaim(claims[config.claims.username]),
    email: stringClaim(claims[config.claims.email]),
    // Some providers send the string "true"; nothing else counts.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: stringClaim(claims[config.claims.name]),
    groups: groupsClaim(claims[config.claims.groups]),
  };
}

/**
 * Find, link, or create the account an OIDC identity signs in as.
 *
 * In order: an identity seen before signs straight into its linked account; a
 * new identity is matched to an existing account by the configured fields;
 * failing that, a new account is created. Matching only ever happens once per
 * identity -- after it, the (issuer, subject) link is the sole key.
 */
export function resolveOidcUser(config: OidcConfig, profile: OidcProfile): UserRow {
  if (config.allowedGroups.length && !inAnyGroup(profile, config.allowedGroups)) {
    throw new OidcLoginError(
      "not_allowed",
      "Your account is not in a group that is allowed to use Carmel Agent.",
    );
  }

  return db.transaction(() => {
    const timestamp = now();
    const linked = db
      .select({ user: users })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(
        and(eq(userIdentities.issuer, profile.issuer), eq(userIdentities.subject, profile.subject)),
      )
      .get()?.user;
    if (linked) {
      db.update(userIdentities)
        .set({ lastLoginAt: timestamp })
        .where(
          and(
            eq(userIdentities.issuer, profile.issuer),
            eq(userIdentities.subject, profile.subject),
          ),
        )
        .run();
      return syncProfile(config, profile, linked, timestamp);
    }

    const matched = findMatchingUser(config, profile);
    if (matched) {
      linkIdentity(profile, matched.id, timestamp);
      return syncProfile(config, profile, matched, timestamp);
    }

    if (!config.autoCreate) {
      throw new OidcLoginError(
        "not_linked",
        "No Carmel Agent account is linked to this sign-in. Ask an administrator to create one.",
      );
    }
    return createUser(config, profile, timestamp);
  });
}

function findMatchingUser(config: OidcConfig, profile: OidcProfile) {
  for (const field of config.matchBy) {
    let candidates = matchCandidates(config, profile, field);
    // Emails are synced from the provider unverified, so anyone who can edit
    // theirs there can copy someone else's onto their own linked account.
    // Linked accounts are therefore never email candidates: the copy can
    // neither win the match nor make the real one ambiguous.
    if (field === "email")
      candidates = candidates.filter((candidate) => !linkedToIssuer(candidate.id, profile.issuer));
    if (candidates.length > 1) {
      throw new OidcLoginError(
        "ambiguous_account",
        `More than one account has this ${field}. Ask an administrator to resolve the duplicate.`,
      );
    }
    const candidate = candidates[0];
    if (!candidate) continue;

    // An account already claimed by another identity from this provider stays
    // theirs: whoever now holds the same username is someone else.
    if (linkedToIssuer(candidate.id, profile.issuer)) {
      throw new OidcLoginError(
        "already_linked",
        `The account with this ${field} is already linked to a different sign-in.`,
      );
    }
    return candidate;
  }
  return undefined;
}

function matchCandidates(
  config: OidcConfig,
  profile: OidcProfile,
  field: OidcConfig["matchBy"][number],
) {
  if (field === "username") {
    if (!profile.username) return [];
    // Case-insensitive: Pocket ID, like many providers, only allows lowercase
    // usernames, while a Carmel username may have been created as "Mudkip".
    return usersWithUsername(profile.username);
  }
  if (!profile.email) return [];
  if (!isEmailTrusted(config, profile)) {
    console.warn(
      `OIDC: not matching ${profile.subject} by email because the provider did not mark it verified (set CARMEL_OIDC_REQUIRE_VERIFIED_EMAIL=false to trust it anyway).`,
    );
    return [];
  }
  return db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, profile.email.toLowerCase()))
    .all();
}

function createUser(config: OidcConfig, profile: OidcProfile, timestamp: number) {
  // The very first account on an instance is its administrator, exactly as
  // with first-run setup -- and like setup, it takes over the seeded
  // placeholder so the default agent and model become its own.
  const firstAccount = !hasLoginCapableUser();
  const role = roleFromGroups(config, profile) ?? (firstAccount ? "admin" : "user");
  const placeholder = firstAccount
    ? db.select().from(users).where(isNull(users.passwordHash)).orderBy(users.createdAt).get()
    : undefined;
  warnAboutUnmatchedAccounts(config, profile, placeholder?.id);
  const username =
    profile.username && !usernameTaken(profile.username, placeholder?.id) ? profile.username : null;
  const values = {
    username,
    name: profile.name || profile.username || profile.email || "User",
    email: profile.email ?? "",
    role,
    updatedAt: timestamp,
  };

  const userId = placeholder?.id ?? id("user");
  if (placeholder) {
    db.update(users).set(values).where(eq(users.id, userId)).run();
  } else {
    db.insert(users)
      .values({ id: userId, ...values, createdAt: timestamp })
      .run();
  }
  linkIdentity(profile, userId, timestamp);
  return db.select().from(users).where(eq(users.id, userId)).get()!;
}

/**
 * The provider owns name, email, and -- when admin groups are configured --
 * role. Email is kept whether or not it is verified; verification only decides
 * whether it may be used to match accounts. Username is left alone after
 * creation: it doubles as the password login name, and renaming at the
 * provider must not collide with or take over another local account's.
 */
function syncProfile(config: OidcConfig, profile: OidcProfile, user: UserRow, timestamp: number) {
  const email = profile.email;
  const role = roleFromGroups(config, profile);
  const patch = {
    ...(profile.name && profile.name !== user.name ? { name: profile.name } : {}),
    ...(email && email !== user.email ? { email } : {}),
    ...(role && role !== user.role ? { role } : {}),
  };
  if (!Object.keys(patch).length) return user;
  db.update(users)
    .set({ ...patch, updatedAt: timestamp })
    .where(eq(users.id, user.id))
    .run();
  return db.select().from(users).where(eq(users.id, user.id)).get()!;
}

function linkedToIssuer(userId: string, issuer: string) {
  return Boolean(
    db
      .select({ subject: userIdentities.subject })
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.issuer, issuer)))
      .get(),
  );
}

function linkIdentity(profile: OidcProfile, userId: string, timestamp: number) {
  db.insert(userIdentities)
    .values({
      issuer: profile.issuer,
      subject: profile.subject,
      userId,
      createdAt: timestamp,
      lastLoginAt: timestamp,
    })
    .run();
}

function usersWithUsername(username: string) {
  return db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
    .all();
}

function usernameTaken(username: string, exceptUserId: string | undefined) {
  return usersWithUsername(username).some((user) => user.id !== exceptUserId);
}

/**
 * Creating a second account for someone who already has one is the most
 * likely surprise in this whole flow, and it is always a configuration
 * choice. Say so in the log, naming the variable that would have linked them.
 */
function warnAboutUnmatchedAccounts(
  config: OidcConfig,
  profile: OidcProfile,
  exceptUserId: string | undefined,
) {
  const unlinked = (candidates: UserRow[]) =>
    candidates.some((user) => user.id !== exceptUserId && !linkedToIssuer(user.id, profile.issuer));
  if (
    profile.username &&
    !config.matchBy.includes("username") &&
    unlinked(usersWithUsername(profile.username))
  ) {
    console.warn(
      `OIDC: creating a new account for "${profile.username}" although an existing account has that username. Set CARMEL_OIDC_MATCH_BY=username to link to it instead.`,
    );
  }
  if (profile.email && !config.matchBy.includes("email")) {
    const sameEmail = db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, profile.email.toLowerCase()))
      .all();
    if (unlinked(sameEmail)) {
      console.warn(
        `OIDC: creating a new account for subject ${profile.subject} although an existing account has the same email. Set CARMEL_OIDC_MATCH_BY=email to link to it instead.`,
      );
    }
  }
}

function roleFromGroups(config: OidcConfig, profile: OidcProfile): UserRole | undefined {
  if (!config.adminGroups.length) return undefined;
  return inAnyGroup(profile, config.adminGroups) ? "admin" : "user";
}

function isEmailTrusted(config: OidcConfig, profile: OidcProfile) {
  return Boolean(profile.email) && (profile.emailVerified || !config.requireVerifiedEmail);
}

function inAnyGroup(profile: OidcProfile, groups: string[]) {
  return groups.some((group) => profile.groups.includes(group));
}

function stringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function groupsClaim(value: unknown) {
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}
