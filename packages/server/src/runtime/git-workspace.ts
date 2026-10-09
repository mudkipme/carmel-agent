import { open } from "node:fs/promises";
import { posix } from "node:path";
import { FileError } from "../effectors/pi-durable/index.ts";
import type {
  GitChange,
  GitChangeArea,
  GitChangeKind,
  GitDiffSide,
  GitFileDiff,
  GitStatus,
} from "@carmel-agent/shared";
import type { agents } from "../db/schema.ts";
import type { AgentExecutionEnv } from "./execution-env.ts";
import { resolveAgentWorkingDirPath } from "./resources.ts";
import { execSandboxCommand } from "./sandbox/bash-operations.ts";
import { resolveContainerWorkspace } from "./sandbox/container-manager.ts";

type AgentRecord = typeof agents.$inferSelect;

/**
 * Read-only git for the Changes view.
 *
 * Git runs in the agent's sandbox, never on the host. The workspace -- and its
 * `.git/config` and `.gitattributes` -- is written by the agent, and plain
 * `git status` will run programs that config names: clean filters, fsmonitor.
 * Inside the sandbox that is the agent running its own code, which it can do
 * anyway; on the host it would be an escape.
 *
 * Nothing here writes to the repository: `--no-optional-locks` keeps status
 * from refreshing the index behind the agent's back, and blobs are read with
 * `cat-file`, which applies no textconv or smudge filter.
 */

/** Per side of a diff. Past this the viewer would be unusable anyway. */
export const MAX_DIFF_SIDE_BYTES = 1024 * 1024;
/** The status listing; an untracked `node_modules` is what reaches it. */
const MAX_STATUS_BYTES = 1024 * 1024;
const GIT_TIMEOUT_SECONDS = 30;
const GIT = "git --no-optional-locks -c core.quotePath=false";

export class GitRequestError extends Error {}

export async function readGitStatus(agent: AgentRecord): Promise<GitStatus> {
  const result = await runGit(
    agent,
    `top=$(${GIT} rev-parse --show-toplevel 2>/dev/null) || exit 3
printf '%s\\0' "$top"
${GIT} status --porcelain=v2 --branch -z --untracked-files=all | head -c ${MAX_STATUS_BYTES + 1}`,
    {},
    MAX_STATUS_BYTES + 4096,
  );
  if (result.exitCode === 3) return { repository: false };
  if (result.exitCode !== 0) throw new Error(gitFailure("git status", result.stderr));

  const separator = result.stdout.indexOf("\0");
  const toplevel = result.stdout.slice(0, separator);
  const listing = result.stdout.slice(separator + 1);
  const truncated = Buffer.byteLength(listing) > MAX_STATUS_BYTES;
  const parsed = parsePorcelainV2(listing, { truncated });
  const prefix = workspacePrefix(agent, toplevel);
  return {
    repository: true,
    ...parsed.branch,
    changes: parsed.changes.map((change) =>
      prefix === undefined ? change : { ...change, workspacePath: posix.join(prefix, change.path) },
    ),
    truncated,
  };
}

/**
 * Both sides of one file's change, as texts the client diffs itself.
 *
 * | area       | original            | modified          |
 * | ---------- | ------------------- | ----------------- |
 * | staged     | HEAD (or its rename) | index            |
 * | unstaged   | index               | working tree      |
 * | untracked  | --                  | working tree      |
 * | conflicted | index stage 2 (ours) | working tree     |
 */
export async function readGitFileDiff(
  agent: AgentRecord,
  env: AgentExecutionEnv,
  request: { path: string; originalPath?: string; area: GitChangeArea },
): Promise<GitFileDiff> {
  const path = normalizeRepoPath(request.path);
  const originalPath = request.originalPath ? normalizeRepoPath(request.originalPath) : undefined;
  const { area } = request;

  const originalSpec =
    area === "staged"
      ? `HEAD:${originalPath ?? path}`
      : area === "unstaged"
        ? `:0:${path}`
        : area === "conflicted"
          ? `:2:${path}`
          : undefined;
  const first = await readBlob(agent, originalSpec);
  if (!first.repository) throw new GitRequestError("This workspace is not a git repository.");

  const modified =
    area === "staged"
      ? await readIndexSide(agent, path)
      : await readWorktreeSide(env, workspacePrefix(agent, first.toplevel), path);
  return { path, originalPath, area, original: first.side, modified };
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * A file changed in both the index and the working tree is listed twice, once
 * per area, because each is its own diff. With `truncated`, the last record
 * may be cut mid-way and is dropped.
 */
export function parsePorcelainV2(listing: string, options: { truncated?: boolean } = {}) {
  const records = listing.split("\0");
  if (records.at(-1) === "" || options.truncated) records.pop();
  const branch: { branch?: string; head?: string; ahead?: number; behind?: number } = {};
  const changes: GitChange[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length);
      if (oid !== "(initial)") branch.head = oid;
    } else if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      if (head !== "(detached)") branch.branch = head;
    } else if (record.startsWith("# branch.ab ")) {
      const [ahead, behind] = record.slice("# branch.ab ".length).split(" ");
      branch.ahead = Math.abs(Number(ahead));
      branch.behind = Math.abs(Number(behind));
    } else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const fields = record.split(" ");
      const renamed = record.startsWith("2 ");
      const path = fields.slice(renamed ? 9 : 8).join(" ");
      // A rename's original path is the next NUL-separated record.
      const originalPath = renamed ? records[++index] : undefined;
      const [indexStatus, worktreeStatus] = fields[1]!;
      if (indexStatus !== ".") {
        changes.push({
          path,
          ...(originalPath ? { originalPath } : {}),
          area: "staged",
          kind: changeKind(indexStatus!),
        });
      }
      if (worktreeStatus !== ".")
        changes.push({ path, area: "unstaged", kind: changeKind(worktreeStatus!) });
    } else if (record.startsWith("u ")) {
      changes.push({
        path: record.split(" ").slice(10).join(" "),
        area: "conflicted",
        kind: "conflicted",
      });
    } else if (record.startsWith("? ")) {
      changes.push({ path: record.slice(2), area: "untracked", kind: "untracked" });
    }
  }
  return { branch, changes };
}

