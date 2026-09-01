import { rmSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type { AgentMount } from "@carmel-agent/shared";
import { agents } from "../../db/schema.ts";
import { agentHomeDir, agentTmpDir, dataDir, ensureDir, resolveDataPath } from "../../paths.ts";
import { resolveAgentWorkingDirPath } from "../resources.ts";
import {
  createContainer,
  imageExists,
  isContainerRunning,
  isSandboxConfigured,
  listManagedContainers,
  pullImage,
  removeContainer,
  sandboxUnavailableMessage,
  startContainer,
} from "./podman.ts";
import { errorMessage } from "../../errors.ts";

type AgentRecord = typeof agents.$inferSelect;

const managedLabel = "carmel.managed";
const managedLabelValue = "1";
const agentLabel = "carmel.agent";
const containerWorkspace = "/workspace";
// $HOME inside the runner. A fixed path (not the workspace mount) so tool state
// stays out of the user's project files; see resolveAgentHomeDirPath.
export const containerHome = "/home/agent";
const reaperIntervalMs = 60_000;

const config = {
  image: process.env.CARMEL_BASH_IMAGE?.trim() || "localhost/carmel-agent-runner:latest",
  memoryBytes: positiveInt(process.env.CARMEL_BASH_MEMORY_MB, 512) * 1024 * 1024,
  nanoCpus: Math.round(positiveFloat(process.env.CARMEL_BASH_CPUS, 1) * 1e9),
  pidsLimit: positiveInt(process.env.CARMEL_BASH_PIDS_LIMIT, 512),
  idleTtlMs: positiveInt(process.env.CARMEL_BASH_IDLE_MINUTES, 15) * 60_000,
  // CDI device ids to attach to runner containers, e.g. "nvidia.com/gpu=all".
  gpuDevices: parseCsv(process.env.CARMEL_BASH_GPU),
  // SELinux relabeling (:z) is required for bind mounts on enforcing hosts.
  selinuxRelabel: process.env.CARMEL_BASH_SELINUX_RELABEL !== "false",
};

type ContainerEntry = { containerId: string; lastUsedAt: number; signature: string };

const containers = new Map<string, ContainerEntry>();
// Agents with something attached that the idle reaper must not interrupt --
// today, open terminal sessions. Counted rather than boolean: two browser tabs
// on the same shell are two holds, and the last one to leave releases it.
const containerHolds = new Map<string, number>();
const pendingStarts = new Map<string, Promise<string>>();
let imageReady: Promise<void> | undefined;
let reaper: ReturnType<typeof setInterval> | undefined;

export async function ensureAgentContainer(agent: AgentRecord, options: { network: boolean }): Promise<string> {
  if (!isSandboxConfigured()) throw new Error(sandboxUnavailableMessage());

  const signature = containerSignature(agent, options);
  const existing = containers.get(agent.id);
  if (existing) {
    // Reuse only if the bind configuration still matches; recreate when the
    // workspace dir or extra mounts changed so stale binds are not kept.
    if (existing.signature === signature && (await isContainerRunning(existing.containerId))) {
      existing.lastUsedAt = Date.now();
      return existing.containerId;
    }
    containers.delete(agent.id);
    await removeContainer(existing.containerId);
  }

  let pending = pendingStarts.get(agent.id);
  if (!pending) {
    pending = createAgentContainer(agent, options).finally(() => pendingStarts.delete(agent.id));
    pendingStarts.set(agent.id, pending);
  }
  const containerId = await pending;
  containers.set(agent.id, { containerId, lastUsedAt: Date.now(), signature });
  startReaper();
  return containerId;
}

// Identifies the bind-relevant inputs of a runner container. When this changes
// for an agent (workspace dir, mount path, extra mounts, network), the existing
// container is torn down and recreated on the next command.
export function containerSignature(agent: AgentRecord, options: { network: boolean }) {
  const workspaceHostPath = toHostPath(resolveAgentWorkingDirPath(agent));
  const tmpHostPath = toHostPath(resolveAgentTmpDirPath(agent));
  const homeHostPath = toHostPath(resolveAgentHomeDirPath(agent));
  const mountPath = resolveContainerWorkspace(agent);
  return JSON.stringify({
    binds: buildBinds(workspaceHostPath, mountPath, tmpHostPath, homeHostPath, agent.mounts),
    network: options.network,
  });
}

/**
 * Pin an agent's container against the idle reaper.
 *
 * The reaper measures idleness by `lastUsedAt`, which only moves when a command
 * is dispatched. A terminal where someone is reading rather than typing looks
 * exactly like an abandoned container, so it needs to say so explicitly.
 */
export function holdAgentContainer(agentId: string) {
  containerHolds.set(agentId, (containerHolds.get(agentId) ?? 0) + 1);
}

export function releaseAgentContainer(agentId: string) {
  const held = (containerHolds.get(agentId) ?? 0) - 1;
  if (held > 0) containerHolds.set(agentId, held);
  else containerHolds.delete(agentId);
  // Idleness is counted from the release, not from the last command: a session
  // that just ended should buy the full TTL before the container is reclaimed.
  const entry = containers.get(agentId);
  if (entry && held <= 0) entry.lastUsedAt = Date.now();
}

export function isAgentContainerHeld(agentId: string) {
  return (containerHolds.get(agentId) ?? 0) > 0;
}

// Transient teardown (abort, command timeout, config-change recreate). The
// scratch /tmp is kept so a recreated container re-mounts the same files.
export async function killAgentContainer(agentId: string) {
  const entry = containers.get(agentId);
  if (!entry) return;
  containers.delete(agentId);
  await removeContainer(entry.containerId);
}

// Permanent teardown (agent deletion): also wipe the scratch /tmp directory.
export async function discardAgentContainer(agentId: string) {
  await killAgentContainer(agentId);
  clearAgentTmp(agentId);
}

function clearAgentTmp(agentId: string) {
  try {
    rmSync(agentTmpDirPath(agentId), { recursive: true, force: true });
  } catch (error) {
    console.warn("Failed to clear agent tmp dir:", errorMessage(error));
  }
}

// Where the workspace is mounted inside the runner. Manual workspaces keep their
// absolute path so paths line up with the host and the server-side file tools;
// default per-agent workspaces use a stable /workspace mount point.
export function resolveContainerWorkspace(agent: AgentRecord) {
  if (agent.workingDirMode === "manual") return resolveAgentWorkingDirPath(agent);
  return containerWorkspace;
}

// Per-agent host directory bind-mounted at /tmp in the runner. Backing it on the
// host (rather than the container's ephemeral layer) lets the host-side file
// tools see the same /tmp the sandboxed shell writes to, while keeping it
// isolated from the host's real /tmp.
export function resolveAgentTmpDirPath(agent: AgentRecord) {
  return agentTmpDirPath(agent.id);
}

// Per-agent host directory bind-mounted at containerHome. Unlike /tmp this is
// never reclaimed by the reaper: surviving container recreation is the point,
// so a `npm install -g` or a git identity set in one session is still there in
// the next one.
export function resolveAgentHomeDirPath(agent: AgentRecord) {
  return resolveDataPath(agentHomeDir(agent.id));
}

function agentTmpDirPath(agentId: string) {
  return resolveDataPath(agentTmpDir(agentId));
}

export function toContainerWorkdir(agent: AgentRecord, cwd: string) {
  return containerWorkdir(resolveAgentWorkingDirPath(agent), cwd, resolveContainerWorkspace(agent));
}

// Maps a host-side absolute working directory onto the workspace mount point
// inside the container. Anything outside the workspace falls back to its root.
export function containerWorkdir(workspaceRoot: string, cwd: string, mountPath: string) {
  const rel = relative(resolve(workspaceRoot), resolve(cwd));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return mountPath;
  return posix.join(mountPath, rel.split(/[\\/]/).join("/"));
}

// Builds the runner bind list: the workspace, a private /tmp, a private $HOME,
// plus any per-agent extra mounts. Extra mount sources are host paths as the
// Podman daemon sees them.
export function buildBinds(
  workspaceHostPath: string,
  mountPath: string,
  tmpHostPath: string,
  homeHostPath: string,
  mounts: AgentMount[],
) {
  const relabel = config.selinuxRelabel ? ",z" : "";
  const binds = [
    `${workspaceHostPath}:${mountPath}:rw${relabel}`,
    `${tmpHostPath}:/tmp:rw${relabel}`,
    `${homeHostPath}:${containerHome}:rw${relabel}`,
  ];
  for (const mount of mounts) {
    const source = mount.source?.trim();
    if (!source) continue;
    const target = mount.target?.trim() || source;
    const mode = mount.readOnly ? "ro" : "rw";
    binds.push(`${source}:${target}:${mode}${relabel}`);
  }
  return binds;
}

export async function reapManagedContainers() {
  if (!isSandboxConfigured()) return;
  try {
    const stale = await listManagedContainers(`${managedLabel}=${managedLabelValue}`);
    await Promise.all(stale.map((container) => removeContainer(container.Id)));
  } catch (error) {
    console.warn("Failed to reap sandbox containers:", errorMessage(error));
  }
}

export async function shutdownContainerManager() {
  if (reaper) {
    clearInterval(reaper);
    reaper = undefined;
  }
  const entries = [...containers.values()];
  containers.clear();
  await Promise.all(entries.map((entry) => removeContainer(entry.containerId)));
}

async function createAgentContainer(agent: AgentRecord, options: { network: boolean }) {
  await ensureImage();

  const workspacePath = resolveAgentWorkingDirPath(agent);
  const tmpPath = resolveAgentTmpDirPath(agent);
  const homePath = resolveAgentHomeDirPath(agent);
  ensureDir(workspacePath);
  ensureDir(tmpPath);
  ensureDir(homePath);
  const mountPath = resolveContainerWorkspace(agent);
  const workspaceHostPath = toHostPath(workspacePath);
  const tmpHostPath = toHostPath(tmpPath);
  const homeHostPath = toHostPath(homePath);

  const name = `carmel-bash-${sanitizeName(agent.id)}-${Date.now().toString(36)}`;
  const containerId = await createContainer(name, {
    Image: config.image,
    Entrypoint: [],
    Cmd: ["sleep", "infinity"],
    WorkingDir: mountPath,
    Labels: { [managedLabel]: managedLabelValue, [agentLabel]: agent.id },
    Env: [`HOME=${containerHome}`, "TERM=xterm-256color"],
    HostConfig: {
      Binds: buildBinds(workspaceHostPath, mountPath, tmpHostPath, homeHostPath, agent.mounts),
      Memory: config.memoryBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: config.pidsLimit,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // No network unless the agent has the network permission. When allowed we
      // leave NetworkMode unset so rootless Podman uses its default network.
      ...(options.network ? {} : { NetworkMode: "none" }),
      // Attach CDI devices (e.g. NVIDIA GPUs) when CARMEL_BASH_GPU is set.
      ...(config.gpuDevices.length > 0
        ? { DeviceRequests: [{ Driver: "cdi", DeviceIDs: config.gpuDevices }] }
        : {}),
    },
  });
  await startContainer(containerId);
  return containerId;
}

function ensureImage() {
  if (!imageReady) {
    imageReady = (async () => {
      if (await imageExists(config.image)) return;
      // A local-only image (e.g. the default runner) cannot be pulled; point the
      // operator at the build step rather than failing with a registry error.
      if (config.image.startsWith("localhost/")) {
        throw new Error(
          `The bash sandbox image "${config.image}" is not built. Build it with ` +
            `\`podman build -f Dockerfile.runner -t carmel-agent-runner:latest .\` or set ` +
            `CARMEL_BASH_IMAGE to a pullable image.`,
        );
      }
      await pullImage(config.image);
    })().catch((error) => {
      imageReady = undefined;
      throw error;
    });
  }
  return imageReady;
}

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => void reapIdleContainers(), reaperIntervalMs);
  reaper.unref?.();
}

