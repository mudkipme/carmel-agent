import { Hono, type Context, type Next } from "hono";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, rename as renameFile, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AgentFileBatchCommand,
  AgentFileBatchResult,
  AgentFileContent,
  AgentFileEntry,
  AgentFileList,
  AgentPermissions,
} from "@carmel-agent/shared";
import { FileError, type Result } from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import type { AuthVariables } from "../auth.ts";
import { errorMessage } from "../errors.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import { zipArchive, type ZipEntry } from "../runtime/zip.ts";
import {
  createFileEntryRequestSchema,
  fileBatchRequestSchema,
  fileContentRequestSchema,
  jsonValidator,
  renameFileEntryRequestSchema,
} from "../validation.ts";

type AgentRecord = typeof agents.$inferSelect;
type ReadVisibleAgent = (userId: string, agentId: string) => AgentRecord | undefined;

// Every file route runs against one visible agent's execution environment, so
// agent lookup, env lifecycle, and FileError -> HTTP status mapping live in one
// middleware rather than being repeated in each handler.
type AgentFilesVariables = AuthVariables & {
  agent: AgentRecord;
  agentEnv: AgentExecutionEnv;
};
type AgentFilesEnv = { Variables: AgentFilesVariables };

const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
// The archive writer has no zip64 support, so an oversized download is refused
// before it starts rather than streaming an archive extractors would reject.
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;