/**
 * A repository-relative path from the client. It only ever names a file inside
 * the repository, and it must not read as one of git's revision syntaxes --
 * `:/text` after a stage prefix is a commit-message search.
 */
export function normalizeRepoPath(path: string) {
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\0") ||
    posix.isAbsolute(path) ||
    path.includes("\\")
  ) {
    throw new GitRequestError("Invalid path.");
  }
  const normalized = posix.normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new GitRequestError("Invalid path.");
  }
  return normalized;
}

function changeKind(status: string): GitChangeKind {
  switch (status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    default:
      return "modified";
  }
}

/** The repository root relative to the workspace, or undefined when it is outside it. */
function workspacePrefix(agent: AgentRecord, toplevel: string) {
  const relative = posix.relative(resolveContainerWorkspace(agent), toplevel);
  return relative.startsWith("..") || posix.isAbsolute(relative) ? undefined : relative;
}

async function readBlob(
  agent: AgentRecord,
  spec: string | undefined,
): Promise<{ repository: false } | { repository: true; toplevel: string; side: GitDiffSide }> {
  // The spec rides in the environment rather than the script, so no path can
  // change what the shell runs.
  const result = await runGit(
    agent,
    `top=$(${GIT} rev-parse --show-toplevel 2>/dev/null) || exit 3
printf '%s\\0' "$top"
[ -n "$CARMEL_GIT_SPEC" ] || { printf 'absent'; exit 0; }
size=$(${GIT} cat-file -s "$CARMEL_GIT_SPEC" 2>/dev/null) || { printf 'absent'; exit 0; }
if [ "$size" -gt ${MAX_DIFF_SIDE_BYTES} ]; then printf 'too_large\\0%s' "$size"; exit 0; fi
printf 'text\\0'
${GIT} cat-file blob "$CARMEL_GIT_SPEC"`,
    { CARMEL_GIT_SPEC: spec ?? "" },
    MAX_DIFF_SIDE_BYTES + 8192,
  );
  if (result.exitCode === 3) return { repository: false };
  if (result.exitCode !== 0) throw new Error(gitFailure("git cat-file", result.stderr));

  const [toplevel = "", kind = "", ...rest] = result.stdout.split("\0");
  const body = rest.join("\0");
  const side: GitDiffSide =
    kind === "too_large"
      ? { kind: "too_large", bytes: Number(body) }
      : kind === "text"
        ? textSide(body)
        : { kind: "absent" };
  return { repository: true, toplevel, side };
}

async function readIndexSide(agent: AgentRecord, path: string): Promise<GitDiffSide> {
  const blob = await readBlob(agent, `:0:${path}`);
  if (!blob.repository) throw new GitRequestError("This workspace is not a git repository.");
  return blob.side;
}

async function readWorktreeSide(
  env: AgentExecutionEnv,
  prefix: string | undefined,
  path: string,
): Promise<GitDiffSide> {
  if (prefix === undefined)
    throw new GitRequestError("This repository's root is outside the agent's workspace.");
  // The same path authority the file editor uses: inside the workspace, with
  // the agent's read permission.
  const absolute = env.resolveBrowserPath(posix.join(prefix, path), "read");
  let handle;
  try {
    handle = await open(absolute, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "absent" };
    if (stats.size > MAX_DIFF_SIDE_BYTES) return { kind: "too_large", bytes: stats.size };
    const buffer = await handle.readFile();
    return buffer.subarray(0, 8000).includes(0)
      ? { kind: "binary" }
      : { kind: "text", text: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

function textSide(text: string): GitDiffSide {
  return text.slice(0, 8000).includes("\0") ? { kind: "binary" } : { kind: "text", text };
}

type GitExecutor = typeof execSandboxCommand;
let executeGit: GitExecutor = execSandboxCommand;

/**
 * Tests only: run the git scripts somewhere other than the sandbox, since a
 * test must not start containers on a runtime other things may share.
 */
export function setGitExecutorForTests(executor: GitExecutor | undefined) {
  executeGit = executor ?? execSandboxCommand;
}

async function runGit(
  agent: AgentRecord,
  script: string,
  env: Record<string, string>,
  maxBytes: number,
) {
  let stdout = "";
  let stdoutBytes = 0;
  let stderr = "";
  const { exitCode } = await executeGit(agent, script, resolveAgentWorkingDirPath(agent), {
    timeout: GIT_TIMEOUT_SECONDS,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    onStdout: (chunk) => {
      if (stdoutBytes >= maxBytes) return;
      stdoutBytes += Buffer.byteLength(chunk);
      stdout += chunk;
    },
    onStderr: (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    },
  });
  return { exitCode, stdout, stderr };
}

function gitFailure(command: string, stderr: string) {
  const detail = stderr.trim().split("\n").at(-1);
  return detail ? `${command} failed: ${detail}` : `${command} failed.`;
}

export function isGitRequestError(error: unknown): error is GitRequestError | FileError {
  return error instanceof GitRequestError || error instanceof FileError;
}