async function reapIdleContainers() {
  const now = Date.now();
  const stale: Array<[string, ContainerEntry]> = [];
  for (const [agentId, entry] of containers) {
    if (containerHolds.has(agentId)) continue;
    if (now - entry.lastUsedAt < config.idleTtlMs) continue;
    stale.push([agentId, entry]);
    // Drop the entry up front so it cannot be reused while removal is in flight.
    containers.delete(agentId);
  }
  await Promise.all(
    stale.map(async ([agentId, entry]) => {
      if (!(await removeContainer(entry.containerId))) {
        // Removal was not confirmed (e.g. a transient podman failure). Keep
        // tracking so the next tick retries instead of leaking an orphan —
        // unless a fresh container was started for this agent in the meantime.
        if (!containers.has(agentId)) containers.set(agentId, entry);
        return;
      }
      // An idle sandbox is done with its scratch; reclaim the /tmp directory.
      clearAgentTmp(agentId);
    }),
  );
  await reapUntrackedContainers();
}

// Safety net for orphaned runners. A teardown that lost its tracking entry
// without actually removing the container (a swallowed/transient podman failure)
// would otherwise leak the container until the next restart, since the idle
// reaper only ever inspects the in-memory map. Periodically reconcile against
// real podman state and remove any managed runner no live entry points at.
// A grace period keeps us from killing a container that is still being created
// (tracked only in pendingStarts, not yet in the map).
async function reapUntrackedContainers() {
  let managed: Awaited<ReturnType<typeof listManagedContainers>>;
  try {
    managed = await listManagedContainers(`${managedLabel}=${managedLabelValue}`);
  } catch (error) {
    console.warn("Failed to list sandbox containers:", errorMessage(error));
    return;
  }
  const tracked = new Set<string>();
  for (const entry of containers.values()) tracked.add(entry.containerId);
  const minAgeSeconds = (Date.now() - config.idleTtlMs) / 1000;
  await Promise.all(
    managed
      .filter((container) => !tracked.has(container.Id) && container.Created < minAgeSeconds)
      .map((container) => removeContainer(container.Id)),
  );
}

// When carmel-agent itself runs inside a container, a bind mount source is
// interpreted by the host Podman daemon, not by carmel's filesystem. Set
// CARMEL_HOST_DATA_DIR to the host path that backs CARMEL_AGENT_DATA_DIR so the
// workspace mount resolves correctly. When unset we assume carmel runs on the host.
function toHostPath(absolutePath: string) {
  const hostDataDir = process.env.CARMEL_HOST_DATA_DIR?.trim();
  if (!hostDataDir) return absolutePath;
  const rel = relative(dataDir, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return absolutePath;
  return posix.join(hostDataDir.replace(/\/+$/, ""), rel.split(/[\\/]/).join("/"));
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveFloat(value: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