export function createAgentFilesRoute(readVisibleAgent: ReadVisibleAgent) {
  const route = new Hono<AgentFilesEnv>();

  // Scoped to this sub-app, so filesystem failures map to a status once instead
  // of in every handler. Hono's `route()` preserves a sub-app's own onError.
  route.onError((error, c) => fileError(c, error));
  route.use("/:id/files", agentFileContext(readVisibleAgent));
  route.use("/:id/files/*", agentFileContext(readVisibleAgent));

  route.get("/:id/files", requireRead, async (c) => {
    const env = c.get("agentEnv");
    const directoryPath = env.resolveBrowserPath(c.req.query("path") ?? "", "read");
    const directory = unwrap(await env.fileInfo(directoryPath));
    if (directory.kind !== "directory") return c.json({ error: "Path is not a directory." }, 400);
    const entries = await readDirectoryEntries(env, directoryPath, c.req.query("showHidden") === "true");
    return c.json({ path: env.toWorkspaceRelativePath(directoryPath), entries } satisfies AgentFileList);
  });

  route.get("/:id/files/content", requireRead, async (c) => {
    const env = c.get("agentEnv");
    const filePath = env.resolveBrowserPath(c.req.query("path") ?? "", "read");
    const file = unwrap(await env.fileInfo(filePath));
    if (file.kind !== "file") return c.json({ error: "Path is not a file." }, 400);
    if (file.size > MAX_TEXT_FILE_BYTES) return c.json({ error: "File is too large to edit." }, 413);
    const bytes = unwrap(await env.readBinaryFile(filePath));
    if (bytes.includes(0)) throw new FileError("invalid", "Binary files cannot be edited.", filePath);
    return c.json({
      path: env.toWorkspaceRelativePath(filePath),
      content: new TextDecoder().decode(bytes),
      updatedAt: file.mtimeMs,
    } satisfies AgentFileContent);
  });

  route.get("/:id/files/raw", requireRead, async (c) => {
    const env = c.get("agentEnv");
    const filePath = env.resolveBrowserPath(c.req.query("path") ?? "", "read");
    const file = unwrap(await env.fileInfo(filePath));
    if (file.kind !== "file") return c.json({ error: "Path is not a file." }, 400);
    if (file.size > MAX_IMAGE_FILE_BYTES) return c.json({ error: "File is too large to preview." }, 413);
    const contentType = imageContentType(filePath);
    if (!contentType) return c.json({ error: "File is not a supported image." }, 415);
    return c.body(unwrap(await env.readBinaryFile(filePath)).buffer as ArrayBuffer, 200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
  });

  route.put("/:id/files/content", requireWriteOrEdit, jsonValidator(fileContentRequestSchema), async (c) => {
    const body = c.req.valid("json");
    if (!body.path || typeof body.content !== "string") return c.json({ error: "Path and content are required." }, 400);

    const env = c.get("agentEnv");
    const filePath = env.resolveBrowserPath(body.path, "write");
    unwrap(await env.writeFile(filePath, body.content));
    const file = unwrap(await env.fileInfo(filePath));
    return c.json({
      path: env.toWorkspaceRelativePath(filePath),
      content: body.content,
      updatedAt: file.mtimeMs,
    } satisfies AgentFileContent);
  });

  route.post("/:id/files", requireWrite, jsonValidator(createFileEntryRequestSchema), async (c) => {
    const body = c.req.valid("json");
    if (!body.path || (body.type !== "file" && body.type !== "directory")) {
      return c.json({ error: "Path and type are required." }, 400);
    }

    const env = c.get("agentEnv");
    const targetPath = env.resolveBrowserPath(body.path, "write");
    if (unwrap(await env.exists(targetPath))) return c.json({ error: "Path already exists." }, 409);
    if (body.type === "directory") {
      unwrap(await env.createDir(targetPath, { recursive: false }));
    } else {
      unwrap(await env.createFileExclusive(body.path, true));
    }
    return c.json(await toFileEntry(env, targetPath), 201);
  });

  route.patch("/:id/files", requireWriteOrEdit, jsonValidator(renameFileEntryRequestSchema), async (c) => {
    const body = c.req.valid("json");
    if (!body.path || !body.newPath) return c.json({ error: "Path and newPath are required." }, 400);

    const env = c.get("agentEnv");
    const nextPath = env.resolveBrowserPath(body.newPath, "write");
    if (unwrap(await env.exists(nextPath))) return c.json({ error: "Path already exists." }, 409);
    unwrap(await env.rename(body.path, body.newPath, true));
    return c.json(await toFileEntry(env, nextPath));
  });

  route.delete("/:id/files", requireWrite, async (c) => {
    const env = c.get("agentEnv");
    const targetPath = env.resolveBrowserPath(c.req.query("path") ?? "", "write");
    if (targetPath === env.cwd) return c.json({ error: "The working directory cannot be deleted." }, 400);
    unwrap(await env.remove(targetPath, { recursive: true }));
    return c.json({ ok: true });
  });

  // One endpoint for every download shape the file manager offers: a single
  // file streams as-is, anything else (a folder, a multi-select) streams as a
  // zip built on the fly.
  route.get("/:id/files/download", requireRead, async (c) => {
    const env = c.get("agentEnv");
    const requested = (c.req.queries("path") ?? []).map((path) => path.trim()).filter(Boolean);
    if (requested.length === 0) return c.json({ error: "At least one path is required." }, 400);

    const targets = [];
    for (const path of requested) {
      const absolutePath = env.resolveBrowserPath(path, "read");
      targets.push({ absolutePath, info: unwrap(await env.fileInfo(absolutePath)) });
    }

    const single = targets.length === 1 ? targets[0] : undefined;
    if (single && single.info.kind === "file") {
      return c.body(toWebStream(createReadStream(single.absolutePath)), 200, {
        "content-type": "application/octet-stream",
        "content-length": String(single.info.size),
        "content-disposition": contentDisposition(basename(single.absolutePath)),
        "cache-control": "no-store",
      });
    }

    const entries = await collectArchiveEntries(env, targets.map((target) => target.absolutePath));
    const archiveName = single ? `${single.absolutePath === env.cwd ? "workspace" : basename(single.absolutePath)}.zip` : "files.zip";
    return c.body(toWebStream(Readable.from(zipArchive(entries))), 200, {
      "content-type": "application/zip",
      "content-disposition": contentDisposition(archiveName),
      "cache-control": "no-store",
    });
  });

  // Raw body rather than multipart: the browser uploads one file per request,
  // which keeps large files off the server heap and gives the client a real
  // per-file progress bar.
  route.put("/:id/files/upload", requireWrite, async (c) => {
    const requestedPath = (c.req.query("path") ?? "").trim();
    if (!requestedPath || requestedPath.endsWith("/")) return c.json({ error: "A file path is required." }, 400);
    const declaredSize = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
      return c.json({ error: "File is too large to upload." }, 413);
    }

    const env = c.get("agentEnv");
    const targetPath = env.resolveBrowserPath(requestedPath, "write");
    if (targetPath === env.cwd) return c.json({ error: "A file path is required." }, 400);
    if (unwrap(await env.exists(targetPath))) {
      if (c.req.query("overwrite") !== "true") return c.json({ error: "Path already exists." }, 409);
      if (unwrap(await env.fileInfo(targetPath)).kind !== "file") return c.json({ error: "Path is not a file." }, 400);
    }

    // Folder uploads arrive as files carrying their relative path, so the
    // directories on the way to one are created as needed.
    await mkdir(env.resolveBrowserPath(dirname(requestedPath), "write"), { recursive: true });
    await streamUpload(c.req.raw.body, targetPath);
    return c.json(await toFileEntry(env, targetPath), 201);
  });

  // Batch delete / cut-paste / copy-paste. Each path is attempted on its own so
  // one failure inside a selection does not strand the rest.
  route.post("/:id/files/batch", requireWrite, jsonValidator(fileBatchRequestSchema), async (c) => {
    const { operation, paths, destination } = c.req.valid("json");
    const env = c.get("agentEnv");
    const destinationPath = operation === "delete" ? "" : env.resolveBrowserPath(destination ?? "", "write");
    if (destinationPath && unwrap(await env.fileInfo(destinationPath)).kind !== "directory") {
      return c.json({ error: "Destination is not a directory." }, 400);
    }

    const result: AgentFileBatchResult = { completed: [], failed: [] };
    for (const path of paths) {
      try {
        await applyBatchOperation(env, operation, path, destinationPath);
        result.completed.push(path);
      } catch (error) {
        result.failed.push({ path, error: errorMessage(error) });
      }
    }
    return c.json(result satisfies AgentFileBatchResult);
  });

  return route;
}

