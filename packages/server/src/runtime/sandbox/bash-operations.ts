import type { agents } from "../../db/schema.ts";
import { readAgentSecretEnv } from "../../services/agent-secrets.ts";
import { containerHome, ensureAgentContainer, killAgentContainer, toContainerWorkdir } from "./container-manager.ts";
import { execInContainer, isSandboxConfigured, sandboxUnavailableMessage } from "./podman.ts";
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
      { cmd, workingDir, env: sandboxEnv(options.env, secrets) },
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
// Agent secrets are applied last, so a caller-supplied `env` cannot shadow a
// configured credential with a value of its own choosing.
export function sandboxEnv(overrides?: Record<string, string>, secrets: ReadonlyArray<{ name: string; value: string }> = []) {
  const values = new Map([
    ["HOME", containerHome],
    ["PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    ["TERM", "xterm-256color"],
    ["LANG", "C.UTF-8"],
  ]);
  const assign = (name: string, value: string) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !value.includes("\0")) values.set(name, value);
  };
  for (const [name, value] of Object.entries(overrides ?? {})) assign(name, value);
  for (const secret of secrets) assign(secret.name, secret.value);
  return [...values].map(([name, value]) => `${name}=${value}`);
}
