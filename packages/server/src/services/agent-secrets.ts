import { agentSecretNameError, reservedAgentSecretNames } from "@carmel-agent/shared";
import type { AgentSecret, SessionSecret } from "@carmel-agent/shared";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, agentSecrets, sessions } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { encryptSubmittedSecret, protectSecret, revealSecret } from "../security.ts";

type SecretRecord = typeof agentSecrets.$inferSelect;

export class AgentSecretError extends Error {
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
 * knowing that an agent carries a `STRIPE_KEY` is itself a disclosure, and no
 * operational question needs it. Values never leave the server either way.
 */
function assertAgentOwner(userId: string, agentId: string) {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) throw new AgentSecretError("Agent not found.", 404);
  if (agent.ownerUserId !== userId)
    throw new AgentSecretError("Agent secrets are owner-only.", 403);
  return agent;
}

export function readAgentSecrets(userId: string, agentId: string): AgentSecret[] {
  assertAgentOwner(userId, agentId);
  return db
    .select()
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), isNull(agentSecrets.sessionId)))
    .orderBy(asc(agentSecrets.name))
    .all()
    .map(serializeAgentSecret);
}

export function writeAgentSecret(
  userId: string,
  agentId: string,
  name: string,
  value: string,
): AgentSecret {
  assertAgentOwner(userId, agentId);
  const nameError = agentSecretNameError(name);
  if (nameError) throw new AgentSecretError(nameError, 400);

  const timestamp = now();
  const current = readSecretRow(agentId, name);
  const fields = {
    agentId,
    name,
    // Never accept a client's enc:v1: prefix as proof of encryption.
    value: value.startsWith("enc:v1:") ? encryptSubmittedSecret(value) : protectSecret(value)!,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  if (current) db.update(agentSecrets).set(fields).where(eq(agentSecrets.id, current.id)).run();
  else db.insert(agentSecrets).values(fields).run();
  return serializeAgentSecret(readSecretRow(agentId, name)!);
}

export function deleteAgentSecret(userId: string, agentId: string, name: string) {
  assertAgentOwner(userId, agentId);
  if (!readSecretRow(agentId, name)) throw new AgentSecretError("Secret not found.", 404);
  db.delete(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, agentId),
        eq(agentSecrets.name, name),
        isNull(agentSecrets.sessionId),
      ),
    )
    .run();
}

/** Agent deletion: secrets reference the agent and must not outlive it. */
export function deleteAgentSecretsForAgent(agentId: string) {
  db.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId)).run();
}

/**
 * Decrypted credentials for authorized server-side execution and redaction.
 * Values are never returned by a serializer or a browser API.
 *
 * Reserved names are filtered again here rather than trusted from write time,
 * so a row that predates a name becoming reserved -- or one written straight to
 * the database -- still cannot redefine `PATH` under a running agent.
 */
export function readAgentSecretEnv(
  agentId: string,
  sessionId?: string,
): Array<{ name: string; value: string }> {
  if (sessionId) {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session || session.agentId !== agentId)
      throw new AgentSecretError("Session not found.", 404);
  }
  const records = db
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, agentId),
        sessionId
          ? or(isNull(agentSecrets.sessionId), eq(agentSecrets.sessionId, sessionId))
          : isNull(agentSecrets.sessionId),
      ),
    )
    .all()
    .filter((row) => !reservedAgentSecretNames.has(row.name));
  const effective = new Map<string, SecretRecord>();
  for (const row of records.filter((row) => !row.sessionId)) effective.set(row.name, row);
  for (const row of records.filter((row) => row.sessionId)) effective.set(row.name, row);
  return [...effective.values()].map((row) => ({ name: row.name, value: decryptSecret(row) }));
}

export function assertSessionOwner(userId: string, sessionId: string) {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.userId !== userId) throw new AgentSecretError("Session not found.", 404);
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

export function readSessionSecrets(userId: string, sessionId: string): SessionSecret[] {
  const session = assertSessionOwner(userId, sessionId);
  const agent = db.select().from(agents).where(eq(agents.id, session.agentId)).get()!;
  const records = db
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, session.agentId),
        agent.ownerUserId === userId
          ? or(isNull(agentSecrets.sessionId), eq(agentSecrets.sessionId, sessionId))
          : eq(agentSecrets.sessionId, sessionId),
      ),
    )
    .all();
  const effective = new Map<string, SecretRecord>();
  for (const row of records.filter((row) => !row.sessionId)) effective.set(row.name, row);
  for (const row of records.filter((row) => row.sessionId)) effective.set(row.name, row);
  return [...effective.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(serializeCredential);
}

