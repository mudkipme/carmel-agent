import { agentSecretNameError, reservedAgentSecretNames } from "@carmel-agent/shared";
import type { EnvironmentSecret, SessionSecret } from "@carmel-agent/shared";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, environmentSecrets, environments, sessions } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { resolveEnvironmentWorkingDirPath } from "../runtime/resources.ts";
import { readWorkspaceDotEnvFile, workspaceDotEnvAvailable } from "../runtime/workspace-dotenv.ts";
import { encryptSubmittedSecret, protectSecret, revealSecret } from "../security.ts";
import { errorMessage } from "../errors.ts";

type SecretRecord = typeof environmentSecrets.$inferSelect;

export class SecretError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(message);
  }
}

/**
 * Secrets are owner-only, even to read.
 *
 * Tasks settled for "admins see all" because an admin holding the API keys
 * should be able to find what is spending them. Secrets are the opposite case:
 * knowing that an environment carries a `STRIPE_KEY` is itself a disclosure,
 * and no operational question needs it. Values never leave the server either way.
 */
function assertEnvironmentOwner(userId: string, environmentId: string) {
  const environment = db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .get();
  if (!environment) throw new SecretError("Environment not found.", 404);
  if (environment.ownerUserId !== userId)
    throw new SecretError("Environment secrets are owner-only.", 403);
  return environment;
}

/** The environment a session's commands run in: its agent's current one. */
function sessionEnvironmentId(session: typeof sessions.$inferSelect) {
  return db
    .select({ environmentId: agents.environmentId })
    .from(agents)
    .where(eq(agents.id, session.agentId))
    .get()!.environmentId;
}

export function readEnvironmentSecrets(userId: string, environmentId: string): EnvironmentSecret[] {
  assertEnvironmentOwner(userId, environmentId);
  return db
    .select()
    .from(environmentSecrets)
    .where(
      and(
        eq(environmentSecrets.environmentId, environmentId),
        isNull(environmentSecrets.sessionId),
      ),
    )
    .orderBy(asc(environmentSecrets.name))
    .all()
    .map(serializeEnvironmentSecret);
}

export function environmentWorkspaceDotEnvStatus(userId: string, environmentId: string) {
  const environment = assertEnvironmentOwner(userId, environmentId);
  return { available: workspaceDotEnvAvailable(resolveEnvironmentWorkingDirPath(environment)) };
}

