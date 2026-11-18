import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { AgentMount } from "@carmel-agent/shared";
import { agentFolderName } from "../paths.ts";

type LegacyWorkspace = {
  environment_id: string;
  storage_dir: string;
  working_dir_mode: "default" | "manual";
  working_dir: string;
  files_agent_id: string | null;
};

/**
 * Finishes migration 0014. Environments used to have one working directory;
 * agents now have their own. A manual directory becomes a mount the agents
 * work in, and a default workspace moves into its first agent's folder.
 */
export function finishLegacyWorkspaces(
  sqlite: BetterSqlite3.Database,
  dataPath: (path: string) => string,
) {
  const table = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("legacy_environment_workspaces");
  if (!table) return;
  const rows = sqlite
    .prepare("SELECT * FROM legacy_environment_workspaces")
    .all() as LegacyWorkspace[];
  for (const row of rows) {
    try {
      if (row.working_dir_mode === "manual") adoptManualWorkspace(sqlite, row, dataPath);
      else if (row.files_agent_id) moveDefaultWorkspace(sqlite, row, row.files_agent_id, dataPath);
    } catch (error) {
      console.warn(`Unable to migrate the workspace of environment ${row.environment_id}:`, error);
    }
  }
  sqlite.exec("DROP TABLE legacy_environment_workspaces");
}

function adoptManualWorkspace(
  sqlite: BetterSqlite3.Database,
  row: LegacyWorkspace,
  dataPath: (path: string) => string,
) {
  const path = dataPath(row.working_dir);
  const { mounts } = sqlite
    .prepare("SELECT mounts FROM environments WHERE id = ?")
    .get(row.environment_id) as { mounts: string };
  const current = JSON.parse(mounts) as AgentMount[];
  const mounted = current.some((mount) => resolve(mount.target?.trim() || mount.source) === path);
  sqlite.transaction(() => {
    if (!mounted)
      sqlite
        .prepare("UPDATE environments SET mounts = ? WHERE id = ?")
        .run(JSON.stringify([...current, { source: path, target: path }]), row.environment_id);
    sqlite
      .prepare("UPDATE agents SET working_dir = ? WHERE environment_id = ?")
      .run(path, row.environment_id);
  })();
}

function moveDefaultWorkspace(
  sqlite: BetterSqlite3.Database,
  row: LegacyWorkspace,
  owner: string,
  dataPath: (path: string) => string,
) {
  const source = dataPath(row.working_dir);
  const folder = agentFolderName(owner);
  const target = dataPath(`${row.storage_dir}/workspace/${folder}`);
  if (existsSync(source) && !existsSync(target)) {
    if (inside(source, target)) {
      const staging = `${source}.moving-${randomUUID()}`;
      renameSync(source, staging);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(staging, target);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
    }
  }
  // Knowledge sources may name the old workspace in either namespace, or
  // relative to it. Only the files' new owner still resolves a relative path
  // from the same place.
  const ownerFolder = posix.join("/workspace", folder);
  const sources = sqlite
    .prepare(
      `SELECT ks.id, ks.agent_id, ks.path FROM knowledge_sources ks
       JOIN agents a ON a.id = ks.agent_id WHERE a.environment_id = ?`,
    )
    .all(row.environment_id) as Array<{ id: string; agent_id: string; path: string }>;
  const update = sqlite.prepare("UPDATE knowledge_sources SET path = ? WHERE id = ?");
  sqlite.transaction(() => {
    for (const knowledge of sources) {
      const path = relocate(knowledge.path, knowledge.agent_id === owner, {
        source,
        target,
        ownerFolder,
      });
      if (path !== knowledge.path) update.run(path, knowledge.id);
    }
  })();
}

function relocate(
  path: string,
  owner: boolean,
  roots: { source: string; target: string; ownerFolder: string },
) {
  if (!isAbsolute(path)) return owner ? path : posix.join(roots.ownerFolder, path);
  if (inside("/workspace", path))
    return posix.join(roots.ownerFolder, posix.relative("/workspace", path));
  if (inside(roots.source, path)) return resolve(roots.target, relative(roots.source, path));
  return path;
}

function inside(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}
