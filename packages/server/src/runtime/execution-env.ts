import {
  ExecutionError,
  FileError,
  err,
  ok,
  type Context,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "../effectors/pi-durable/index.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { appendFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, open, rename as renameFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMount } from "@carmel-agent/shared";
import type { agents } from "../db/schema.ts";
import { ensureDir } from "../paths.ts";
import { resolveAgentWorkingDirPath } from "./resources.ts";
import { execSandboxCommand } from "./sandbox/bash-operations.ts";
import {
  containerHome,
  resolveAgentHomeDirPath,
  resolveAgentTmpDirPath,
  resolveContainerWorkspace,
} from "./sandbox/container-manager.ts";
import { isSandboxConfigured, sandboxUnavailableMessage } from "./sandbox/runtime-client.ts";
import { errorMessage } from "../errors.ts";

type AgentRecord = typeof agents.$inferSelect;
type AccessMode = "address" | "read" | "write";
type PathMapping = { containerPath: string; hostPath: string };

/** Single filesystem and shell authority for an agent. */
export class AgentExecutionEnv implements ExecutionEnv {
  readonly id: string;
  /** Runner path used by the model and all agent tools. */
  readonly cwd: string;
  /** App-side storage path; only server filesystem consumers should use this. */
  readonly hostCwd: string;
  readonly tmpDir: string;
  readonly homeDir: string;
  private readonly node: NodeExecutionEnv;
  private readonly readRoots: string[];
  private readonly writeRoots: string[];
  private readonly mappings: PathMapping[];
  private readonly reverseMappings: PathMapping[];
  private readonly hostPathPattern: RegExp;

  constructor(readonly agent: AgentRecord) {
    this.id = `carmel:${agent.id}`;
    this.hostCwd = resolve(resolveAgentWorkingDirPath(agent));
    this.cwd = resolveContainerWorkspace(agent);
    this.tmpDir = resolve(resolveAgentTmpDirPath(agent));
    this.homeDir = resolve(resolveAgentHomeDirPath(agent));
    ensureDir(this.hostCwd);
    ensureDir(this.tmpDir);
    ensureDir(this.homeDir);
    this.node = new NodeExecutionEnv({ cwd: this.hostCwd });
    const mountSources = agent.mounts.flatMap((mount) => {
      const source = mount.source?.trim();
      return source ? [resolve(source)] : [];
    });
    const writableMountSources = agent.mounts.flatMap((mount) => {
      const source = mount.source?.trim();
      return source && !mount.readOnly ? [resolve(source)] : [];
    });
    this.readRoots = uniquePaths([this.hostCwd, this.tmpDir, this.homeDir, ...mountSources]);
    this.writeRoots = uniquePaths([this.hostCwd, this.tmpDir, this.homeDir, ...writableMountSources]);
    this.mappings = createPathMappings(agent, this.hostCwd, this.tmpDir, this.homeDir);
    this.reverseMappings = this.mappings.flatMap(({ hostPath, containerPath }) => {
      const canonical = resolveRealPath(hostPath);
      return uniquePaths([hostPath, canonical]).map(path => ({ containerPath: path, hostPath: containerPath }));
    }).sort((left, right) => right.containerPath.length - left.containerPath.length);
    const roots = this.reverseMappings.map(({ containerPath }) => containerPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.hostPathPattern = new RegExp(`(?:${roots.join("|")})(?=/|[\\s'"\\x60,:)]|$)`, "g");
  }

  /** Paths exposed to the agent always use the runner's namespace. */
  toContainerPath(path: string) {
    return remapContainerPath(path, this.reverseMappings);
  }

  /** Translate diagnostics, never arbitrary file contents or shell commands. */
  toAgentError(error: FileError): FileError;
  toAgentError(error: unknown): Error;
  toAgentError(error: unknown): Error {
    const message = errorMessage(error).replace(this.hostPathPattern, root => this.reverseMappings.find(mapping => mapping.containerPath === root)!.hostPath);
    return error instanceof FileError
      ? new FileError(error.code, message, error.path ? this.toContainerPath(error.path) : undefined, error)
      : new Error(message, error instanceof Error ? { cause: error } : undefined);
  }

  private mapFileResult<T>(result: Result<T, FileError>): Result<T, FileError>;
  private mapFileResult<T, U>(result: Result<T, FileError>, map: (value: T) => U): Result<U, FileError>;
  private mapFileResult<T, U>(result: Result<T, FileError>, map?: (value: T) => U): Result<T | U, FileError> {
    return result.ok ? ok(map ? map(result.value) : result.value) : err(this.toAgentError(result.error));
  }

  /** Authorize an agent path and return its app-side location for server I/O. */
  resolveAuthorizedPath(path: string, mode: AccessMode = "read", workspaceOnly = false) {
    if (mode === "read" && !this.agent.permissions.read && !this.agent.permissions.edit) {
      throw new FileError("permission_denied", "Read permission is disabled for this agent.", path);
    }
    if (mode === "write" && !this.agent.permissions.write && !this.agent.permissions.edit) {
      throw new FileError("permission_denied", "Write permission is disabled for this agent.", path);
    }
    const cleanPath = path.startsWith("@") ? path.slice(1) : path;
    // Prefer the most specific root in either namespace: internal storage under
    // /tmp must not be translated twice, and nested runner mounts must still win.
    const normalized = isAbsolute(cleanPath) ? resolve(cleanPath) : undefined;
    const hostRoot = normalized && this.reverseMappings.find(mapping => isInsideRoot(mapping.containerPath, normalized));
    const containerRoot = normalized && this.mappings.find(mapping => isInsideRoot(mapping.containerPath, normalized));
    const isHostPath = hostRoot && (!containerRoot || hostRoot.containerPath.length > containerRoot.containerPath.length);
    const remapped = isHostPath ? normalized! : remapContainerPath(cleanPath, this.mappings);
    const absolutePath = isAbsolute(remapped) ? resolve(remapped) : resolve(this.hostCwd, remapped || ".");
    const roots = workspaceOnly ? [this.hostCwd] : mode === "write" ? this.writeRoots : this.readRoots;
    try { assertInsideAllowedRoots(absolutePath, roots, path); }
    catch (error) { throw this.toAgentError(error); }
    return absolutePath;
  }

  resolveBrowserPath(path: string, mode: AccessMode = "read") {
    if (isAbsolute(path)) throw new FileError("invalid", "Absolute paths are not allowed.", path);
    return this.resolveAuthorizedPath(path.replaceAll("\\", "/").replace(/^\/+/, ""), mode, true);
  }

  toWorkspaceRelativePath(path: string) {
    return relative(this.hostCwd, this.resolveAuthorizedPath(path, "address", true)).replaceAll("\\", "/");
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileResult(path, context, () => this.toContainerPath(this.resolveAuthorizedPath(path, "address")));
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted."));
    const joined = await this.node.joinPath(parts, context);
    if (!joined.ok) return joined;
    return this.absolutePath(joined.value, context);
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.delegatePath(path, "read", context, (resolved) => this.node.readTextFile(resolved, context));
  }

  async openTextLineReader(path: string, context: Context) {
    const result = await this.delegatePath(path, "read", context, (resolved) => this.node.openTextLineReader(resolved, context));
    return this.mapFileResult(result, reader => ({
      readLine: async (ctx: Context) => this.mapFileResult(await reader.readLine(ctx)),
      close: (ctx: Context) => reader.close(ctx),
    }));
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.delegatePath(path, "read", context, (resolved) => this.node.readTextLines(resolved, options, context));
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.delegatePath(path, "read", context, (resolved) => this.node.readBinaryFile(resolved, context));
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
    const result = await this.delegatePath(path, "read", context, resolved => this.node.openBinaryReader(resolved, options, context));
    return this.mapFileResult(result, reader => ({
      info: async (ctx: Context) => this.mapFileResult(await reader.info(ctx), info => ({ ...info, path: this.toContainerPath(info.path) })),
      read: async (offset: number, length: number, ctx: Context) => this.mapFileResult(await reader.read(offset, length, ctx)),
      scanLines: async (opts: { startLine: number; endLine?: number }, ctx: Context) => this.mapFileResult(await reader.scanLines(opts, ctx)),
      close: (ctx: Context) => reader.close(ctx),
    }));
  }
  async openDirReader(path: string, context: Context) {
    const result = await this.delegatePath(path, "read", context, resolved => this.node.openDirReader(resolved, context));
    return this.mapFileResult(result, reader => ({
      next: async (max: number, ctx: Context) => this.mapFileResult(await reader.next(max, ctx), page => ({
        ...page, entries: page.entries.map(info => ({ ...info, path: this.toContainerPath(info.path) })),
      })),
      close: (ctx: Context) => reader.close(ctx),
    }));
  }
  async watch(targets: readonly import("@earendil-works/pi-durable/env").WatchTarget[], onChange: (change: import("@earendil-works/pi-durable/env").WatchChange) => void, context: Context): Promise<Result<import("@earendil-works/pi-durable/env").FileWatcher, FileError>> {
    try {
      return this.mapFileResult(await this.node.watch(targets.map(target => ({ ...target, path: this.resolveAuthorizedPath(target.path, "read") })), change => onChange(
        "paths" in change ? { paths: change.paths.map(path => this.toContainerPath(path)) }
          : "error" in change ? { error: this.toAgentError(change.error) } : change,
      ), context));
    } catch (error) { return err(this.toAgentError(toFileError(error, this.cwd))); }
  }
  async truncateFile(path: string, size: number, context: Context) {
    return this.delegatePath(path, "write", context, resolved => this.node.truncateFile(resolved, size, context));
  }
  async flushFile(path: string, context: Context) {
    return this.delegatePath(path, "write", context, resolved => this.node.flushFile(resolved, context));
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.delegatePath(path, "write", context, async (resolved) => {
      if (!this.agent.permissions.write && !existsSync(resolved)) {
        return err(new FileError("permission_denied", "Edit permission cannot create files.", resolved));
      }
      return this.node.writeFile(resolved, content, context);
    });
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.delegatePath(path, "write", context, async (resolved) => {
      if (!this.agent.permissions.write && !existsSync(resolved)) {
        return err(new FileError("permission_denied", "Edit permission cannot create files.", resolved));
      }
      return this.node.appendFile(resolved, content, context);
    });
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileResult(sourcePath, context, async () => {
      const from = this.resolveAuthorizedPath(sourcePath, "write");
      const to = this.resolveAuthorizedPath(destinationPath, "write");
      await renameFile(from, to);
    });
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const result = await this.delegatePath(path, this.metadataMode(), context, (resolved) => this.node.fileInfo(resolved, context));
    return this.mapFileResult(result, info => ({ ...info, path: this.toContainerPath(info.path) }));
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    if (!this.agent.permissions.read) return err(new FileError("permission_denied", "Read permission is disabled for this agent.", path));
    const result = await this.delegatePath(path, "read", context, (resolved) => this.node.listDir(resolved, context));
    return this.mapFileResult(result, entries => entries.map(info => ({ ...info, path: this.toContainerPath(info.path) })));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.delegatePath(path, this.metadataMode(), context, (resolved) => this.node.canonicalPath(resolved, context));
    return this.mapFileResult(result, canonical => this.toContainerPath(canonical));
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.delegatePath(path, this.metadataMode(), context, (resolved) => this.node.exists(resolved, context));
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    if (!this.agent.permissions.write) return err(new FileError("permission_denied", "Write permission is disabled for this agent.", path));
    return this.delegatePath(path, "write", context, (resolved) => this.node.createDir(resolved, options, context));
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    if (!this.agent.permissions.write) return err(new FileError("permission_denied", "Write permission is disabled for this agent.", path));
    return this.delegatePath(path, "write", context, (resolved) => this.node.remove(resolved, options, context));
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.fileResult(this.tmpDir, context, async () => this.toContainerPath(await mkdtemp(resolve(this.tmpDir, basename(prefix ?? "tmp-") || "tmp-"))));
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.fileResult(this.tmpDir, context, async () => {
      const directory = await mkdtemp(resolve(this.tmpDir, basename(options?.prefix || "tmp-")));
      const path = resolve(directory, `file${options?.suffix ? basename(options.suffix) : ""}`);
      const handle = await open(path, "wx");
      await handle.close();
      return this.toContainerPath(path);
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

  /** Commands and streamed output stay in the agent's sandbox authority. */
  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (!this.agent.permissions.bash) return err(new ExecutionError("shell_unavailable", "Bash permission is disabled for this agent."));
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Operation aborted."));
    let callbackFailed = false;
    let buffered = "", bytes = 0, lines = 0, spillPath: string | undefined;
    try {
      const cwd = this.resolveAuthorizedPath(options?.cwd ?? this.cwd, "address");
      if (!isSandboxConfigured()) return err(new ExecutionError("shell_unavailable", sandboxUnavailableMessage()));
      const emit = (chunk: string, stream: "stdout" | "stderr") => {
        if (!chunk) return;
        if (options?.spill) {
          bytes += Buffer.byteLength(chunk); lines += chunk.split("\n").length - 1;
          if (spillPath) appendFileSync(spillPath, chunk);
          else {
            buffered += chunk;
            if (bytes > options.spill.afterBytes || lines > options.spill.afterLines) {
              spillPath = resolve(this.tmpDir, `output-${crypto.randomUUID()}.txt`);
              writeFileSync(spillPath, buffered, { mode: 0o600, flag: "wx" }); buffered = "";
            }
          }
        }
        try { options?.onOutput?.(chunk, context, { stream }); }
        catch (error) { callbackFailed = true; throw error; }
      };
      const shellCommand = typeof command === "string" ? command : command.map(arg => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(" ");
      const result = await execSandboxCommand(this.agent, shellCommand, cwd, {
        onStdout: chunk => emit(chunk, "stdout"), onStderr: chunk => emit(chunk, "stderr"),
        signal: context.abortSignal, timeout: options?.timeout, env: options?.env,
      });
      return ok({ exitCode: result.exitCode ?? 1, ...(spillPath ? { spillPath: this.toContainerPath(spillPath) } : {}) });
    } catch (error) {
      const message = this.toAgentError(error).message;
      const code = context.abortSignal?.aborted ? "aborted" : message.startsWith("timeout:") ? "timeout" : callbackFailed ? "callback_error" : "spawn_error";
      const failure = new ExecutionError(code, message, error instanceof Error ? error : undefined);
      failure.spillPath = spillPath ? this.toContainerPath(spillPath) : undefined;
      return err(failure);
    }
  }

  async cleanup(context: Context) {
    await this.node.cleanup(context);
  }

  private metadataMode(): "read" | "write" {
    return this.agent.permissions.read || this.agent.permissions.edit ? "read" : "write";
  }

  private async delegatePath<T>(path: string, mode: AccessMode, context: Context | undefined, operation: (resolved: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
    if (context?.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted.", path));
    try {
      return this.mapFileResult(await operation(this.resolveAuthorizedPath(path, mode)));
    } catch (error) {
      return err(this.toAgentError(toFileError(error, path)));
    }
  }

  private async fileResult<T>(path: string, context: Context | undefined, operation: () => T | Promise<T>): Promise<Result<T, FileError>> {
    if (context?.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted.", path));
    try {
      return ok(await operation());
    } catch (error) {
      return err(this.toAgentError(toFileError(error, path)));
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
    if (child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return resolve(hostPath, child);
  }
  return filePath;
}

function createPathMappings(agent: AgentRecord, cwd: string, tmpDir: string, homeDir: string): PathMapping[] {
  const mappings: PathMapping[] = [
    { containerPath: resolveContainerWorkspace(agent), hostPath: cwd },
    { containerPath: "/tmp", hostPath: tmpDir },
    { containerPath: containerHome, hostPath: homeDir },
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
    const realRoot = resolveRealPath(normalizedRoot);
    // macOS exposes /var through the /private/var symlink. Filesystem APIs may
    // return either spelling, so accept the canonical spelling lexically while
    // still requiring the resolved target to remain inside the resolved root.
    const lexicallyInside = isInsideRoot(normalizedRoot, normalizedPath) || isInsideRoot(realRoot, normalizedPath);
    if (lexicallyInside && isInsideRoot(realRoot, realPath)) return;
  }
  throw new FileError("permission_denied", `Path is outside the agent working directory: ${displayPath}`, absolutePath);
}

function isInsideRoot(root: string, target: string) {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
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
  const message = errorMessage(error);
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