/**
 * Walk the selection into a flat entry list before a byte is streamed: the
 * archive format cannot express a mid-stream failure, so limits are enforced
 * and unreadable entries dropped up front.
 */
async function collectArchiveEntries(env: AgentExecutionEnv, roots: string[]) {
  const entries: ZipEntry[] = [];
  const visitedDirectories = new Set<string>();
  let totalBytes = 0;

  const visit = async (absolutePath: string, archiveName: string) => {
    const info = unwrap(await env.fileInfo(absolutePath));
    if (entries.length >= MAX_ARCHIVE_ENTRIES) {
      throw new FileError("invalid", "Too many files to download at once.", archiveName);
    }
    if (info.kind !== "directory") {
      totalBytes += info.size;
      if (totalBytes > MAX_ARCHIVE_BYTES) {
        throw new FileError("invalid", "Selection is too large to download.", archiveName);
      }
      entries.push({ name: archiveName, mtimeMs: info.mtimeMs, open: () => createReadStream(absolutePath) });
      return;
    }
    // Symlinked directories can point back at an ancestor; the canonical path
    // keeps such a loop from expanding forever.
    const canonical = unwrap(await env.canonicalPath(absolutePath));
    if (visitedDirectories.has(canonical)) return;
    visitedDirectories.add(canonical);
    if (archiveName) entries.push({ name: archiveName, mtimeMs: info.mtimeMs });
    for (const child of unwrap(await env.listDir(absolutePath))) {
      try {
        // Anything that resolves outside the workspace throws here and is left
        // out, exactly as it is left out of a directory listing.
        const childPath = env.resolveBrowserPath(env.toWorkspaceRelativePath(child.path), "read");
        await visit(childPath, archiveName ? `${archiveName}/${child.name}` : child.name);
      } catch (error) {
        if (error instanceof FileError && error.code === "permission_denied") continue;
        throw error;
      }
    }
  };

  for (const root of roots) await visit(root, root === env.cwd ? "" : basename(root));
  return entries;
}

/**
 * Upload beside the target and rename into place, so a dropped connection
 * leaves the existing file untouched instead of half-overwritten.
 */
