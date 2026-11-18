import type { Environment, EnvironmentCommand, UserRole } from "@carmel-agent/shared";
import { statSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, environmentSecrets, environments } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { environmentStorageDir } from "../paths.ts";
import { deleteBrowserControl } from "../runtime/browser-control.ts";
import { closeEnvironmentBrowsers } from "../runtime/sandbox/browser-sessions.ts";
import {
  discardEnvironmentContainer,
  mountedFolder,
  type EnvironmentRecord,
} from "../runtime/sandbox/container-manager.ts";
import { closeEnvironmentTerminals } from "../runtime/sandbox/terminal-sessions.ts";

export type { EnvironmentRecord };

export class EnvironmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

export function readEnvironment(environmentId: string) {
  return db.select().from(environments).where(eq(environments.id, environmentId)).get();
}

/** Every agent row points at an environment; a missing one is a broken database. */
export function readAgentEnvironment(agent: { id: string; environmentId: string }) {
  const environment = readEnvironment(agent.environmentId);
  if (!environment) throw new Error(`Environment for agent ${agent.id} not found.`);
  return environment;
}

/**
 * Environments are owner-only. Attaching an agent to one hands that agent its
 * credentials, so sharing them across users would be sharing the secrets.
 */
export function readOwnedEnvironment(userId: string, environmentId: string) {
  const environment = readEnvironment(environmentId);
  return environment?.ownerUserId === userId ? environment : undefined;
}

export function readOwnedEnvironments(userId: string) {
  return db
    .select()
    .from(environments)
    .where(eq(environments.ownerUserId, userId))
    .orderBy(asc(environments.createdAt))
    .all();
}

export function environmentAgents(environmentId: string) {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      permissions: agents.permissions,
      workingDir: agents.workingDir,
    })
    .from(agents)
    .where(eq(agents.environmentId, environmentId))
    .orderBy(asc(agents.createdAt))
    .all();
}

export function serializeEnvironment(environment: EnvironmentRecord): Environment {
  return {
    id: environment.id,
    ownerUserId: environment.ownerUserId,
    name: environment.name,
    mounts: environment.mounts,
    network: environment.network,
    agents: environmentAgents(environment.id).map(({ id, name }) => ({ id, name })),
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

export function assertEnvironmentHostPathAccess(
  role: UserRole,
  command: Pick<EnvironmentCommand, "mounts">,
) {
  if (role !== "admin" && command.mounts.length > 0)
    throw new EnvironmentError("Host mounts are admin-only.", 403);
}

/**
 * The runner path an agent may work in: empty for its default folder, or an
 * existing folder inside one of the environment's mounts. An admin already
 * chose what the mounts expose, so picking a folder in one needs no more.
 */
export function resolveAgentWorkingDir(
  environment: Pick<EnvironmentRecord, "mounts"> | undefined,
  workingDir: string,
) {
  if (!workingDir) return "";
  const folder = environment && mountedFolder(environment.mounts, workingDir);
  if (!folder)
    throw new EnvironmentError(
      "The working folder must be inside one of the environment's mounts.",
      400,
    );
  if (!statSync(folder.hostPath, { throwIfNoEntry: false })?.isDirectory())
    throw new EnvironmentError(`Folder not found: ${folder.containerPath}`, 400);
  return folder.containerPath;
}

/** Create or replace an environment's configuration. Callers check ownership and active runs. */
export function writeEnvironment(
  user: { id: string; role: UserRole },
  command: EnvironmentCommand,
  current?: EnvironmentRecord,
): EnvironmentRecord {
  assertEnvironmentHostPathAccess(user.role, command);
  if (current) {
    const stranded = environmentAgents(current.id).find(
      (agent) => agent.workingDir && !mountedFolder(command.mounts, agent.workingDir),
    );
    if (stranded)
      throw new EnvironmentError(
        `${stranded.name} works in ${stranded.workingDir}, which would no longer be mounted.`,
        409,
      );
  }
  const environmentId = current?.id ?? id("env");
  const timestamp = now();
  const fields = {
    name: command.name,
    mounts: command.mounts,
    network: command.network,
    updatedAt: timestamp,
  };
  if (current) db.update(environments).set(fields).where(eq(environments.id, current.id)).run();
  else
    db.insert(environments)
      .values({
        ...fields,
        id: environmentId,
        ownerUserId: user.id,
        storageDir: environmentStorageDir(environmentId),
        createdAt: timestamp,
      })
      .run();
  return readEnvironment(environmentId)!;
}

/**
 * Live shells and browser viewers have the old binds, network, and secrets
 * baked in. Close them so the next attach starts from the saved environment.
 */
export function closeEnvironmentSessions(environmentId: string, reason: string) {
  closeEnvironmentTerminals(environmentId, reason);
  closeEnvironmentBrowsers(environmentId);
}

/** The shared browser needs a bash-enabled agent; drop its control once none is left. */
export function releaseUnusedBrowserControl(environmentId: string) {
  if (!environmentAgents(environmentId).some((agent) => agent.permissions.bash))
    deleteBrowserControl(environmentId);
}

/** Workspace and home stay on disk, as they always have for deleted agents. */
export async function deleteEnvironment(environment: EnvironmentRecord) {
  if (environmentAgents(environment.id).length > 0)
    throw new EnvironmentError("Environment is used by agents.", 409);
  closeEnvironmentSessions(environment.id, "The environment was deleted.");
  deleteBrowserControl(environment.id);
  db.transaction((tx) => {
    tx.delete(environmentSecrets).where(eq(environmentSecrets.environmentId, environment.id)).run();
    tx.delete(environments).where(eq(environments.id, environment.id)).run();
  });
  await discardEnvironmentContainer(environment);
}
