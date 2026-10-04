import type { Duplex } from "node:stream";
import type { agents } from "../../db/schema.ts";
import { readAgentSecretEnv } from "../../services/agent-secrets.ts";
import { sandboxEnv } from "./bash-operations.ts";
import { resolveAgentWorkingDirPath } from "../resources.ts";
import {
  ensureAgentContainer,
  holdAgentContainer,
  releaseAgentContainer,
  toContainerWorkdir,
} from "./container-manager.ts";
import { attachExecTty, isSandboxConfigured, resizeExec, sandboxUnavailableMessage } from "./runtime-client.ts";
import { errorMessage } from "../../errors.ts";

type AgentRecord = typeof agents.$inferSelect;

/**
 * Interactive shells attached to agent runner containers.
 *
 * A session outlives the browser tab that opened it, the same way an agent run
 * does: a reload reattaches to the shell that is already there and replays what
 * it missed, instead of dropping the user into a fresh prompt half way through
 * whatever they were doing.
 *
 * Sessions are keyed by agent and user rather than by a random id the client
 * has to keep. Terminals are owner-only, so that key identifies exactly one
 * shell per agent, and reattaching needs nothing but the agent id -- which the
 * client already has. Two tabs on the same agent share one shell, like two
 * windows on one tmux session.
 */

/** Replayed to a reattaching client. Enough for a screen or two of scrollback. */
const maxBufferBytes = 256 * 1024;
/** How long a shell with nobody attached is kept before it is killed. */
const graceMs = 2 * 60_000;
const sweepIntervalMs = 30_000;

type Subscriber = {
  onData: (chunk: string) => void;
  onClose: (reason: string) => void;
};

type TerminalSession = {
  agentId: string;
  userId: string;
  execId: string;
  socket: Duplex;
  buffer: Buffer;
  subscribers: Set<Subscriber>;
  detachedAt: number | undefined;
  closing: boolean;
};

export type TerminalHandle = {
  write: (data: string) => void;
  resize: (rows: number, cols: number) => void;
  detach: () => void;
};

const sessions = new Map<string, TerminalSession>();
let sweeper: ReturnType<typeof setInterval> | undefined;

const sessionKey = (agentId: string, userId: string) => `${agentId}\0${userId}`;

/**
 * Attach to this user's shell on this agent, starting one if none is running.
 *
 * The returned handle is per-subscriber: detaching drops this client, but leaves
 * the shell running for the grace period so a reload can pick it back up.
 */
export async function attachTerminal(
  agent: AgentRecord,
  userId: string,
  subscriber: Subscriber,
  size: { rows: number; cols: number },
): Promise<TerminalHandle> {
  if (!isSandboxConfigured()) throw new Error(sandboxUnavailableMessage());
  if (!agent.permissions.bash) throw new Error("Bash permission is disabled for this agent.");

  const key = sessionKey(agent.id, userId);
  const session = sessions.get(key) ?? (await startSession(agent, userId, key, size));

  session.subscribers.add(subscriber);
  session.detachedAt = undefined;
  // Replay before any new output can arrive, so the client sees the scrollback
  // in order rather than interleaved with whatever lands next.
  if (session.buffer.length > 0) subscriber.onData(session.buffer.toString("utf8"));
  // The newest client's viewport wins: it is the one a person is looking at.
  void resizeExec(session.execId, size.rows, size.cols);

  return {
    write: (data) => {
      if (!session.closing) session.socket.write(data);
    },
    resize: (rows, cols) => {
      if (!session.closing) void resizeExec(session.execId, rows, cols);
    },
    detach: () => {
      session.subscribers.delete(subscriber);
      if (session.subscribers.size === 0) session.detachedAt = Date.now();
    },
  };
}

/** Terminals on an agent that is being deleted or reconfigured out from under them. */
export function closeAgentTerminals(agentId: string, reason = "The agent was changed.") {
  for (const [key, session] of sessions) {
    if (session.agentId === agentId) closeSession(key, session, reason);
  }
}

export function shutdownTerminals() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
  for (const [key, session] of sessions) closeSession(key, session, "The server is shutting down.");
}

async function startSession(
  agent: AgentRecord,
  userId: string,
  key: string,
  size: { rows: number; cols: number },
): Promise<TerminalSession> {
  const containerId = await ensureAgentContainer(agent, { network: agent.permissions.network });
  const workingDir = toContainerWorkdir(agent, resolveAgentWorkingDirPath(agent));
  // The same environment the agent's own commands get, secrets included: a
  // terminal that cannot reproduce the agent's environment cannot be used to
  // debug it. Output is not redacted here -- nothing is persisted to a
  // transcript or sent to a model, and rewriting a live PTY stream would
  // corrupt the escape sequences the emulator depends on.
  const env = sandboxEnv(undefined, readAgentSecretEnv(agent.id));

  const { execId, socket } = await attachExecTty(containerId, {
    cmd: ["bash", "-l"],
    workingDir,
    env,
  });

  const session: TerminalSession = {
    agentId: agent.id,
    userId,
    execId,
    socket,
    buffer: Buffer.alloc(0),
    subscribers: new Set(),
    detachedAt: undefined,
    closing: false,
  };
  sessions.set(key, session);
  holdAgentContainer(agent.id);
  startSweeper();

  socket.on("data", (chunk: Buffer) => {
    session.buffer = trimBuffer(Buffer.concat([session.buffer, chunk]));
    const text = chunk.toString("utf8");
    for (const subscriber of session.subscribers) subscriber.onData(text);
  });
  socket.on("close", () => closeSession(key, session, "The shell exited."));
  socket.on("error", (error) => closeSession(key, session, errorMessage(error)));

  // Podman rejects a resize before the exec is running, so the initial size is
  // applied once the attach has completed rather than at exec creation.
  void resizeExec(execId, size.rows, size.cols);
  return session;
}

function closeSession(key: string, session: TerminalSession, reason: string) {
  if (session.closing) return;
  session.closing = true;
  sessions.delete(key);
  releaseAgentContainer(session.agentId);
  for (const subscriber of session.subscribers) subscriber.onClose(reason);
  session.subscribers.clear();
  session.socket.destroy();
}

/**
 * Keep the tail, not the head: on reattach the last screenful is what matters,
 * and a cut mid-escape-sequence at the start is a garbled first line at worst.
 */
function trimBuffer(buffer: Buffer) {
  return buffer.length <= maxBufferBytes ? buffer : buffer.subarray(buffer.length - maxBufferBytes);
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (session.subscribers.size > 0 || session.detachedAt === undefined) continue;
      if (now - session.detachedAt >= graceMs) closeSession(key, session, "The terminal timed out.");
    }
  }, sweepIntervalMs);
  sweeper.unref?.();
}