export function importEnvironmentWorkspaceDotEnv(userId: string, environmentId: string) {
  const environment = assertEnvironmentOwner(userId, environmentId);
  const entries = readWorkspaceDotEnvFile(resolveEnvironmentWorkingDirPath(environment));
  if (!entries) throw new SecretError("No readable .env file in the workspace root.", 404);

  return db.transaction(() => {
    let imported = 0;
    let skippedExisting = 0;
    let skippedInvalid = 0;
    const existingNames = new Set(
      db
        .select({ name: environmentSecrets.name })
        .from(environmentSecrets)
        .where(
          and(
            eq(environmentSecrets.environmentId, environmentId),
            isNull(environmentSecrets.sessionId),
          ),
        )
        .all()
        .map((secret) => secret.name),
    );
    for (const [name, value] of Object.entries(entries)) {
      if (agentSecretNameError(name) || !value || value.length > 8192 || value.includes("\0")) {
        skippedInvalid++;
        continue;
      }
      if (existingNames.has(name)) {
        skippedExisting++;
        continue;
      }
      const timestamp = now();
      const result = db
        .insert(environmentSecrets)
        .values({
          environmentId,
          name,
          value: protectSubmittedSecret(value),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes) imported++;
      else skippedExisting++;
    }
    return { imported, skippedExisting, skippedInvalid };
  });
}

export function writeEnvironmentSecret(
  userId: string,
  environmentId: string,
  name: string,
  value: string,
): EnvironmentSecret {
  assertEnvironmentOwner(userId, environmentId);
  const nameError = agentSecretNameError(name);
  if (nameError) throw new SecretError(nameError, 400);
  if (!value || value.length > 8192 || value.includes("\0"))
    throw new SecretError("Invalid secret value.", 400);

  const timestamp = now();
  const current = readSecretRow(environmentId, name);
  const fields = {
    environmentId,
    name,
    value: protectSubmittedSecret(value),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  if (current)
    db.update(environmentSecrets).set(fields).where(eq(environmentSecrets.id, current.id)).run();
  else db.insert(environmentSecrets).values(fields).run();
  return serializeEnvironmentSecret(readSecretRow(environmentId, name)!);
}

function protectSubmittedSecret(value: string): string {
  // Never accept a client's enc:v1: prefix as proof of encryption.
  if (!value.startsWith("enc:v1:")) return protectSecret(value)!;
  try {
    return encryptSubmittedSecret(value);
  } catch {
    throw new SecretError(
      "Configure CARMEL_SECRET_KEY before storing credentials with the internal encryption prefix.",
      503,
    );
  }
}

export function deleteEnvironmentSecret(userId: string, environmentId: string, name: string) {
  assertEnvironmentOwner(userId, environmentId);
  const row = readSecretRow(environmentId, name);
  if (!row) throw new SecretError("Secret not found.", 404);
  db.delete(environmentSecrets).where(eq(environmentSecrets.id, row.id)).run();
}

/**
 * Decrypted credentials for authorized server-side execution and redaction.
 * Values are never returned by a serializer or a browser API.
 *
 * Reserved names are filtered again here rather than trusted from write time,
 * so a row that predates a name becoming reserved -- or one written straight to
 * the database -- still cannot redefine `PATH` under a running agent.
 *
 * Session credentials follow their session, so they apply only while that
 * session's agent runs in this environment.
 */
export function readEnvironmentSecretEnv(
  environmentId: string,
  sessionId?: string,
): Array<{ name: string; value: string }> {
  if (sessionId) {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session || sessionEnvironmentId(session) !== environmentId)
      throw new SecretError("Session not found.", 404);
  }
  const records = db
    .select()
    .from(environmentSecrets)
    .where(
      sessionId
        ? or(
            and(
              eq(environmentSecrets.environmentId, environmentId),
              isNull(environmentSecrets.sessionId),
            ),
            eq(environmentSecrets.sessionId, sessionId),
          )
        : and(
            eq(environmentSecrets.environmentId, environmentId),
            isNull(environmentSecrets.sessionId),
          ),
    )
    .all()
    .filter((row) => !reservedAgentSecretNames.has(row.name));
  return [...effectiveSecrets(records).values()].map((row) => ({
    name: row.name,
    value: decryptSecret(row),
  }));
}

/** Every secret a session's commands receive, as rows. Session credentials win over defaults. */
function effectiveSecrets(records: SecretRecord[]) {
  const effective = new Map<string, SecretRecord>();
  for (const row of records.filter((row) => !row.sessionId)) effective.set(row.name, row);
  for (const row of records.filter((row) => row.sessionId)) effective.set(row.name, row);
  return effective;
}

export function assertSessionOwner(userId: string, sessionId: string) {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.userId !== userId) throw new SecretError("Session not found.", 404);
  return session;
}

export function serializeCredential(row: SecretRecord): SessionSecret {
  return {
    id: row.id,
    name: row.name,
    scope: row.sessionId ? "session" : "agent",
    updatedAt: row.updatedAt,
  };
}

/** Rows a session can use: its own credentials plus its environment's defaults. */
function sessionSecretRows(session: typeof sessions.$inferSelect, includeDefaults = true) {
  const environmentId = sessionEnvironmentId(session);
  return db
    .select()
    .from(environmentSecrets)
    .where(
      includeDefaults
        ? or(
            and(
              eq(environmentSecrets.environmentId, environmentId),
              isNull(environmentSecrets.sessionId),
            ),
            eq(environmentSecrets.sessionId, session.id),
          )
        : eq(environmentSecrets.sessionId, session.id),
    )
    .all();
}

function ownsSessionEnvironment(userId: string, session: typeof sessions.$inferSelect) {
  return (
    db
      .select({ ownerUserId: environments.ownerUserId })
      .from(environments)
      .where(eq(environments.id, sessionEnvironmentId(session)))
      .get()?.ownerUserId === userId
  );
}

