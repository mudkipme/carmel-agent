import "./env.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDataUrl = new URL("../../../data/", import.meta.url);

function resolveDataDir() {
  const configured = process.env.CARMEL_AGENT_DATA_DIR;
  if (configured) return resolve(configured);
  if (process.env.DATABASE_URL === ":memory:") {
    const ephemeral = mkdtempSync(join(tmpdir(), "carmel-data-"));
    process.once("exit", () => {
      try {
        rmSync(ephemeral, { recursive: true, force: true });
      } catch {
        /* Best effort cleanup of ephemeral test data. */
      }
    });
    return ephemeral;
  }
  return resolve(fileURLToPath(defaultDataUrl));
}

export const dataDir = resolveDataDir();

/** Data-relative root of a new environment's workspace, runner home, and scratch. */
export function environmentStorageDir(environmentId: string) {
  return `environments/${safePathSegment(environmentId)}`;
}

/** An agent's default folder name under its environment's `/workspace`. */
export function agentFolderName(agentId: string) {
  return safePathSegment(agentId);
}

export function resolveDataPath(path: string) {
  return isAbsolute(path) ? resolve(path) : resolve(dataDir, path);
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
