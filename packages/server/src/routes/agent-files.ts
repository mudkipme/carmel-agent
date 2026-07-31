import { Hono, type Context } from "hono";
import { extname } from "node:path";
import type { AgentFileContent, AgentFileEntry, AgentFileList } from "@carmel-agent/shared";
import { FileError, type Result } from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import type { AuthVariables } from "../auth.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import {
  createFileEntryRequestSchema,
  fileContentRequestSchema,
  jsonValidator,
  renameFileEntryRequestSchema,
} from "../validation.ts";

type AgentRecord = typeof agents.$inferSelect;
type ReadVisibleAgent = (userId: string, agentId: string) => AgentRecord | undefined;

const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;

export function createAgentFilesRoute(readVisibleAgent: ReadVisibleAgent) {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/:id/files", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.read) return c.json({ error: "Read permission is disabled for this agent." }, 403);

    try {
      const env = new AgentExecutionEnv(agent);
      const directoryPath = env.resolveBrowserPath(c.req.query("path") ?? "", "read");
      const directory = unwrap(await env.fileInfo(directoryPath));
      if (directory.kind !== "directory") return c.json({ error: "Path is not a directory." }, 400);
      const entries = await readDirectoryEntries(env, directoryPath, c.req.query("showHidden") === "true");
      return c.json({ path: env.toWorkspaceRelativePath(directoryPath), entries } satisfies AgentFileList);
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.get("/:id/files/content", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.read) return c.json({ error: "Read permission is disabled for this agent." }, 403);

    try {
      const env = new AgentExecutionEnv(agent);
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
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.get("/:id/files/raw", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.read) return c.json({ error: "Read permission is disabled for this agent." }, 403);

    try {
      const env = new AgentExecutionEnv(agent);
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
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.put("/:id/files/content", jsonValidator(fileContentRequestSchema), async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write && !agent.permissions.edit) {
      return c.json({ error: "Write permission is disabled for this agent." }, 403);
    }
    const body = c.req.valid("json");
    if (!body.path || typeof body.content !== "string") return c.json({ error: "Path and content are required." }, 400);

    try {
      const env = new AgentExecutionEnv(agent);
      const filePath = env.resolveBrowserPath(body.path, "write");
      unwrap(await env.writeFile(filePath, body.content));
      const file = unwrap(await env.fileInfo(filePath));
      return c.json({
        path: env.toWorkspaceRelativePath(filePath),
        content: body.content,
        updatedAt: file.mtimeMs,
      } satisfies AgentFileContent);
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.post("/:id/files", jsonValidator(createFileEntryRequestSchema), async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write) return c.json({ error: "Write permission is disabled for this agent." }, 403);
    const body = c.req.valid("json");
    if (!body.path || (body.type !== "file" && body.type !== "directory")) {
      return c.json({ error: "Path and type are required." }, 400);
    }

    try {
      const env = new AgentExecutionEnv(agent);
      const targetPath = env.resolveBrowserPath(body.path, "write");
      const exists = unwrap(await env.exists(targetPath));
      if (exists) return c.json({ error: "Path already exists." }, 409);
      if (body.type === "directory") {
        unwrap(await env.createDir(targetPath, { recursive: false }));
      } else {
        unwrap(await env.createFileExclusive(body.path, true));
      }
      return c.json(await toFileEntry(env, targetPath), 201);
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.patch("/:id/files", jsonValidator(renameFileEntryRequestSchema), async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write && !agent.permissions.edit) {
      return c.json({ error: "Write permission is disabled for this agent." }, 403);
    }
    const body = c.req.valid("json");
    if (!body.path || !body.newPath) return c.json({ error: "Path and newPath are required." }, 400);

    try {
      const env = new AgentExecutionEnv(agent);
      const nextPath = env.resolveBrowserPath(body.newPath, "write");
      if (unwrap(await env.exists(nextPath))) return c.json({ error: "Path already exists." }, 409);
      unwrap(await env.rename(body.path, body.newPath, true));
      return c.json(await toFileEntry(env, nextPath));
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.delete("/:id/files", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write) return c.json({ error: "Write permission is disabled for this agent." }, 403);

    try {
      const env = new AgentExecutionEnv(agent);
      const targetPath = env.resolveBrowserPath(c.req.query("path") ?? "", "write");
      if (targetPath === env.cwd) return c.json({ error: "The working directory cannot be deleted." }, 400);
      unwrap(await env.remove(targetPath, { recursive: true }));
      return c.json({ ok: true });
    } catch (error) {
      return fileError(c, error);
    }
  });

  return route;
}

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
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof FileError ? error.code : undefined;
  const status = code === "permission_denied"
    ? 400
    : code === "not_found" || message.includes("ENOENT")
      ? 404
      : message.includes("already exists") || message.includes("EEXIST")
        ? 409
        : code === "invalid"
          ? 400
          : 500;
  return c.json({ error: message }, status);
}
