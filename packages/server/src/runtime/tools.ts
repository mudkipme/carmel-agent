import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { agents } from "../db/schema.ts";
import { resolveAgentReadableRoots, resolveAgentWorkingDirPath } from "./resources.ts";

type AgentRecord = typeof agents.$inferSelect;
type ToolArgs = Record<string, unknown> | undefined;
type ServerToolDefinition =
  | ReturnType<typeof createReadToolDefinition>
  | ReturnType<typeof createGrepToolDefinition>
  | ReturnType<typeof createFindToolDefinition>
  | ReturnType<typeof createLsToolDefinition>
  | ReturnType<typeof createWriteToolDefinition>
  | ReturnType<typeof createEditToolDefinition>
  | ReturnType<typeof createBashToolDefinition>;

export function createServerToolDefinitions(agent: AgentRecord) {
  const cwd = resolveWorkingDir(agent);
  const readableRoots = resolveAgentReadableRoots(agent, cwd);
  const tools: ServerToolDefinition[] = [];

  if (agent.permissions.read) {
    tools.push(
      guardToolPath(createReadToolDefinition(cwd), { readRoots: readableRoots, writeRoots: [cwd] }),
      guardToolPath(createGrepToolDefinition(cwd), { readRoots: readableRoots, writeRoots: [cwd] }),
      guardToolPath(createFindToolDefinition(cwd), { readRoots: readableRoots, writeRoots: [cwd] }),
      guardToolPath(createLsToolDefinition(cwd), { readRoots: readableRoots, writeRoots: [cwd] }),
    );
  }
  if (agent.permissions.write) {
    tools.push(guardToolPath(createWriteToolDefinition(cwd), { readRoots: readableRoots, writeRoots: [cwd] }));
  }
  if (agent.permissions.edit) {
    tools.push(guardToolPath(createEditToolDefinition(cwd), { readRoots: readableRoots, writeRoots: [cwd] }));
  }
  if (agent.permissions.bash) tools.push(createBashToolDefinition(cwd));

  return tools;
}

function resolveWorkingDir(agent: AgentRecord) {
  const cwd = resolveAgentWorkingDirPath(agent);
  if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
  return resolve(cwd);
}

function guardToolPath<TTool extends ServerToolDefinition>(
  tool: TTool,
  roots: { readRoots: string[]; writeRoots: string[] },
): TTool {
  const execute = tool.execute.bind(tool) as unknown as (...args: unknown[]) => unknown;
  return {
    ...tool,
    execute: ((toolCallId: unknown, params: unknown, signal: unknown, onUpdate: unknown, context: unknown) => {
      validateToolArgsPaths(tool.name, params as ToolArgs, roots);
      return execute(toolCallId, params, signal, onUpdate, context);
    }) as TTool["execute"],
  } as TTool;
}

function validateToolArgsPaths(toolName: string, args: ToolArgs, roots: { readRoots: string[]; writeRoots: string[] }) {
  if (!args) return;
  const normalized = toolName.toLowerCase();
  if (normalized === "read") {
    const filePath = args.path;
    if (typeof filePath === "string") resolveAllowedPath(filePath, roots.readRoots);
    return;
  }
  if (normalized === "write" || normalized === "edit") {
    const filePath = args.path;
    if (typeof filePath === "string") resolveAllowedPath(filePath, roots.writeRoots);
    return;
  }
  if (normalized === "grep" || normalized === "find" || normalized === "ls") {
    const searchPath = args.path;
    resolveAllowedPath(typeof searchPath === "string" && searchPath.length > 0 ? searchPath : ".", roots.readRoots);
  }
}

function resolveAllowedPath(filePath: string, roots: string[]) {
  const cleanPath = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  const primaryRoot = roots[0] ?? process.cwd();
  const absolutePath = isAbsolute(cleanPath) ? resolve(cleanPath) : resolve(primaryRoot, cleanPath);
  return assertInsideAllowedRoots(absolutePath, roots, filePath);
}

function assertInsideAllowedRoots(absolutePath: string, roots: string[], displayPath = absolutePath) {
  const normalizedPath = resolve(absolutePath);
  for (const root of roots) {
    const normalizedRoot = resolve(root);
    const relativePath = relative(normalizedRoot, normalizedPath);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
      return normalizedPath;
    }
  }
  throw new Error(`Path is outside the agent working directory: ${displayPath}`);
}
