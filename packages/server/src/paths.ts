import "./env.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDataUrl = new URL("../../../data/", import.meta.url);

export const dataDir = resolve(process.env.CARMEL_AGENT_DATA_DIR ?? fileURLToPath(defaultDataUrl));

export function defaultAgentWorkingDir(agentId: string) {
  return `agents/${safePathSegment(agentId)}/workspace`;
}

export function agentTmpDir(agentId: string) {
  return `agents/${safePathSegment(agentId)}/tmp`;
}

// Backs $HOME inside the runner. Kept out of the workspace so tool state
// (npm/pip caches, global installs, shell history, browser profile) does not
// land in the user's project directory.
export function agentHomeDir(agentId: string) {
  return `agents/${safePathSegment(agentId)}/home`;
}

export function resolveDataPath(path: string) {
  return isAbsolute(path) ? resolve(path) : resolve(dataDir, path);
}

export function normalizeDataRelativePath(path: string) {
  return normalizeDataRelativePathStrict(path) ?? path;
}

/**
 * The data-relative form of `path`, or undefined when it points outside the
 * data directory. Callers that accept a path from a browser must use this, not
 * the permissive form: an absolute path would otherwise escape the sandbox.
 */
export function normalizeDataRelativePathStrict(path: string) {
  const absolutePath = resolveDataPath(path);
  const relativePath = relative(dataDir, absolutePath);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : undefined;
}

export function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

export function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function safePathSegment(value: string) {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (sanitized === value) return sanitized;
  // Distinct ids must not share one directory just because their sanitized
  // forms collide: `a/b`, `a b`, and `a_b` would otherwise all become `a_b`.
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${sanitized.slice(0, 64)}_${digest}`;
}