async function streamUpload(body: ReadableStream<Uint8Array> | null, targetPath: string) {
  const pendingPath = `${targetPath}.upload-${Math.random().toString(36).slice(2, 10)}`;
  let received = 0;
  const limited = async function* () {
    if (!body) return;
    for await (const chunk of Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])) {
      received += (chunk as Uint8Array).length;
      if (received > MAX_UPLOAD_BYTES) throw new FileError("invalid", "File is too large to upload.", targetPath);
      yield chunk as Uint8Array;
    }
  };
  try {
    await pipeline(Readable.from(limited()), createWriteStream(pendingPath));
    await renameFile(pendingPath, targetPath);
  } catch (error) {
    await rm(pendingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function applyBatchOperation(
  env: AgentExecutionEnv,
  operation: AgentFileBatchCommand["operation"],
  path: string,
  destinationPath: string,
) {
  const sourcePath = env.resolveBrowserPath(path, "write");
  const name = basename(sourcePath);
  if (sourcePath === env.cwd) throw new FileError("invalid", "The working directory cannot be moved or deleted.", path);
  if (operation === "delete") {
    unwrap(await env.remove(sourcePath, { recursive: true }));
    return;
  }

  if (isInsidePath(sourcePath, destinationPath)) {
    throw new FileError("invalid", `“${name}” cannot be placed inside itself.`, path);
  }
  const destinationRelative = env.toWorkspaceRelativePath(destinationPath);
  const targetPath = env.resolveBrowserPath([destinationRelative, name].filter(Boolean).join("/"), "write");
  if (targetPath === sourcePath) throw new FileError("invalid", `“${name}” is already here.`, path);
  if (unwrap(await env.exists(targetPath))) throw new FileError("invalid", `“${name}” already exists here.`, path);

  if (operation === "move") await renameFile(sourcePath, targetPath);
  // Symlinks are copied as symlinks: following them would pull content from
  // outside the workspace into it.
  else await cp(sourcePath, targetPath, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
}

function isInsidePath(root: string, target: string) {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function toWebStream(stream: Readable) {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/** RFC 6266 disposition: an ASCII fallback plus the real UTF-8 name. */
function contentDisposition(name: string) {
  const fallback = name.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll(/["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Resolve the `:id` agent, open its execution environment for the handler, and
 * always release it afterwards. Failures are mapped to a status by `onError`.
 */
function agentFileContext(readVisibleAgent: ReadVisibleAgent) {
  return async (c: Context<AgentFilesEnv>, next: Next) => {
    const agentId = c.req.param("id");
    const agent = agentId ? readVisibleAgent(c.get("user").id, agentId) : undefined;
    if (!agent) return c.json({ error: "Agent not found." }, 404);

    const env = new AgentExecutionEnv(agent);
    c.set("agent", agent);
    c.set("agentEnv", env);
    try {
      await next();
    } finally {
      await env.cleanup().catch(() => undefined);
    }
  };
}

function requirePermission(allowed: (permissions: AgentPermissions) => boolean, message: string) {
  return async (c: Context<AgentFilesEnv>, next: Next) => {
    if (!allowed(c.get("agent").permissions)) return c.json({ error: message }, 403);
    await next();
  };
}

const requireRead = requirePermission(
  (permissions) => permissions.read,
  "Read permission is disabled for this agent.",
);
const requireWrite = requirePermission(
  (permissions) => permissions.write,
  "Write permission is disabled for this agent.",
);
// Editing an existing file is allowed with either permission; creating or
// deleting one still requires `write`.
const requireWriteOrEdit = requirePermission(
  (permissions) => permissions.write || permissions.edit,
  "Write permission is disabled for this agent.",
);

async function readDirectoryEntries(env: AgentExecutionEnv, directoryPath: string, showHidden: boolean) {
  const children = unwrap(await env.listDir(directoryPath));
  const visible = showHidden ? children : children.filter((entry) => !entry.name.startsWith("."));
  const entries = await Promise.all(
    visible.map(async (entry) => {
      try {
        return await toFileEntry(env, entry.path, entry.name);
      } catch {
        return undefined;
      }
    }),
  );
  return entries.filter((entry): entry is AgentFileEntry => Boolean(entry)).sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

async function toFileEntry(env: AgentExecutionEnv, path: string, displayName?: string): Promise<AgentFileEntry> {
  const canonicalPath = unwrap(await env.canonicalPath(path));
  const info = unwrap(await env.fileInfo(canonicalPath));
  return {
    name: displayName ?? info.name,
    path: env.toWorkspaceRelativePath(path),
    type: info.kind === "directory" ? "directory" : "file",
    size: info.kind === "file" ? info.size : undefined,
    updatedAt: info.mtimeMs,
    hidden: (displayName ?? info.name).startsWith("."),
  };
}

function unwrap<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function imageContentType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng": return "image/apng";
    case ".avif": return "image/avif";
    case ".gif": return "image/gif";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    default: return "";
  }
}

function fileError(c: Context, error: unknown) {
  const message = errorMessage(error);
  const code = error instanceof FileError ? error.code : undefined;
  const status = code === "permission_denied"
    ? 400
    : code === "not_found" || message.includes("ENOENT")
      ? 404
      : message.includes("already exists") || message.includes("EEXIST")
        ? 409
        : code === "invalid" || message.includes("ENOTDIR") || message.includes("EISDIR")
          ? 400
          : 500;
  return c.json({ error: message }, status);
}
