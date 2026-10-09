import { agentSecretNameError, reservedAgentSecretNames } from "@carmel-agent/shared";
import type { AgentSecret } from "@carmel-agent/shared";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, agentSecrets } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { protectSecret, revealSecret } from "../security.ts";

type SecretRecord = typeof agentSecrets.$inferSelect;

export class AgentSecretError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
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
    .where(eq(agentSecrets.agentId, agentId))
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
  db.insert(agentSecrets)
    .values({
      agentId,
      name,
      value: protectSecret(value)!,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [agentSecrets.agentId, agentSecrets.name],
      set: { value: protectSecret(value)!, updatedAt: timestamp },
    })
    .run();
  return serializeAgentSecret(readSecretRow(agentId, name)!);
}

export function deleteAgentSecret(userId: string, agentId: string, name: string) {
  assertAgentOwner(userId, agentId);
  if (!readSecretRow(agentId, name)) throw new AgentSecretError("Secret not found.", 404);
  db.delete(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)))
    .run();
}

/** Agent deletion: secrets reference the agent and must not outlive it. */
export function deleteAgentSecretsForAgent(agentId: string) {
  db.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId)).run();
}

/**
 * The decrypted secrets for a sandbox exec. Server-internal: the only caller is
 * the bash sandbox, and the values go straight into a container's exec
 * environment without passing through a serializer.
 *
 * Reserved names are filtered again here rather than trusted from write time,
 * so a row that predates a name becoming reserved -- or one written straight to
 * the database -- still cannot redefine `PATH` under a running agent.
 */
export function readAgentSecretEnv(agentId: string): Array<{ name: string; value: string }> {
  return db
    .select()
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentId))
    .all()
    .filter((row) => !reservedAgentSecretNames.has(row.name))
    .map((row) => ({ name: row.name, value: decryptSecret(row) }));
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
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)))
    .get();
}

function serializeAgentSecret(row: SecretRecord): AgentSecret {
  // Field by field, not a spread: the row carries the value.
  return { agentId: row.agentId, name: row.name, updatedAt: row.updatedAt };
}
