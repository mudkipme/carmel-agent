import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

for (const file of [
  resolve(workspaceRoot, ".env"),
  resolve(workspaceRoot, ".env.local"),
  resolve(serverRoot, ".env"),
  resolve(serverRoot, ".env.local"),
]) {
  loadEnvFile(file);
}

/**
 * Prefer Anthropic's 1-hour prompt cache over the 5-minute default.
 *
 * Pi reads `PI_CACHE_RETENTION` and defaults to "short". Carmel's sessions are
 * long-lived and human-paced: reading a reply, a meeting, or lunch all exceed
 * five minutes, and each one would otherwise be a full cache miss on the entire
 * session prefix. A 1-hour write costs more per token than a 5-minute one, so
 * this is a trade -- dearer writes for far more hits -- and it is the right way
 * round for sessions people come back to. Set it explicitly to override.
 */
if (process.env.PI_CACHE_RETENTION === undefined) {
  process.env.PI_CACHE_RETENTION = "long";
}

function loadEnvFile(file: string) {
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry || process.env[entry.key] !== undefined) continue;
    process.env[entry.key] = entry.value;
  }
}

function parseEnvLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const separator = normalized.indexOf("=");
  if (separator <= 0) return undefined;

  const key = normalized.slice(0, separator).trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return undefined;

  return {
    key,
    value: parseEnvValue(normalized.slice(separator + 1).trim()),
  };
}

function parseEnvValue(value: string) {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\n/g, "\n");
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return stripInlineComment(value).trim();
}

function stripInlineComment(value: string) {
  const commentStart = value.search(/\s#/);
  return commentStart === -1 ? value : value.slice(0, commentStart);
}
