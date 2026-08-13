import type { agents } from "../../db/schema.ts";
import { containerHome, ensureAgentContainer, killAgentContainer, toContainerWorkdir } from "./container-manager.ts";
import { execInContainer, isSandboxConfigured, sandboxUnavailableMessage } from "./podman.ts";

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
  const containerId = await ensureAgentContainer(agent, { network: agent.permissions.network });
  const workingDir = toContainerWorkdir(agent, cwd);
  const hasTimeout = typeof options.timeout === "number" && options.timeout > 0;
  const cmd = hasTimeout
    ? ["timeout", "--signal=KILL", String(Math.ceil(options.timeout!)), "bash", "-lc", command]
    : ["bash", "-lc", command];

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
      { cmd, workingDir, env: sandboxEnv(options.env) },
      {
        onStdout: (chunk) => options.onStdout?.(chunk.toString("utf8")),
        onStderr: (chunk) => options.onStderr?.(chunk.toString("utf8")),
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
  }
}

// Never inherit the server process environment into a container.
// PATH here is only a floor: commands run through `bash -lc`, and Debian's
// /etc/profile unconditionally reassigns PATH. Per-agent bin directories under
// $HOME are prepended by /etc/profile.d/carmel-home.sh in the runner image.
function sandboxEnv(overrides?: Record<string, string>) {
  const values = new Map([
    ["HOME", containerHome],
    ["PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    ["TERM", "xterm-256color"],
    ["LANG", "C.UTF-8"],
  ]);
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !value.includes("\0")) values.set(name, value);
  }
  return [...values].map(([name, value]) => `${name}=${value}`);
}
