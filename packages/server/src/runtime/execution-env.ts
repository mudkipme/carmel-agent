import {
  ExecutionError,
  FileError,
  err,
  ok,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, open, rename as renameFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentMount } from "@carmel-agent/shared";
import type { agents } from "../db/schema.ts";
import { ensureDir } from "../paths.ts";
import { resolveAgentWorkingDirPath } from "./resources.ts";
import { execSandboxCommand } from "./sandbox/bash-operations.ts";
import { resolveAgentTmpDirPath, resolveContainerWorkspace } from "./sandbox/container-manager.ts";
import { isSandboxConfigured, sandboxUnavailableMessage } from "./sandbox/podman.ts";

type AgentRecord = typeof agents.$inferSelect;
type AccessMode = "address" | "read" | "write";
type PathMapping = { containerPath: string; hostPath: string };

/** Single filesystem and shell authority for an agent. */
export class AgentExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  readonly tmpDir: string;
  private readonly node: NodeExecutionEnv;
  private readonly readRoots: string[];
  private readonly writeRoots: string[];
  private readonly mappings: PathMapping[];

  constructor(readonly agent: AgentRecord) {
    this.cwd = resolve(resolveAgentWorkingDirPath(agent));
    this.tmpDir = resolve(resolveAgentTmpDirPath(agent));
    ensureDir(this.cwd);
    ensureDir(this.tmpDir);
    this.node = new NodeExecutionEnv({ cwd: this.cwd });
    const mountSources = agent.mounts.flatMap((mount) => {
      const source = mount.source?.trim();
      return source ? [resolve(source)] : [];
    });
    const writableMountSources = agent.mounts.flatMap((mount) => {
      const source = mount.source?.trim();
      return source && !mount.readOnly ? [resolve(source)] : [];
    });
    this.readRoots = uniquePaths([this.cwd, this.tmpDir, ...mountSources]);
    this.writeRoots = uniquePaths([this.cwd, this.tmpDir, ...writableMountSources]);
    this.mappings = createPathMappings(agent, this.cwd, this.tmpDir);
  }

  resolveAuthorizedPath(path: string, mode: AccessMode = "read", workspaceOnly = false) {
    if (mode === "read" && !this.agent.permissions.read && !this.agent.permissions.edit) {
      throw new FileError("permission_denied", "Read permission is disabled for this agent.", path);
    }
    if (mode === "write" && !this.agent.permissions.write && !this.agent.permissions.edit) {
      throw new FileError("permission_denied", "Write permission is disabled for this agent.", path);
    }
    const cleanPath = path.startsWith("@") ? path.slice(1) : path;
    const remapped = remapContainerPath(cleanPath, this.mappings);
    const absolutePath = isAbsolute(remapped) ? resolve(remapped) : resolve(this.cwd, remapped || ".");
    const roots = workspaceOnly ? [this.cwd] : mode === "write" ? this.writeRoots : this.readRoots;
    assertInsideAllowedRoots(absolutePath, roots, path);
    return absolutePath;
  }

  resolveBrowserPath(path: string, mode: AccessMode = "read") {
    if (isAbsolute(path)) throw new FileError("invalid", "Absolute paths are not allowed.", path);
    return this.resolveAuthorizedPath(path.replaceAll("\\", "/").replace(/^\/+/, ""), mode, true);
  }

  toWorkspaceRelativePath(path: string) {
    return relative(this.cwd, this.resolveAuthorizedPath(path, "address", true)).replaceAll("\\", "/");
  }

  async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileResult(path, abortSignal, () => this.resolveAuthorizedPath(path, "address"));
  }

  async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted."));
    const joined = await this.node.joinPath(parts);
    if (!joined.ok) return joined;
    return this.fileResult(joined.value, abortSignal, () => this.resolveAuthorizedPath(joined.value, "address"));
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.delegatePath(path, "read", abortSignal, (resolved) => this.node.readTextFile(resolved, abortSignal));
  }

  async readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }): Promise<Result<string[], FileError>> {
    return this.delegatePath(path, "read", options?.abortSignal, (resolved) => this.node.readTextLines(resolved, options));
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    return this.delegatePath(path, "read", abortSignal, (resolved) => this.node.readBinaryFile(resolved, abortSignal));
  }

  async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    return this.delegatePath(path, "write", abortSignal, async (resolved) => {
      if (!this.agent.permissions.write && !existsSync(resolved)) {
        return err(new FileError("permission_denied", "Edit permission cannot create files.", resolved));
      }
      return this.node.writeFile(resolved, content, abortSignal);
    });
  }

  async appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    return this.delegatePath(path, "write", abortSignal, async (resolved) => {
      if (!this.agent.permissions.write && !existsSync(resolved)) {
        return err(new FileError("permission_denied", "Edit permission cannot create files.", resolved));
      }
      return this.node.appendFile(resolved, content);
    });
  }

  async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    return this.delegatePath(path, this.metadataMode(), abortSignal, (resolved) => this.node.fileInfo(resolved));
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    if (!this.agent.permissions.read) return err(new FileError("permission_denied", "Read permission is disabled for this agent.", path));
    return this.delegatePath(path, "read", abortSignal, (resolved) => this.node.listDir(resolved, abortSignal));
  }

  async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.delegatePath(path, this.metadataMode(), abortSignal, (resolved) => this.node.canonicalPath(resolved));
  }

  async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    return this.delegatePath(path, this.metadataMode(), abortSignal, (resolved) => this.node.exists(resolved));
  }

  async createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>> {
    if (!this.agent.permissions.write) return err(new FileError("permission_denied", "Write permission is disabled for this agent.", path));
    return this.delegatePath(path, "write", options?.abortSignal, (resolved) => this.node.createDir(resolved, options));
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>> {
    if (!this.agent.permissions.write) return err(new FileError("permission_denied", "Write permission is disabled for this agent.", path));
    return this.delegatePath(path, "write", options?.abortSignal, (resolved) => this.node.remove(resolved, options));
  }

  async createTempDir(prefix = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileResult(this.tmpDir, abortSignal, () => mkdtemp(resolve(this.tmpDir, basename(prefix) || "tmp-")));
  }

  async createTempFile(options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }): Promise<Result<string, FileError>> {
    return this.fileResult(this.tmpDir, options?.abortSignal, async () => {
      const directory = await mkdtemp(resolve(this.tmpDir, basename(options?.prefix || "tmp-")));
      const path = resolve(directory, `file${options?.suffix ? basename(options.suffix) : ""}`);
      const handle = await open(path, "wx");
      await handle.close();
      return path;
    });
  }

  async rename(from: string, to: string, workspaceOnly = false): Promise<Result<void, FileError>> {
    return this.fileResult(from, undefined, async () => {
      const currentPath = workspaceOnly ? this.resolveBrowserPath(from, "write") : this.resolveAuthorizedPath(from, "write");
      const nextPath = workspaceOnly ? this.resolveBrowserPath(to, "write") : this.resolveAuthorizedPath(to, "write");
      await renameFile(currentPath, nextPath);
    });
  }

  async createFileExclusive(path: string, workspaceOnly = false): Promise<Result<void, FileError>> {
    if (!this.agent.permissions.write) return err(new FileError("permission_denied", "Write permission is disabled for this agent.", path));
    return this.fileResult(path, undefined, async () => {
      const resolved = workspaceOnly ? this.resolveBrowserPath(path, "write") : this.resolveAuthorizedPath(path, "write");
      const handle = await open(resolved, "wx");
      await handle.close();
    });
  }

  async exec(command: string, options?: ShellExecOptions): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (!this.agent.permissions.bash) return err(new ExecutionError("shell_unavailable", "Bash permission is disabled for this agent."));
    if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "Operation aborted."));
    let callbackFailed = false;
    try {
      const cwd = this.resolveAuthorizedPath(options?.cwd ?? this.cwd, "address");
      if (!isSandboxConfigured()) return err(new ExecutionError("shell_unavailable", sandboxUnavailableMessage()));
      const callOutput = (callback: ((chunk: string) => void) | undefined, chunk: string) => {
        try {
          callback?.(chunk);
        } catch (error) {
          callbackFailed = true;
          throw error;
        }
      };
      const execOptions = {
        onStdout: (chunk: string) => callOutput(options?.onStdout, chunk),
        onStderr: (chunk: string) => callOutput(options?.onStderr, chunk),
        signal: options?.abortSignal,
        timeout: options?.timeout,
        env: options?.env,
      };
      const result = await execSandboxCommand(this.agent, command, cwd, execOptions);
      return ok({ stdout: "", stderr: "", exitCode: result.exitCode ?? 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = options?.abortSignal?.aborted
        ? "aborted"
        : message.startsWith("timeout:")
          ? "timeout"
          : callbackFailed
            ? "callback_error"
            : "spawn_error";
      return err(new ExecutionError(code, message, error instanceof Error ? error : undefined));
    }
  }

  async cleanup() {
    await this.node.cleanup();
  }

  private metadataMode(): "read" | "write" {
    return this.agent.permissions.read || this.agent.permissions.edit ? "read" : "write";
  }

  private async delegatePath<T>(path: string, mode: AccessMode, abortSignal: AbortSignal | undefined, operation: (resolved: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted.", path));
    try {
      return await operation(this.resolveAuthorizedPath(path, mode));
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  private async fileResult<T>(path: string, abortSignal: AbortSignal | undefined, operation: () => T | Promise<T>): Promise<Result<T, FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted.", path));
    try {
      return ok(await operation());
    } catch (error) {
      return err(toFileError(error, path));
    }
  }
}

export function remapContainerPath(filePath: string, mappings: PathMapping[]) {
  if (!isAbsolute(filePath)) return filePath;
  const normalized = resolve(filePath);
  for (const { containerPath, hostPath } of mappings) {
    const root = resolve(containerPath);
    if (normalized === root) return resolve(hostPath);
    const child = relative(root, normalized);
    if (child && !child.startsWith("..") && !isAbsolute(child)) return resolve(hostPath, child);
  }
  return filePath;
}

function createPathMappings(agent: AgentRecord, cwd: string, tmpDir: string): PathMapping[] {
  const mappings: PathMapping[] = [
    { containerPath: resolveContainerWorkspace(agent), hostPath: cwd },
    { containerPath: "/tmp", hostPath: tmpDir },
  ];
  for (const mount of agent.mounts) {
    const source = mount.source?.trim();
    if (!source) continue;
    mappings.push({ containerPath: normalizeMountTarget(mount), hostPath: resolve(source) });
  }
  return mappings.sort((left, right) => right.containerPath.length - left.containerPath.length);
}

function normalizeMountTarget(mount: AgentMount) {
  return resolve(mount.target?.trim() || mount.source.trim());
}

function assertInsideAllowedRoots(absolutePath: string, roots: string[], displayPath: string) {
  const normalizedPath = resolve(absolutePath);
  const realPath = resolveRealPath(normalizedPath);
  for (const root of roots) {
    const normalizedRoot = resolve(root);
    if (isInsideRoot(normalizedRoot, normalizedPath) && isInsideRoot(resolveRealPath(normalizedRoot), realPath)) return;
  }
  throw new FileError("permission_denied", `Path is outside the agent working directory: ${displayPath}`, absolutePath);
}

function isInsideRoot(root: string, target: string) {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function resolveRealPath(absolutePath: string): string {
  let current = resolve(absolutePath);
  const trailing: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      trailing.unshift(basename(current));
      current = parent;
    }
  }
  const realBase = realpathSync(current);
  return trailing.length > 0 ? resolve(realBase, ...trailing) : realBase;
}

function toFileError(error: unknown, path: string) {
  if (error instanceof FileError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const nodeCode = typeof error === "object" && error && "code" in error ? error.code : undefined;
  const code = nodeCode === "ENOENT" ? "not_found" : nodeCode === "EACCES" || nodeCode === "EPERM" ? "permission_denied" : nodeCode === "ENOTDIR" ? "not_directory" : nodeCode === "EISDIR" ? "is_directory" : nodeCode === "EINVAL" ? "invalid" : "unknown";
  return new FileError(code, message, path, error instanceof Error ? error : undefined);
}

function isMissingPathError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((path) => resolve(path)))];
}
