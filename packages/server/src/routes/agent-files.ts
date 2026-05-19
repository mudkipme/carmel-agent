import { Hono, type Context } from "hono";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentFileContent, AgentFileEntry, AgentFileList } from "@carmel-agent/shared";
import { agents } from "../db/schema.ts";
import type { AuthVariables } from "../auth.ts";
import { ensureDir } from "../paths.ts";
import { resolveAgentWorkingDirPath } from "../runtime/resources.ts";

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
      const root = ensureWorkingDir(agent);
      const directoryPath = resolveAgentFilePath(root, c.req.query("path") ?? "");
      const directoryStat = await stat(directoryPath);
      if (!directoryStat.isDirectory()) return c.json({ error: "Path is not a directory." }, 400);

      const showHidden = c.req.query("showHidden") === "true";
      const entries = await readDirectoryEntries(root, directoryPath, showHidden);
      return c.json({ path: toRelativePath(root, directoryPath), entries } satisfies AgentFileList);
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.get("/:id/files/content", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.read) return c.json({ error: "Read permission is disabled for this agent." }, 403);

    try {
      const root = ensureWorkingDir(agent);
      const filePath = resolveAgentFilePath(root, c.req.query("path") ?? "");
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return c.json({ error: "Path is not a file." }, 400);
      if (fileStat.size > MAX_TEXT_FILE_BYTES) return c.json({ error: "File is too large to edit." }, 413);

      const content = await readTextFile(filePath);
      return c.json({
        path: toRelativePath(root, filePath),
        content,
        updatedAt: fileStat.mtimeMs,
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
      const root = ensureWorkingDir(agent);
      const filePath = resolveAgentFilePath(root, c.req.query("path") ?? "");
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return c.json({ error: "Path is not a file." }, 400);
      if (fileStat.size > MAX_IMAGE_FILE_BYTES) return c.json({ error: "File is too large to preview." }, 413);

      const contentType = imageContentType(filePath);
      if (!contentType) return c.json({ error: "File is not a supported image." }, 415);

      return c.body(new Uint8Array(await readFile(filePath)), 200, {
        "content-type": contentType,
        "cache-control": "no-store",
      });
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.put("/:id/files/content", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write && !agent.permissions.edit) {
      return c.json({ error: "Write permission is disabled for this agent." }, 403);
    }

    const body = (await c.req.json()) as { path?: string; content?: string };
    if (!body.path || typeof body.content !== "string") return c.json({ error: "Path and content are required." }, 400);

    try {
      const root = ensureWorkingDir(agent);
      const filePath = resolveAgentFilePath(root, body.path);
      await writeFile(filePath, body.content, "utf-8");
      const fileStat = await stat(filePath);
      return c.json({
        path: toRelativePath(root, filePath),
        content: body.content,
        updatedAt: fileStat.mtimeMs,
      } satisfies AgentFileContent);
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.post("/:id/files", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write) return c.json({ error: "Write permission is disabled for this agent." }, 403);

    const body = (await c.req.json()) as { path?: string; type?: "file" | "directory" };
    if (!body.path || (body.type !== "file" && body.type !== "directory")) {
      return c.json({ error: "Path and type are required." }, 400);
    }

    try {
      const root = ensureWorkingDir(agent);
      const targetPath = resolveAgentFilePath(root, body.path);
      await assertDoesNotExist(targetPath);
      if (body.type === "directory") {
        await mkdir(targetPath, { recursive: false });
      } else {
        await writeFile(targetPath, "", { encoding: "utf-8", flag: "wx" });
      }
      return c.json(await toFileEntry(root, targetPath), 201);
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.patch("/:id/files", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write && !agent.permissions.edit) {
      return c.json({ error: "Write permission is disabled for this agent." }, 403);
    }

    const body = (await c.req.json()) as { path?: string; newPath?: string };
    if (!body.path || !body.newPath) return c.json({ error: "Path and newPath are required." }, 400);

    try {
      const root = ensureWorkingDir(agent);
      const currentPath = resolveAgentFilePath(root, body.path);
      const nextPath = resolveAgentFilePath(root, body.newPath);
      await assertDoesNotExist(nextPath);
      await rename(currentPath, nextPath);
      return c.json(await toFileEntry(root, nextPath));
    } catch (error) {
      return fileError(c, error);
    }
  });

  route.delete("/:id/files", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.write) return c.json({ error: "Write permission is disabled for this agent." }, 403);

    try {
      const root = ensureWorkingDir(agent);
      const targetPath = resolveAgentFilePath(root, c.req.query("path") ?? "");
      if (targetPath === root) return c.json({ error: "The working directory cannot be deleted." }, 400);
      await rm(targetPath, { recursive: true });
      return c.json({ ok: true });
    } catch (error) {
      return fileError(c, error);
    }
  });

  return route;
}

function ensureWorkingDir(agent: AgentRecord) {
  const root = resolve(resolveAgentWorkingDirPath(agent));
  ensureDir(root);
  return root;
}

function resolveAgentFilePath(root: string, relativePath: string) {
  const cleanPath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed.");
  const absolutePath = resolve(root, cleanPath || ".");
  const relativeToRoot = relative(root, absolutePath);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error("Path is outside the agent working directory.");
  }
  return absolutePath;
}

async function readDirectoryEntries(root: string, directoryPath: string, showHidden: boolean) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const visibleEntries = showHidden ? entries : entries.filter((entry) => !entry.name.startsWith("."));
  const fileEntries = await Promise.all(
    visibleEntries.map((entry) => toFileEntry(root, resolve(directoryPath, entry.name))),
  );
  return fileEntries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

async function toFileEntry(root: string, filePath: string): Promise<AgentFileEntry> {
  const fileStat = await stat(filePath);
  return {
    name: basename(filePath),
    path: toRelativePath(root, filePath),
    type: fileStat.isDirectory() ? "directory" : "file",
    size: fileStat.isFile() ? fileStat.size : undefined,
    updatedAt: fileStat.mtimeMs,
    hidden: basename(filePath).startsWith("."),
  };
}

function toRelativePath(root: string, filePath: string) {
  return relative(root, filePath).replaceAll("\\", "/");
}

async function readTextFile(filePath: string) {
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) throw new Error("Binary files cannot be edited.");
  return buffer.toString("utf-8");
}

function imageContentType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "";
  }
}

async function assertDoesNotExist(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    return;
  }
  throw new Error("Path already exists.");
}

function fileError(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("outside the agent working directory")
    ? 400
    : message.includes("not found") || message.includes("ENOENT")
      ? 404
      : message.includes("already exists") || message.includes("EEXIST")
        ? 409
        : message.includes("too large")
          ? 413
          : 400;
  return c.json({ error: message }, status);
}
