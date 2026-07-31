import type {
  GrepOperations,
  LsOperations,
} from "@earendil-works/pi-coding-agent";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-agent-core";

export function createGrepOperations(env: ExecutionEnv): GrepOperations {
  return {
    isDirectory: async (absolutePath) => (await followedFileInfo(env, absolutePath)).kind === "directory",
    readFile: async (absolutePath) => getOrThrow(await env.readTextFile(absolutePath)),
  };
}

export function createLsOperations(env: ExecutionEnv): LsOperations {
  return {
    exists: async (absolutePath) => getOrThrow(await env.exists(absolutePath)),
    stat: async (absolutePath) => {
      const info = await followedFileInfo(env, absolutePath);
      return { isDirectory: () => info.kind === "directory" };
    },
    readdir: async (absolutePath) => {
      const entries = getOrThrow(await env.listDir(absolutePath));
      return entries.map((entry) => entry.name);
    },
  };
}

async function followedFileInfo(env: ExecutionEnv, path: string): Promise<FileInfo> {
  const canonicalPath = getOrThrow(await env.canonicalPath(path));
  return getOrThrow(await env.fileInfo(canonicalPath));
}
