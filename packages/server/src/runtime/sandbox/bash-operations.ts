import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { agents } from "../../db/schema.ts";
import { readAgentSecretEnv } from "../../services/agent-secrets.ts";
import { resolveAgentWorkingDirPath } from "../resources.ts";
import {
  ensureAgentContainer,
  killAgentContainer,
  toContainerWorkdir,
} from "./container-manager.ts";
import { runnerEnvironment } from "./environment.ts";
import {
  execInContainer,
  isSandboxConfigured,
  sandboxUnavailableMessage,
} from "./runtime-client.ts";
import { createSecretRedactor } from "./redaction.ts";

type AgentRecord = typeof agents.$inferSelect;

export type SandboxExecOptions = {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, string>;
};

export async function execSandboxCommand(
  agent: AgentRecord,
  command: string,
  cwd: string,
  options: SandboxExecOptions,
) {
  if (!isSandboxConfigured()) throw new Error(sandboxUnavailableMessage());
  // Read per exec rather than per container: containers are long-lived and
  // reused, so baking secrets into the container's Env at creation would both
  // pin a stale value until the reaper came round and put it in `inspect`
  // output. This way a rotated secret takes effect on the next command.
  const secrets = readAgentSecretEnv(agent.id);
  // Same reasoning for the workspace `.env`: editing it takes effect on the
  // next command, with no container restart.
  const dotEnv = readWorkspaceDotEnv(resolveAgentWorkingDirPath(agent));
  const containerId = await ensureAgentContainer(agent, { network: agent.permissions.network });
  const workingDir = toContainerWorkdir(agent, cwd);
  const hasTimeout = typeof options.timeout === "number" && options.timeout > 0;
  const cmd = hasTimeout
    ? ["timeout", "--signal=KILL", String(Math.ceil(options.timeout!)), "bash", "-lc", command]
    : ["bash", "-lc", command];

  // One redactor per stream: they share no ordering, and a single held-back
  // tail would interleave stdout and stderr into each other.
  const stdoutRedactor = createSecretRedactor(secrets);
  const stderrRedactor = createSecretRedactor(secrets);
  const emit = (callback: ((chunk: string) => void) | undefined, text: string) => {
    if (text) callback?.(text);
  };

  let timedOut = false;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => void killAgentContainer(agent.id);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (hasTimeout) {
      backstop = setTimeout(
        () => {
          timedOut = true;
          void killAgentContainer(agent.id);
        },
        (options.timeout! + 5) * 1000,
      );
    }

    const { exitCode } = await execInContainer(
      containerId,
      { cmd, workingDir, env: sandboxEnv({ ...dotEnv, ...options.env }, secrets) },
      {
        onStdout: (chunk) => emit(options.onStdout, stdoutRedactor.push(chunk.toString("utf8"))),
        onStderr: (chunk) => emit(options.onStderr, stderrRedactor.push(chunk.toString("utf8"))),
        signal: options.signal,
      },
    );

    if (hasTimeout && (timedOut || exitCode === 124 || exitCode === 137)) {
      throw new Error(`timeout:${options.timeout}`);
    }
    return { exitCode };
  } finally {
    if (backstop) clearTimeout(backstop);
    options.signal?.removeEventListener("abort", onAbort);
    // Always flush, including on the timeout and abort paths: whatever the
    // redactor is holding is real output the caller would otherwise never see.
    emit(options.onStdout, stdoutRedactor.flush());
    emit(options.onStderr, stderrRedactor.flush());
  }
}

// Never inherit the server process environment into a container.
// PATH here is only a floor: commands run through `bash -lc`, and Debian's
// /etc/profile unconditionally reassigns PATH. Per-agent bin directories under
// $HOME are prepended by /etc/profile.d/carmel-home.sh in the runner image.
//
// Agent secrets are applied last, so a caller-supplied `env` -- or the
// workspace `.env` folded into it -- cannot shadow a configured credential with
// a value of its own choosing.
export function sandboxEnv(
  overrides?: Record<string, string>,
  secrets: ReadonlyArray<{ name: string; value: string }> = [],
) {
  const values = new Map(Object.entries(runnerEnvironment));
  const assign = (name: string, value: string) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !value.includes("\0")) values.set(name, value);
  };
  for (const [name, value] of Object.entries(overrides ?? {})) assign(name, value);
  for (const secret of secrets) assign(secret.name, secret.value);
  return [...values].map(([name, value]) => `${name}=${value}`);
}

const maxDotEnvBytes = 1024 * 1024;

/**
 * Variables from `.env` at the root of the agent's working directory, or none.
 *
 * The file is read on the host, from a directory the agent itself can write, so
 * it is untrusted: a `.env` symlinked at the server's own `.env` would otherwise
 * copy host credentials into the container. `O_NOFOLLOW` refuses the link, the
 * regular-file check refuses a FIFO that would block the read, and both hold on
 * the opened descriptor rather than a path that could be swapped in between.
 * An unreadable file is skipped: a broken `.env` must not take bash down with it.
 */
export function readWorkspaceDotEnv(workingDir: string): Record<string, string> {
  let fd: number;
  try {
    fd = openSync(
      join(workingDir, ".env"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return {};
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxDotEnvBytes) return {};
    return parseEnv(readFileSync(fd, "utf8")) as Record<string, string>;
  } catch {
    return {};
  } finally {
    closeSync(fd);
  }
}
