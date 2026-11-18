import { readEnvironmentSecretEnv } from "../../services/environment-secrets.ts";
import { resolveEnvironmentWorkingDirPath } from "../resources.ts";
import { readWorkspaceDotEnv } from "../workspace-dotenv.ts";
import {
  ensureEnvironmentContainer,
  killEnvironmentContainer,
  toContainerWorkdir,
  type EnvironmentRecord,
} from "./container-manager.ts";
import { runnerEnvironment } from "./environment.ts";
import {
  execInContainer,
  isSandboxConfigured,
  sandboxUnavailableMessage,
} from "./runtime-client.ts";
import { createSecretRedactor } from "./redaction.ts";

export type SandboxExecOptions = {
  sessionId?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  timeout?: number;
  /** Lowest precedence: the workspace `.env`, `env`, and secrets all override it. */
  defaults?: Record<string, string>;
  env?: Record<string, string>;
};

/**
 * Tags every process a command starts, so stopping it can find the whole tree
 * -- backgrounded and `nohup`ed children included -- without touching what
 * other agents sharing the runner are doing.
 */
const execMarker = "CARMEL_EXEC_ID";

// Repeated because a process can fork between one /proc scan and the next.
// Exits 1 if anything is still alive after the last pass.
const killExecScript = `for pass in 1 2 3 4 5; do
  found=
  for proc in /proc/[0-9]*; do
    if grep -qxzF "${execMarker}=$1" "$proc/environ" 2>/dev/null; then
      kill -KILL "\${proc#/proc/}" 2>/dev/null && found=1
    fi
  done
  [ -n "$found" ] || exit 0
done
exit 1`;

export async function execSandboxCommand(
  environment: EnvironmentRecord,
  command: string,
  cwd: string,
  options: SandboxExecOptions,
) {
  if (!isSandboxConfigured()) throw new Error(sandboxUnavailableMessage());
  // Read per exec rather than per container: containers are long-lived and
  // reused, so baking secrets into the container's Env at creation would both
  // pin a stale value until the reaper came round and put it in `inspect`
  // output. This way a rotated secret takes effect on the next command.
  const secrets = readEnvironmentSecretEnv(environment.id, options.sessionId);
  // Same reasoning for the workspace `.env`: editing it takes effect on the
  // next command, with no container restart.
  const dotEnv = readWorkspaceDotEnv(resolveEnvironmentWorkingDirPath(environment));
  const containerId = await ensureEnvironmentContainer(environment);
  const workingDir = toContainerWorkdir(environment, cwd);
  const execId = crypto.randomUUID();
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
  const onAbort = () => void killSandboxExec(environment.id, containerId, execId);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (hasTimeout) {
      backstop = setTimeout(
        () => {
          timedOut = true;
          void killSandboxExec(environment.id, containerId, execId);
        },
        (options.timeout! + 5) * 1000,
      );
    }

    const env = sandboxEnv({ ...options.defaults, ...dotEnv, ...options.env }, secrets).filter(
      (entry) => !entry.startsWith(`${execMarker}=`),
    );
    env.push(`${execMarker}=${execId}`);
    const { exitCode } = await execInContainer(
      containerId,
      { cmd, workingDir, env },
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

/**
 * Stop one command's processes and leave the runner alone: other agents in the
 * environment, terminals, and the browser keep running. Only if that cannot be
 * confirmed is the whole runner removed, as the last way to stop the command.
 */
async function killSandboxExec(environmentId: string, containerId: string, execId: string) {
  try {
    const { exitCode } = await execInContainer(
      containerId,
      { cmd: ["sh", "-c", killExecScript, "sh", execId], workingDir: "/", env: [] },
      { onStdout: () => {}, onStderr: () => {}, signal: AbortSignal.timeout(10_000) },
    );
    if (exitCode === 0) return;
  } catch {
    // Fall through to removing the runner.
  }
  await killEnvironmentContainer(environmentId).catch(() => {});
}

// Never inherit the server process environment into a container.
// PATH here is only a floor: commands run through `bash -lc`, and Debian's
// /etc/profile unconditionally reassigns PATH. Per-agent bin directories under
// $HOME are prepended by /etc/profile.d/carmel-home.sh in the runner image.
//
// Environment secrets are applied last, so a caller-supplied `env` -- or the
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