export function findAvailableSecret(sessionId: string, name: string) {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new AgentSecretError("Session not found.", 404);
  const records = db
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, session.agentId),
        eq(agentSecrets.name, name),
        or(isNull(agentSecrets.sessionId), eq(agentSecrets.sessionId, sessionId)),
      ),
    )
    .all();
  const row = records.find((row) => row.sessionId === sessionId) ?? records[0];
  if (!row) return undefined;
  decryptSecret(row); // Availability also means it can actually be decrypted.
  return serializeCredential(row);
}

export function storeSessionSecret(userId: string, sessionId: string, name: string, value: string) {
  const session = assertSessionOwner(userId, sessionId);
  const nameError = agentSecretNameError(name);
  if (nameError) throw new AgentSecretError(nameError, 400);
  if (!value || value.length > 65536 || value.includes("\0"))
    throw new AgentSecretError("Invalid secret value.", 400);
  const existing = db
    .select()
    .from(agentSecrets)
    .where(and(eq(agentSecrets.sessionId, sessionId), eq(agentSecrets.name, name)))
    .get();
  if (existing)
    throw new AgentSecretError(
      "This session credential already exists. Revoke it before replacing it.",
      409,
    );
  let encrypted: string;
  try {
    encrypted = encryptSubmittedSecret(value);
  } catch {
    throw new AgentSecretError(
      "Configure CARMEL_SECRET_KEY before storing session credentials.",
      503,
    );
  }
  const row = {
    id: crypto.randomUUID(),
    agentId: session.agentId,
    sessionId,
    name,
    value: encrypted,
    createdAt: now(),
    updatedAt: now(),
  };
  db.insert(agentSecrets).values(row).run();
  return serializeCredential(row);
}

export function promoteSessionSecret(
  userId: string,
  sessionId: string,
  secretId: string,
): SessionSecret {
  const session = assertSessionOwner(userId, sessionId);
  assertAgentOwner(userId, session.agentId);
  return db.transaction(() => {
    const row = db
      .select()
      .from(agentSecrets)
      .where(and(eq(agentSecrets.id, secretId), eq(agentSecrets.agentId, session.agentId)))
      .get();
    if (!row || (row.sessionId && row.sessionId !== sessionId))
      throw new AgentSecretError("Secret not found.", 404);
    if (!row.sessionId) return serializeCredential(row);
    if (readSecretRow(session.agentId, row.name))
      throw new AgentSecretError(
        "An agent credential with this name already exists. It was not overwritten.",
        409,
      );
    db.update(agentSecrets)
      .set({ sessionId: null, updatedAt: now() })
      .where(eq(agentSecrets.id, row.id))
      .run();
    return serializeCredential({ ...row, sessionId: null, updatedAt: now() });
  });
}

export function demoteAgentSecret(userId: string, sessionId: string, secretId: string) {
  const session = assertSessionOwner(userId, sessionId);
  assertAgentOwner(userId, session.agentId);
  const row = db
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.id, secretId),
        eq(agentSecrets.agentId, session.agentId),
        isNull(agentSecrets.sessionId),
      ),
    )
    .get();
  if (!row) throw new AgentSecretError("Secret not found.", 404);
  const collision = db
    .select()
    .from(agentSecrets)
    .where(and(eq(agentSecrets.sessionId, sessionId), eq(agentSecrets.name, row.name)))
    .get();
  if (collision)
    throw new AgentSecretError("This session already has a credential with this name.", 409);
  db.update(agentSecrets)
    .set({ sessionId, updatedAt: now() })
    .where(eq(agentSecrets.id, row.id))
    .run();
  return serializeCredential({ ...row, sessionId, updatedAt: now() });
}

export function revokeSessionSecret(userId: string, sessionId: string, secretId: string) {
  const session = assertSessionOwner(userId, sessionId);
  const row = db
    .select()
    .from(agentSecrets)
    .where(and(eq(agentSecrets.id, secretId), eq(agentSecrets.agentId, session.agentId)))
    .get();
  if (!row || (row.sessionId && row.sessionId !== sessionId))
    throw new AgentSecretError("Secret not found.", 404);
  if (!row.sessionId) assertAgentOwner(userId, session.agentId);
  db.delete(agentSecrets).where(eq(agentSecrets.id, secretId)).run();
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
      `Cannot decrypt the agent secret "${row.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readSecretRow(agentId: string, name: string) {
  return db
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, agentId),
        eq(agentSecrets.name, name),
        isNull(agentSecrets.sessionId),
      ),
    )
    .get();
}

function serializeAgentSecret(row: SecretRecord): AgentSecret {
  // Field by field, not a spread: the row carries the value.
  return { agentId: row.agentId, name: row.name, updatedAt: row.updatedAt };
}
