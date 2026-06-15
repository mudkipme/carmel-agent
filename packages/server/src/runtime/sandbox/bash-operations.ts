import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { agents } from "../../db/schema.ts";
import { ensureAgentContainer, killAgentContainer, toContainerWorkdir } from "./container-manager.ts";
import { execInContainer, isSandboxConfigured, sandboxUnavailableMessage } from "./podman.ts";

type AgentRecord = typeof agents.$inferSelect;

// A deliberately minimal environment. We never forward the host process env
// (which the SDK passes by default) into the container, so provider keys, the
// secret key, and other server secrets cannot leak into agent bash sessions.
const sandboxEnv = [
  "HOME=/workspace",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "TERM=xterm-256color",
  "LANG=C.UTF-8",
];

export function createSandboxBashOperations(agent: AgentRecord): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (!isSandboxConfigured()) {
        if (allowInsecureFallback()) {
          return createLocalBashOperations().exec(command, cwd, { onData, signal, timeout });
        }
        throw new Error(sandboxUnavailableMessage());
      }

      const containerId = await ensureAgentContainer(agent, { network: agent.permissions.network });
      const workingDir = toContainerWorkdir(agent, cwd);
      const hasTimeout = typeof timeout === "number" && timeout > 0;
      const cmd = hasTimeout
        ? ["timeout", "--signal=KILL", String(Math.ceil(timeout)), "bash", "-lc", command]
        : ["bash", "-lc", command];

      let timedOut = false;
      let backstop: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => void killAgentContainer(agent.id);
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        if (hasTimeout) {
          // Backstop in case coreutils `timeout` is missing from the image.
          backstop = setTimeout(
            () => {
              timedOut = true;
              void killAgentContainer(agent.id);
            },
            (timeout + 5) * 1000,
          );
        }

        const { exitCode } = await execInContainer(
          containerId,
          { cmd, workingDir, env: sandboxEnv },
          { onData, signal },
        );

        // GNU `timeout` reports 124 on TERM and 137 (128+9) when it had to KILL.
        if (hasTimeout && (timedOut || exitCode === 124 || exitCode === 137)) {
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode };
      } finally {
        if (backstop) clearTimeout(backstop);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function allowInsecureFallback() {
  return process.env.CARMEL_BASH_ALLOW_INSECURE === "true";
}
