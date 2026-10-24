import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const maxDotEnvBytes = 1024 * 1024;

export function readWorkspaceDotEnv(workingDir: string): Record<string, string> {
  return readWorkspaceDotEnvFile(workingDir) ?? {};
}

export function workspaceDotEnvAvailable(workingDir: string): boolean {
  return readWorkspaceDotEnvFile(workingDir) !== undefined;
}

/** Read the file through a no-follow descriptor so a workspace symlink cannot expose host secrets. */
export function readWorkspaceDotEnvFile(workingDir: string): Record<string, string> | undefined {
  let fd: number;
  try {
    fd = openSync(
      join(workingDir, ".env"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxDotEnvBytes) return undefined;
    return parseEnv(readFileSync(fd, "utf8")) as Record<string, string>;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
