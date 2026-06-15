import { isAbsolute, posix, relative, resolve } from "node:path";
import type { AgentMount } from "@carmel-agent/shared";
import { agents } from "../../db/schema.ts";
import { dataDir, ensureDir } from "../../paths.ts";
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

type AgentRecord = typeof agents.$inferSelect;

const managedLabel = "carmel.managed";
const managedLabelValue = "1";
const agentLabel = "carmel.agent";
const containerWorkspace = "/workspace";
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

type ContainerEntry = { containerId: string; lastUsedAt: number };

const containers = new Map<string, ContainerEntry>();
const pendingStarts = new Map<string, Promise<string>>();
let imageReady: Promise<void> | undefined;
let reaper: ReturnType<typeof setInterval> | undefined;

export async function ensureAgentContainer(agent: AgentRecord, options: { network: boolean }): Promise<string> {
  if (!isSandboxConfigured()) throw new Error(sandboxUnavailableMessage());

  const existing = containers.get(agent.id);
  if (existing && (await isContainerRunning(existing.containerId))) {
    existing.lastUsedAt = Date.now();
    return existing.containerId;
  }
  if (existing) containers.delete(agent.id);

  let pending = pendingStarts.get(agent.id);
  if (!pending) {
    pending = createAgentContainer(agent, options).finally(() => pendingStarts.delete(agent.id));
    pendingStarts.set(agent.id, pending);
  }
  const containerId = await pending;
  containers.set(agent.id, { containerId, lastUsedAt: Date.now() });
  startReaper();
  return containerId;
}

export async function killAgentContainer(agentId: string) {
  const entry = containers.get(agentId);
  if (!entry) return;
  containers.delete(agentId);
  await removeContainer(entry.containerId);
}

// Where the workspace is mounted inside the runner. Manual workspaces keep their
// absolute path so paths line up with the host and the server-side file tools;
// default per-agent workspaces use a stable /workspace mount point.
export function resolveContainerWorkspace(agent: AgentRecord) {
  if (agent.workingDirMode === "manual") return resolveAgentWorkingDirPath(agent);
  return containerWorkspace;
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

// Builds the runner bind list: the workspace plus any per-agent extra mounts.
// Extra mount sources are host paths as the Podman daemon sees them.
export function buildBinds(workspaceHostPath: string, mountPath: string, mounts: AgentMount[]) {
  const relabel = config.selinuxRelabel ? ",z" : "";
  const binds = [`${workspaceHostPath}:${mountPath}:rw${relabel}`];
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
    console.warn("Failed to reap sandbox containers:", error instanceof Error ? error.message : String(error));
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
  ensureDir(workspacePath);
  const mountPath = resolveContainerWorkspace(agent);
  const workspaceHostPath = toHostPath(workspacePath);

  const name = `carmel-bash-${sanitizeName(agent.id)}-${Date.now().toString(36)}`;
  const containerId = await createContainer(name, {
    Image: config.image,
    Entrypoint: [],
    Cmd: ["sleep", "infinity"],
    WorkingDir: mountPath,
    Labels: { [managedLabel]: managedLabelValue, [agentLabel]: agent.id },
    Env: [`HOME=${mountPath}`, "TERM=xterm-256color"],
    HostConfig: {
      Binds: buildBinds(workspaceHostPath, mountPath, agent.mounts),
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
  const stale: ContainerEntry[] = [];
  for (const [agentId, entry] of containers) {
    if (now - entry.lastUsedAt < config.idleTtlMs) continue;
    stale.push(entry);
    containers.delete(agentId);
  }
  await Promise.all(stale.map((entry) => removeContainer(entry.containerId)));
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
