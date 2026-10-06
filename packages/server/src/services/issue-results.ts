import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { IssueResultSnapshot } from "@carmel-agent/shared";
import type { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import { readAgentSecretEnv } from "./agent-secrets.ts";
import { createSecretRedactor } from "../runtime/sandbox/redaction.ts";

type FileVersion = { hash: string; text: string | null };
export type WorkspaceCapture = {
  files: Map<string, FileVersion>;
  complete: boolean;
  warning?: string;
};
const ignored =
  /^(?:\.git|node_modules|\.cache|\.ssh|\.aws|\.env(?:\..*)?|.*\.(?:pem|key|p12)|credentials|secrets)$/i;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Bounded workspace reads. Symlinks and credentials are never followed or retained. */
export async function captureIssueWorkspace(
  agent: typeof agents.$inferSelect,
): Promise<WorkspaceCapture> {
  const capture: WorkspaceCapture = { files: new Map(), complete: true };
  if (!agent.permissions.read)
    return {
      ...capture,
      complete: false,
      warning: "File capture requires the agent's read permission.",
    };
  const env = new AgentExecutionEnv(agent);
  let secrets: ReturnType<typeof readAgentSecretEnv>;
  try {
    secrets = readAgentSecretEnv(agent.id);
  } catch {
    return {
      ...capture,
      complete: false,
      warning: "File capture skipped because secret redaction is unavailable.",
    };
  }
  let bytes = 0;
  let visited = 0;
  const deadline = Date.now() + 5000;
  const warn = (incomplete = true) => {
    if (incomplete) capture.complete = false;
    capture.warning =
      "File capture is partial: unreadable, binary, large, or excluded files are not included.";
  };
  async function walk(path: string, depth: number) {
    if (depth > 12 || visited >= MAX_FILES || Date.now() > deadline) {
      warn();
      return;
    }
    try {
      for (const entry of await readdir(env.resolveBrowserPath(path), {
        withFileTypes: true,
      })) {
        if (ignored.test(entry.name)) continue;
        if (++visited > MAX_FILES || Date.now() > deadline) {
          warn();
          return;
        }
        const file = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          warn();
          continue;
        }
        if (entry.isDirectory()) {
          await walk(file, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const authorized = env.resolveBrowserPath(file);
        if (relative(env.hostCwd, authorized).startsWith("..")) continue;
        const handle = await open(
          authorized,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          if (
            stat.size > MAX_FILE_BYTES ||
            bytes + stat.size > MAX_TOTAL_BYTES
          ) {
            warn();
            continue;
          }
          // Read at most the budget even if a file grows after stat().
          const buffer = Buffer.alloc(
            Math.min(MAX_FILE_BYTES + 1, stat.size + 1),
          );
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_FILE_BYTES) {
            warn();
            continue;
          }
          const afterRead = await handle.stat();
          if (
            bytesRead !== stat.size ||
            afterRead.mtimeMs !== stat.mtimeMs ||
            afterRead.size !== stat.size
          ) {
            warn();
            continue;
          }
          const content = buffer.subarray(0, bytesRead);
          bytes += bytesRead;
          const redactor = createSecretRedactor(secrets);
          const text = content.includes(0)
            ? null
            : redactor.push(content.toString("utf8")) + redactor.flush();
          if (text === null) warn(false);
          capture.files.set(file, {
            hash: createHash("sha256").update(content).digest("hex"),
            text,
          });
        } finally {
          await handle.close();
        }
      }
    } catch {
      warn();
    }
  }
  await walk("", 0);
  return capture;
}

export function compareIssueWorkspace(
  before: WorkspaceCapture,
  after: WorkspaceCapture,
): IssueResultSnapshot {
  const files: IssueResultSnapshot["files"] = [];
  for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
    const old = before.files.get(path);
    const next = after.files.get(path);
    if (old?.hash === next?.hash) continue;
    // Partial inventories cannot safely identify a missing file as deleted.
    if ((!next && !after.complete) || (!old && !before.complete)) continue;
    files.push({
      path,
      change: !old ? "added" : !next ? "deleted" : "modified",
      before: old?.text ?? null,
      after: next?.text ?? null,
      ...((old && old.text === null) || (next && next.text === null)
        ? { omitted: true }
        : {}),
    });
  }
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    capturedAt: Date.now(),
    warning: after.warning ?? before.warning,
  };
}