export function readSessionSecrets(userId: string, sessionId: string): SessionSecret[] {
  const session = assertSessionOwner(userId, sessionId);
  const records = sessionSecretRows(session, ownsSessionEnvironment(userId, session));
  return [...effectiveSecrets(records).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(serializeCredential);
}

export function findAvailableSecret(sessionId: string, name: string) {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new SecretError("Session not found.", 404);
  const records = sessionSecretRows(session).filter((row) => row.name === name);
  const row = records.find((row) => row.sessionId === sessionId) ?? records[0];
  if (!row) return undefined;
  decryptSecret(row); // Availability also means it can actually be decrypted.
  return serializeCredential(row);
}

export function storeSessionSecret(userId: string, sessionId: string, name: string, value: string) {
  const session = assertSessionOwner(userId, sessionId);
  const nameError = agentSecretNameError(name);
  if (nameError) throw new SecretError(nameError, 400);
  if (!value || value.length > 65536 || value.includes("\0"))
    throw new SecretError("Invalid secret value.", 400);
  const existing = db
    .select()
    .from(environmentSecrets)
    .where(and(eq(environmentSecrets.sessionId, sessionId), eq(environmentSecrets.name, name)))
    .get();
  if (existing)
    throw new SecretError(
      "This session credential already exists. Revoke it before replacing it.",
      409,
    );
  let encrypted: string;
  try {
    encrypted = encryptSubmittedSecret(value);
  } catch {
    throw new SecretError("Configure CARMEL_SECRET_KEY before storing session credentials.", 503);
  }
  const row = {
    id: crypto.randomUUID(),
    environmentId: sessionEnvironmentId(session),
    sessionId,
    name,
    value: encrypted,
    createdAt: now(),
    updatedAt: now(),
  };
  db.insert(environmentSecrets).values(row).run();
  return serializeCredential(row);
}

/** Save a session credential as an environment default, for every agent in it. */
export function promoteSessionSecret(
  userId: string,
  sessionId: string,
  secretId: string,
): SessionSecret {
  const session = assertSessionOwner(userId, sessionId);
  const environmentId = sessionEnvironmentId(session);
  assertEnvironmentOwner(userId, environmentId);
  return db.transaction(() => {
    const row = sessionSecretRows(session).find((row) => row.id === secretId);
    if (!row) throw new SecretError("Secret not found.", 404);
    if (!row.sessionId) return serializeCredential(row);
    if (readSecretRow(environmentId, row.name))
      throw new SecretError(
        "An environment credential with this name already exists. It was not overwritten.",
        409,
      );
    const updatedAt = now();
    db.update(environmentSecrets)
      .set({ environmentId, sessionId: null, updatedAt })
      .where(eq(environmentSecrets.id, row.id))
      .run();
    return serializeCredential({ ...row, environmentId, sessionId: null, updatedAt });
  });
}

export function demoteEnvironmentSecret(userId: string, sessionId: string, secretId: string) {
  const session = assertSessionOwner(userId, sessionId);
  const environmentId = sessionEnvironmentId(session);
  assertEnvironmentOwner(userId, environmentId);
  const row = db
    .select()
    .from(environmentSecrets)
    .where(
      and(
        eq(environmentSecrets.id, secretId),
        eq(environmentSecrets.environmentId, environmentId),
        isNull(environmentSecrets.sessionId),
      ),
    )
    .get();
  if (!row) throw new SecretError("Secret not found.", 404);
  const collision = db
    .select()
    .from(environmentSecrets)
    .where(and(eq(environmentSecrets.sessionId, sessionId), eq(environmentSecrets.name, row.name)))
    .get();
  if (collision)
    throw new SecretError("This session already has a credential with this name.", 409);
  const updatedAt = now();
  db.update(environmentSecrets)
    .set({ sessionId, updatedAt })
    .where(eq(environmentSecrets.id, row.id))
    .run();
  return serializeCredential({ ...row, sessionId, updatedAt });
}

export function revokeSessionSecret(userId: string, sessionId: string, secretId: string) {
  const session = assertSessionOwner(userId, sessionId);
  const row = sessionSecretRows(session).find((row) => row.id === secretId);
  if (!row) throw new SecretError("Secret not found.", 404);
  if (!row.sessionId) assertEnvironmentOwner(userId, row.environmentId);
  db.delete(environmentSecrets).where(eq(environmentSecrets.id, secretId)).run();
}

/**
 * A missing key is a hard failure rather than a silently absent variable.
 *
 * An agent that runs `gh` with no token does not stop -- it takes a different,
 * wrong path and reports something plausible. Refusing the command is the
 * recoverable outcome.
 */
function decryptSecret(row: SecretRecord) {
  try {
    return revealSecret(row.value) ?? "";
  } catch (error) {
    throw new Error(
      `Cannot decrypt the secret "${row.name}": ${errorMessage(error, String(error))}`,
    );
  }
}

function readSecretRow(environmentId: string, name: string) {
  return db
    .select()
    .from(environmentSecrets)
    .where(
      and(
        eq(environmentSecrets.environmentId, environmentId),
        eq(environmentSecrets.name, name),
        isNull(environmentSecrets.sessionId),
      ),
    )
    .get();
}

function serializeEnvironmentSecret(row: SecretRecord): EnvironmentSecret {
  // Field by field, not a spread: the row carries the value.
  return { environmentId: row.environmentId, name: row.name, updatedAt: row.updatedAt };
}
